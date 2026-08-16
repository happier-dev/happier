#!/usr/bin/env node

const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');

const terminalSignalNames = ['SIGINT', 'SIGQUIT'];

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value, name) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        throw new Error(`Invalid terminal launch spec: ${name} must be an array of strings`);
    }
    return value;
}

function readOptionalStringArray(value, name) {
    if (value === undefined) return [];
    return readStringArray(value, name);
}

function readEnv(value) {
    if (!isPlainObject(value)) {
        throw new Error('Invalid terminal launch spec: env must be an object');
    }
    const env = Object.create(null);
    for (const [key, envValue] of Object.entries(value)) {
        if (typeof envValue !== 'string') {
            throw new Error(`Invalid terminal launch spec: env.${key} must be a string`);
        }
        env[key] = envValue;
    }
    return env;
}

function buildChildEnv(specEnv, envPassthroughKeys) {
    const env = { ...specEnv };
    for (const key of envPassthroughKeys) {
        const value = process.env[key];
        if (typeof value === 'string') {
            env[key] = value;
        }
    }
    return env;
}

async function readLaunchSpecFile(specPath) {
    if (typeof specPath !== 'string' || specPath.length === 0) {
        throw new Error('Invalid terminal launch spec path');
    }
    const raw = await fs.readFile(specPath, 'utf8');
    await fs.unlink(specPath).catch(() => {});
    const specDir = path.dirname(specPath);
    if (path.basename(specDir).startsWith('happier-terminal-launch-')) {
        await fs.rmdir(specDir).catch(() => {});
    }
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
        throw new Error('Invalid terminal launch spec: root must be an object');
    }
    if (typeof parsed.command !== 'string' || parsed.command.length === 0) {
        throw new Error('Invalid terminal launch spec: command must be a non-empty string');
    }
    if (typeof parsed.cwd !== 'string' || parsed.cwd.length === 0) {
        throw new Error('Invalid terminal launch spec: cwd must be a non-empty string');
    }
    return {
        command: parsed.command,
        args: readStringArray(parsed.args, 'args'),
        cwd: parsed.cwd,
        env: buildChildEnv(readEnv(parsed.env), readOptionalStringArray(parsed.envPassthroughKeys, 'envPassthroughKeys')),
    };
}

function installTerminalSignalGuards() {
    const installed = [];
    for (const signal of terminalSignalNames) {
        const listener = () => {};
        try {
            process.on(signal, listener);
            installed.push([signal, listener]);
        } catch {
            // Some platforms do not support all terminal control signals.
        }
    }
    let removed = false;
    return () => {
        if (removed) return;
        removed = true;
        for (const [signal, listener] of installed) {
            try {
                if (typeof process.off === 'function') {
                    process.off(signal, listener);
                } else {
                    process.removeListener(signal, listener);
                }
            } catch {
                // Best-effort cleanup; the child has already settled.
            }
        }
    };
}

function runLaunchSpec(spec) {
    return new Promise((resolve, reject) => {
        const child = spawn(spec.command, spec.args, {
            cwd: spec.cwd,
            env: spec.env,
            shell: false,
            stdio: 'inherit',
            windowsHide: true,
            ...(spec.windowsVerbatimArguments === true
                ? { windowsVerbatimArguments: true }
                : {}),
        });
        const removeSignalGuards = installTerminalSignalGuards();
        let settled = false;
        const settle = (fn) => {
            if (settled) return;
            settled = true;
            removeSignalGuards();
            fn();
        };
        child.on('error', (error) => {
            settle(() => reject(error));
        });
        child.on('close', (code, signal) => {
            if (typeof code === 'number') {
                settle(() => resolve(code));
                return;
            }
            if (signal) {
                settle(() => resolve(1));
                return;
            }
            settle(() => resolve(1));
        });
    });
}

async function runLaunchSpecFile(specPath) {
    return await runLaunchSpec(await readLaunchSpecFile(specPath));
}

async function main(argv) {
    if (argv.length !== 3) {
        console.error('Usage: terminal_launch_spec_runner.cjs <launch-spec.json>');
        return 64;
    }
    return await runLaunchSpecFile(argv[2]);
}

module.exports = {
    readLaunchSpecFile,
    runLaunchSpec,
    runLaunchSpecFile,
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
