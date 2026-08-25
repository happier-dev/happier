const { execFile } = require('node:child_process');
const path = require('node:path');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');
const { withDangerousMod: expoWithDangerousMod } = require('@expo/config-plugins');

const execFileAsync = promisify(execFile);
const appConfigRequire = createRequire(__filename);

function resolveTerminalNativeBuildInputMaterializer({
    projectRoot,
    platform,
    nodePath = process.execPath,
    requireResolve = appConfigRequire.resolve,
}) {
    const terminalNativePackageJson = requireResolve('@happier-dev/terminal-native/package.json', {
        paths: [projectRoot],
    });
    return {
        command: nodePath,
        args: [
            path.join(path.dirname(terminalNativePackageJson), 'scripts', 'materializeNativeBuildInputs.mjs'),
            '--platform',
            platform,
        ],
    };
}

async function materializeTerminalNativeBuildInputs({
    projectRoot,
    platform,
    execFileAsync: run = execFileAsync,
    resolveMaterializer = resolveTerminalNativeBuildInputMaterializer,
}) {
    const invocation = resolveMaterializer({ projectRoot, platform });
    await run(invocation.command, invocation.args, {
        cwd: projectRoot,
        env: process.env,
        maxBuffer: 1024 * 1024,
    });
}

function withTerminalNativeBuildInputs(config, options = {}) {
    const withDangerousMod = options.withDangerousMod ?? expoWithDangerousMod;
    const materialize = options.materialize ?? materializeTerminalNativeBuildInputs;
    let nextConfig = config;

    for (const platform of ['ios', 'android']) {
        nextConfig = withDangerousMod(nextConfig, [platform, async (modConfig) => {
            if (modConfig?.modRequest?.introspect) return modConfig;
            await materialize({
                platform,
                projectRoot: modConfig?.modRequest?.projectRoot ?? process.cwd(),
            });
            return modConfig;
        }]);
    }
    return nextConfig;
}

withTerminalNativeBuildInputs.resolveTerminalNativeBuildInputMaterializer = resolveTerminalNativeBuildInputMaterializer;
withTerminalNativeBuildInputs.materializeTerminalNativeBuildInputs = materializeTerminalNativeBuildInputs;

module.exports = withTerminalNativeBuildInputs;
