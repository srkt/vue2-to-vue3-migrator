#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const path = require('path');
const fs = require('fs');
const { globSync } = require('glob');
const inquirer = require('inquirer');
const { transformComponent } = require('../src/transformer');

const pkg = require('../package.json');

// — Banner —————————————————————–

function printBanner() {
  console.log(chalk.cyan(
    '+------------------------------------------------------+\n' +
    `|        Vue 2 → Vue 3 Migration Tool  v${pkg.version}         |\n` +
    '|   Class Components → Composition API (TypeScript)    |\n' +
    '+------------------------------------------------------+'
  ));
}

// — File helpers ————————————————————

function backupFile(filePath) {
  const backupPath = filePath + '.vue2.bak';
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function processFile(filePath, options) {
  const source = fs.readFileSync(filePath, 'utf-8');

  if (!source.includes('vue-class-component') && !source.includes('vue-property-decorator') && !source.includes('extends Vue')) {
    return { skipped: true, reason: 'Not a class component' };
  }

  const { output, warnings } = transformComponent(source, path.basename(filePath));

  if (!options.dryRun) {
    if (options.backup) backupFile(filePath);
    fs.writeFileSync(filePath, output, 'utf-8');
  }

  return { skipped: false, output, warnings };
}

// — Commands ––––––––––––––––––––––––––––––––

// – migrate all –––––––––––––––––––––––––––––––
program
  .command('all <dir>')
  .description('Migrate all .vue files in a directory (recursively)')
  .option('--dry-run', 'Preview changes without writing files')
  .option('--no-backup', 'Skip creating .vue2.bak backup files')
  .option('--pattern <glob>', 'Custom glob pattern', '**/*.vue')
  .action(async (dir, options) => {
    printBanner();

    const absDir = path.resolve(dir);
    if (!fs.existsSync(absDir)) {
      console.error(chalk.red(`[ERR] Directory not found: ${absDir}`));
      process.exit(1);
    }

    const files = globSync(options.pattern, { cwd: absDir, absolute: true });
    if (!files.length) {
      console.log(chalk.yellow('No .vue files found.'));
      return;
    }

    console.log(chalk.bold(`Found ${files.length} .vue file(s) in ${absDir}\n`));

    if (options.dryRun) {
      console.log(chalk.bgYellow.black(' DRY RUN — no files will be modified \n'));
    }

    if (!options.dryRun && options.backup !== false) {
      console.log(chalk.gray('Backups will be saved as <file>.vue2.bak\n'));
    }

    const results = { migrated: 0, skipped: 0, errors: 0 };
    const allWarnings = [];

    const spinner = ora('Processing files...').start();

    for (const file of files) {
      const rel = path.relative(absDir, file);
      try {
        const result = processFile(file, options);
        if (result.skipped) {
          results.skipped++;
          spinner.text = chalk.gray(`Skipped: ${rel}`);
        } else {
          results.migrated++;
          spinner.text = chalk.green(`Migrated: ${rel}`);
          if (result.warnings.length) {
            allWarnings.push({ file: rel, warnings: result.warnings });
          }
        }
      } catch (err) {
        results.errors++;
        allWarnings.push({ file: rel, warnings: [`ERROR: ${err.message}`] });
      }
    }

    spinner.succeed('Done!\n');

    console.log(chalk.bold('--- Summary -------------------------------------'));
    console.log(chalk.green(`  [OK] Migrated : ${results.migrated}`));
    console.log(chalk.gray(`  [-] Skipped  : ${results.skipped}`));
    if (results.errors) console.log(chalk.red(`  [ERR] Errors   : ${results.errors}`));
    console.log('');

    if (allWarnings.length) {
      console.log(chalk.yellow('--- Warnings / Manual Review Needed -------------'));
      for (const { file, warnings } of allWarnings) {
        console.log(chalk.bold(`  ${file}`));
        for (const w of warnings) {
          console.log(chalk.yellow(`    [!] ${w}`));
        }
      }
      console.log('');
    }

    if (options.dryRun) {
      console.log(chalk.cyan('Run without --dry-run to apply changes.'));
    }
  });

// – migrate one –––––––––––––––––––––––––––––––
program
  .command('file <filepath>')
  .description('Migrate a single .vue file')
  .option('--dry-run', 'Preview the transformed output without writing')
  .option('--no-backup', 'Skip creating a .vue2.bak backup file')
  .option('--print', 'Print the migrated output to stdout')
  .action((filepath, options) => {
    printBanner();

    const absPath = path.resolve(filepath);
    if (!fs.existsSync(absPath)) {
      console.error(chalk.red(`[ERR] File not found: ${absPath}`));
      process.exit(1);
    }

    console.log(chalk.bold(`Migrating: ${absPath}\n`));

    if (options.dryRun) {
      console.log(chalk.bgYellow.black(' DRY RUN — file will NOT be modified \n'));
    }

    try {
      const result = processFile(absPath, options);

      if (result.skipped) {
        console.log(chalk.yellow(`[-] Skipped: ${result.reason}`));
        return;
      }

      if (options.print || options.dryRun) {
        console.log(chalk.bold('--- Transformed Output --------------------------'));
        console.log(result.output);
        console.log(chalk.bold('-------------------------------------------------\n'));
      }

      if (!options.dryRun) {
        console.log(chalk.green('[OK] File migrated successfully!'));
        if (options.backup !== false) {
          console.log(chalk.gray(`  Backup saved as: ${absPath}.vue2.bak`));
        }
      }

      if (result.warnings.length) {
        console.log(chalk.yellow('\n[!] Warnings — manual review recommended:'));
        for (const w of result.warnings) {
          console.log(chalk.yellow(`  • ${w}`));
        }
      }
    } catch (err) {
      console.error(chalk.red(`[ERR] Error: ${err.message}`));
      process.exit(1);
    }
  });

// – interactive –––––––––––––––––––––––––––––––
program
  .command('interactive')
  .alias('i')
  .description('Step through files one by one with prompts')
  .option('--dir <dir>', 'Directory to scan', '.')
  .option('--no-backup', 'Skip backups')
  .action(async (options) => {
    printBanner();

    const absDir = path.resolve(options.dir);
    const files = globSync('**/*.vue', { cwd: absDir, absolute: true });
    const classComponents = files.filter(f => {
      const src = fs.readFileSync(f, 'utf-8');
      return src.includes('vue-class-component') || src.includes('vue-property-decorator') || src.includes('extends Vue');
    });

    if (!classComponents.length) {
      console.log(chalk.yellow('No class component .vue files found.'));
      return;
    }

    console.log(chalk.bold(`Found ${classComponents.length} class component(s) to migrate.\n`));

    let migrated = 0, skipped = 0;

    for (const file of classComponents) {
      const rel = path.relative(absDir, file);
      console.log(chalk.bold(`\nFile: ${chalk.cyan(rel)}`));

      const { action } = await inquirer.prompt([{
        type: 'list',
        name: 'action',
        message: 'What do you want to do?',
        choices: [
          { name: '[OK] Migrate this file', value: 'migrate' },
          { name: '👁  Preview (dry run)', value: 'preview' },
          { name: '[-] Skip', value: 'skip' },
          { name: '[ERR] Quit', value: 'quit' },
        ]
      }]);

      if (action === 'quit') break;
      if (action === 'skip') { skipped++; continue; }

      if (action === 'preview') {
        const result = processFile(file, { dryRun: true, backup: false });
        console.log('\n' + chalk.dim('-'.repeat(60)));
        console.log(result.output);
        console.log(chalk.dim('-'.repeat(60)) + '\n');

        const { confirm } = await inquirer.prompt([{
          type: 'confirm', name: 'confirm', message: 'Apply this migration?', default: true
        }]);
        if (!confirm) { skipped++; continue; }
      }

      try {
        processFile(file, { dryRun: false, backup: options.backup !== false });
        console.log(chalk.green('  [OK] Migrated!'));
        migrated++;
      } catch (err) {
        console.log(chalk.red(`  [ERR] Error: ${err.message}`));
      }
    }

    console.log(chalk.bold(`\nDone! Migrated: ${migrated}, Skipped: ${skipped}`));
  });

// – preview —————————————————————––
program
  .command('preview <filepath>')
  .description('Print the migrated output for a file without changing it')
  .action((filepath) => {
    const absPath = path.resolve(filepath);
    if (!fs.existsSync(absPath)) {
      console.error(chalk.red(`[ERR] File not found: ${absPath}`));
      process.exit(1);
    }
    const source = fs.readFileSync(absPath, 'utf-8');
    const { output, warnings } = transformComponent(source, path.basename(absPath));
    console.log(output);
    if (warnings.length) {
      process.stderr.write(chalk.yellow('\n[!] Warnings:\n' + warnings.map(w => `  • ${w}`).join('\n') + '\n'));
    }
  });

program
  .name('vue-migrate')
  .description('Migrate Vue 2 class components to Vue 3 Composition API')
  .version(pkg.version)
  .parse(process.argv);
