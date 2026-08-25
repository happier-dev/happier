const { execFile } = require('node:child_process');
const { withDangerousMod } = require('@expo/config-plugins');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function resolveTerminalNativeGhosttyKitMaterializer({
    projectRoot,
    nodePath = process.execPath,
    requireResolve = require.resolve,
}) {
    const terminalNativePackageJson = requireResolve('@happier-dev/terminal-native/package.json', {
        paths: [projectRoot],
    });
    return {
        command: nodePath,
        args: [path.join(path.dirname(terminalNativePackageJson), 'scripts', 'buildGhosttyKitIos.mjs')],
    };
}

async function materializeTerminalNativeGhosttyKit({
    projectRoot,
    execFileAsync: run = execFileAsync,
    resolveMaterializer = resolveTerminalNativeGhosttyKitMaterializer,
}) {
    const invocation = resolveMaterializer({ projectRoot });
    await run(invocation.command, invocation.args, {
        cwd: projectRoot,
        env: process.env,
        maxBuffer: 1024 * 1024,
    });
}

const withTerminalNativeGhosttyKit = (config) => withDangerousMod(config, ['ios', async (modConfig) => {
    await materializeTerminalNativeGhosttyKit({
        projectRoot: modConfig.modRequest.projectRoot ?? process.cwd(),
    });
    return modConfig;
}]);

withTerminalNativeGhosttyKit.resolveTerminalNativeGhosttyKitMaterializer = resolveTerminalNativeGhosttyKitMaterializer;
withTerminalNativeGhosttyKit.materializeTerminalNativeGhosttyKit = materializeTerminalNativeGhosttyKit;

module.exports = withTerminalNativeGhosttyKit;
