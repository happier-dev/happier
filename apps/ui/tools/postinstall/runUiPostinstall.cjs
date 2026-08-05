'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const nodeModulesPathPattern = /(^|[\\/])node_modules([\\/]|$)/i;

function resolvePhysicalWorkingDirectory({ cwd, realpathSync = fs.realpathSync }) {
    try {
        return realpathSync(cwd);
    } catch {
        return cwd;
    }
}

function isInstalledPackageContext({ cwd, realpathSync = fs.realpathSync }) {
    const physicalCwd = resolvePhysicalWorkingDirectory({ cwd, realpathSync });
    return nodeModulesPathPattern.test(physicalCwd);
}

function runUiPostinstall({
    cwd = process.cwd(),
    env = process.env,
    execPath = process.execPath,
    platform = process.platform,
    realpathSync = fs.realpathSync,
    spawnSync = childProcess.spawnSync,
} = {}) {
    if (isInstalledPackageContext({ cwd, realpathSync })) return 0;

    const physicalCwd = resolvePhysicalWorkingDirectory({ cwd, realpathSync });
    const gatePath = path.resolve(physicalCwd, '../../scripts/postinstall/shouldRunPostinstall.cjs');
    try {
        const gate = require(gatePath);
        if (!gate.shouldRunPostinstall({ workspace: 'ui', scope: env.HAPPIER_INSTALL_SCOPE || '' })) return 0;
    } catch {
        // The repository gate is absent when the app package is consumed outside this monorepo.
    }

    if (!fs.existsSync(path.resolve(physicalCwd, 'tools', 'postinstall.mjs'))) return 0;

    const run = (command, args) => spawnSync(command, args, {
        cwd: physicalCwd,
        env,
        stdio: 'inherit',
    });
    const npmExecPath = env.npm_execpath;
    let result;
    if (npmExecPath) {
        result = run(execPath, [npmExecPath, 'run', '-s', 'postinstall:real']);
    } else {
        result = run(platform === 'win32' ? 'yarn.cmd' : 'yarn', ['-s', 'postinstall:real']);
        if (result.error && platform === 'win32') {
            result = run('yarn', ['-s', 'postinstall:real']);
        }
    }

    if (result.error) {
        console.error(result.error.message);
        return 1;
    }
    return result.status ?? 1;
}

if (require.main === module) {
    process.exitCode = runUiPostinstall();
}

module.exports = {
    isInstalledPackageContext,
    runUiPostinstall,
};
