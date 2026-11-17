#!/usr/bin/env node

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createProcessTreeOwner, taskkillWindowsProcessTree } = require('./process_tree.cjs');
const { reportNativeProcessExited } = require('./native_process_exit.cjs');

const terminalSignalNames = ['SIGINT', 'SIGQUIT'];

// This launcher runs in its own process, so it composes the process-tree owner with
// its own census and process tools (bundled into this sidecar only).
async function terminateProcessTree(proc, options) {
    if (!proc.pid) return;
    const [processTools, processes] = await Promise.all([import('@happier-dev/cli-common/process'), import('#process-census')]);
    const owner = createProcessTreeOwner({ ...processTools, ...processes,
        taskkillWindowsProcessTree: input => taskkillWindowsProcessTree(input, processTools.windowsSystemToolCommand, processTools.execFileWithDeadline),
    });
    await owner.terminateProcessTree(proc, options);
}

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
    let parsed;
    let parseError;
    try { parsed = JSON.parse(raw); } catch (error) { parseError = error; }
    const specDir = path.dirname(specPath);
    const expectedSpawnResultPath = path.join(specDir, 'native-startup.json');
    const ownsSpawnResult = parsed?.spawnResultPath === expectedSpawnResultPath;
    let cleanupIncomplete = false;
    const recordCleanupFailure = (error) => { if (error?.code !== 'ENOENT') cleanupIncomplete = true; };
    await fs.unlink(specPath).catch(recordCleanupFailure);
    const legacyTemporaryDirectory = path.basename(specDir).startsWith('happier-terminal-launch-');
    let markerPath;
    if (path.basename(specDir).startsWith('terminal-launch-')) {
        // The sidecar stager bundles this authored workspace leaf into the
        // standalone runner. No installed package is needed by the staged asset.
        const owner = await import('@happier-dev/cli-common/tempDirs');
        if (owner.readHappierTempDirOwner(specDir)?.purpose === 'terminal-launch') {
            markerPath = owner.getHappierTempDirOwnerPath(specDir);
        } else cleanupIncomplete = true;
    }
    if (legacyTemporaryDirectory || markerPath) {
        let removed = false;
        try { await fs.rmdir(specDir); removed = true; }
        catch (error) {
            let onlyOwnedReceipt = false;
            if (error?.code === 'ENOTEMPTY' && ownsSpawnResult) {
                try {
                    const entries = await fs.readdir(specDir);
                    onlyOwnedReceipt = entries.length === 1 && entries[0] === 'native-startup.json';
                } catch (inspectionError) { onlyOwnedReceipt = inspectionError?.code === 'ENOENT'; }
            }
            if (!onlyOwnedReceipt) recordCleanupFailure(error);
        }
        if (removed && markerPath) await fs.unlink(markerPath).catch(recordCleanupFailure);
    }
    // The private handoff has been read. Cleanup is observable but must not
    // replace validation/startup failures or a completed native outcome.
    if (cleanupIncomplete) console.error('Terminal launch artifact cleanup incomplete (terminal_launch_artifact_cleanup_incomplete)');
    if (parseError) throw parseError;
    if (!isPlainObject(parsed)) {
        throw new Error('Invalid terminal launch spec: root must be an object');
    }
    if (typeof parsed.command !== 'string' || parsed.command.length === 0) {
        throw new Error('Invalid terminal launch spec: command must be a non-empty string');
    }
    if (typeof parsed.cwd !== 'string' || parsed.cwd.length === 0) {
        throw new Error('Invalid terminal launch spec: cwd must be a non-empty string');
    }
    if (parsed.windowsVerbatimArguments !== undefined && typeof parsed.windowsVerbatimArguments !== 'boolean') {
        throw new Error('Invalid terminal launch spec: windowsVerbatimArguments must be a boolean');
    }
    if (parsed.spawnResultPath !== undefined && !ownsSpawnResult) {
        throw new Error('Invalid terminal launch spec: native startup receipt must be the exact private sibling');
    }
    return {
        command: parsed.command,
        args: readStringArray(parsed.args, 'args'),
        cwd: parsed.cwd,
        env: buildChildEnv(readEnv(parsed.env), readOptionalStringArray(parsed.envPassthroughKeys, 'envPassthroughKeys')),
        ...(parsed.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
        ...(ownsSpawnResult ? { spawnResultPath: expectedSpawnResultPath } : {}),
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

function runLaunchSpec(spec, controllerSignal, controllerChannel) {
    return new Promise((resolve, reject) => {
        if (controllerSignal?.aborted) { resolve(1); return; }
        let nativeSpawnReported = false;
        const reportNativeSpawnResult = (status) => {
            if (!spec.spawnResultPath) return;
            // Startup is an observed event, not the eventual process outcome.
            // Node can emit an operation error after a successful executable spawn.
            if (nativeSpawnReported) return;
            nativeSpawnReported = true;
            try { fsSync.writeFileSync(spec.spawnResultPath, JSON.stringify({ status }), { mode: 0o600 }); }
            catch { console.error('Native terminal startup receipt could not be written (terminal_native_startup_unknown)'); }
        };
        let child;
        try { child = spawn(spec.command, spec.args, {
            cwd: spec.cwd,
            env: spec.env,
            shell: false,
            stdio: 'inherit',
            windowsHide: true,
            ...(spec.windowsVerbatimArguments === true
                ? { windowsVerbatimArguments: true }
                : {}),
        }); } catch (error) {
            reportNativeSpawnResult('failed');
            reject(error);
            return;
        }
        const removeSignalGuards = installTerminalSignalGuards();
        let controllerCleanup = null;
        const onControllerClosed = () => {
            // The surviving launcher owns this tree; no polling or independent host policy.
            controllerCleanup ??= terminateProcessTree(child).catch(() => {
                console.error('Owned terminal process cleanup could not be verified (terminal_controller_cleanup_incomplete)');
                report({ type: 'terminal-native-signal-failed' });
            });
        };
        controllerSignal?.addEventListener('abort', onControllerClosed, { once: true });
        let settled = false;
        const report = (message) => {
            if (!controllerChannel?.connected) return;
            controllerChannel.send(message, () => {});
        };
        const onSignal = (message) => {
            if (settled || !isPlainObject(message) || message.type !== 'terminal-native-signal') return;
            if (message.signal !== 'SIGINT' && message.signal !== 'SIGKILL') return;
            if (message.signal === 'SIGKILL') {
                onControllerClosed();
                return;
            }
            try {
                if (!child.kill(message.signal)) report({ type: 'terminal-native-signal-failed' });
            }
            catch { report({ type: 'terminal-native-signal-failed' }); }
        };
        controllerChannel?.on('message', onSignal);
        child.once('spawn', () => {
            reportNativeSpawnResult('spawned');
            report({ type: 'terminal-native-spawned' });
        });
        const settle = async (fn) => {
            if (settled) return;
            settled = true;
            controllerSignal?.removeEventListener('abort', onControllerClosed);
            controllerChannel?.off('message', onSignal);
            removeSignalGuards();
            await controllerCleanup;
            fn();
        };
        child.on('error', (error) => {
            reportNativeSpawnResult('failed');
            settle(() => reject(error));
        });
        child.on('close', async (code, signal) => {
            if (controllerChannel) await reportNativeProcessExited(process, code, signal);
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
    // Arm before the asynchronous secret handoff read. Imported callers may themselves
    // have IPC (for example test workers); only this standalone launcher's channel is ours.
    const lifetime = require.main === module && typeof process.send === 'function' ? new AbortController() : null;
    const onControllerClosed = () => lifetime.abort();
    if (lifetime) {
        process.once('disconnect', onControllerClosed);
        if (!process.connected) lifetime.abort();
    }
    try {
        return await runLaunchSpec(await readLaunchSpecFile(specPath), lifetime?.signal, lifetime ? process : undefined);
    } finally {
        if (lifetime) {
            process.off('disconnect', onControllerClosed);
            if (process.connected) process.disconnect();
        }
    }
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
    terminateProcessTree,
};

if (require.main === module) {
    main(process.argv).then(
        (code) => {
            process.exit(code);
        },
        (error) => {
            console.error('Terminal native launch failed (terminal_native_launch_failed)');
            process.exit(127);
        },
    );
}
