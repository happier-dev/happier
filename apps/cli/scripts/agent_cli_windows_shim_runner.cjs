#!/usr/bin/env node

const {
    runLaunchSpec,
} = require('./terminal_launch_spec_runner.cjs');

async function loadCommandInvocationResolver() {
    const processModule = await import('@happier-dev/cli-common/process');
    return processModule.resolveWindowsCommandInvocation;
}

async function runAgentCli(params) {
    const invocation = params.resolveCommandInvocation({
        command: params.command,
        args: params.args,
        env: process.env,
        resolveCommandOnPath: false,
    });
    return await runLaunchSpec({
        command: invocation.command,
        args: invocation.args,
        cwd: process.cwd(),
        env: process.env,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
}

async function main(argv) {
    const command = argv[2];
    if (typeof command !== 'string' || command.trim().length === 0) {
        console.error('Usage: agent_cli_windows_shim_runner.cjs <agent-cli> [args...]');
        return 64;
    }
    return await runAgentCli({
        command,
        args: argv.slice(3),
        resolveCommandInvocation: await loadCommandInvocationResolver(),
    });
}

module.exports = {
    runAgentCli,
};

if (require.main === module) {
    main(process.argv).then(
        (code) => {
            process.exit(code);
        },
        (error) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exit(127);
        },
    );
}
