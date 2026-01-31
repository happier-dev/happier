#!/usr/bin/env node
/**
 * link-dev.cjs - Create symlink for happier-dev only
 *
 * This script creates a symlink for the happier-dev command pointing to the local
 * development version, while leaving the stable npm version of `happier` untouched.
 *
 * Usage: yarn link:dev
 *
 * What it does:
 * 1. Finds the global npm bin directory
 * 2. Creates/updates a symlink: happier-dev -> ./bin/happier-dev.mjs
 *
 * To undo: yarn unlink:dev
 */

const { execFileSync } = require('child_process');
const { join, dirname } = require('path');
const fs = require('fs');

const projectRoot = dirname(__dirname);
const binSource = join(projectRoot, 'bin', 'happier-dev.mjs');

// Get the action from command line args
const action = process.argv[2] || 'link';
const targetBins = ['happier-dev', 'happy-dev'];

function getGlobalBinDir() {
    // Try npm global bin first using execFileSync (safer than execSync)
    try {
        const npmBin = execFileSync('npm', ['bin', '-g'], { encoding: 'utf8' }).trim();
        if (fs.existsSync(npmBin)) {
            return npmBin;
        }
    } catch (e) {
        // Fall through to alternatives
    }

    // Common locations by platform
    if (process.platform === 'darwin') {
        // macOS with Homebrew Node (Apple Silicon)
        const homebrewBin = '/opt/homebrew/bin';
        if (fs.existsSync(homebrewBin)) {
            return homebrewBin;
        }
        // Intel Mac Homebrew
        const homebrewUsrBin = '/usr/local/bin';
        if (fs.existsSync(homebrewUsrBin)) {
            return homebrewUsrBin;
        }
    }

    // Fallback to /usr/local/bin
    return '/usr/local/bin';
}

function link() {
    const globalBin = getGlobalBinDir();
    const primaryBinTarget = join(globalBin, 'happier-dev');

    console.log('Creating symlink for happier-dev...');
    console.log(`  Source: ${binSource}`);
    console.log(`  Target: ${primaryBinTarget}`);

    // Check if source exists
    if (!fs.existsSync(binSource)) {
        console.error(`\n❌ Error: ${binSource} does not exist.`);
        console.error("   Run 'yarn build' first to compile the project.");
        process.exit(1);
    }

    try {
        for (const binName of targetBins) {
            const binTarget = join(globalBin, binName);
            try {
                const stat = fs.lstatSync(binTarget);
                if (stat.isSymbolicLink() || stat.isFile()) {
                    fs.unlinkSync(binTarget);
                }
            } catch (e) {
                // File doesn't exist, that's fine
            }

            fs.symlinkSync(binSource, binTarget);
        }

        console.log('\n✅ Successfully linked happier-dev to local development version');
        console.log('\nNow you can use:');
        console.log('  happier      → stable npm version (unchanged)');
        console.log('  happier-dev  → local development version');
        console.log('  happy-dev    → local development version (legacy alias)');
        console.log('\nTo undo: yarn unlink:dev');
    } catch (e) {
        if (e.code === 'EACCES') {
            console.error('\n❌ Permission denied. Try running with sudo:');
            console.error('   sudo yarn link:dev');
        } else {
            console.error(`\n❌ Error creating symlink: ${e.message}`);
        }
        process.exit(1);
    }
}

function unlink() {
    const globalBin = getGlobalBinDir();

    console.log('Removing happier-dev symlink...');

    for (const binName of targetBins) {
        const binTarget = join(globalBin, binName);
        try {
            const stat = fs.lstatSync(binTarget);
            if (stat.isSymbolicLink()) {
                const linkTarget = fs.readlinkSync(binTarget);
                if (linkTarget === binSource || linkTarget.includes('happy-cli') || linkTarget.includes('@happier-dev/cli')) {
                    fs.unlinkSync(binTarget);
                }
            }
        } catch (e) {
            // ignore
        }
    }

    console.log('\n✅ Removed happier-dev development symlink(s)');
    console.log('\nTo restore npm version: npm install -g @happier-dev/cli');
}

// Main
if (action === 'unlink') {
    unlink();
} else {
    link();
}
