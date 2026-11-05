import { describe, expect, it } from 'vitest';
import { createMachineNativeEffectAdmission, machineNativeEffectAdmission } from './machineNativeEffectAdmission';
import { applyMachineSetup } from '@/machines/setup/applyMachineSetup';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyExitEvent, PtyProcess, PtyProvider } from '@/terminal/pty/provider';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

async function waitForSetupSpawn(started: Promise<void>, pending: Promise<unknown>): Promise<void> {
    await Promise.race([started, pending.then(result => {
        const code = result && typeof result === 'object' && 'errorCode' in result
            && typeof result.errorCode === 'string' ? result.errorCode : 'unexpected_settlement';
        throw new Error(`Setup settled before native spawn: ${code}`);
    })]);
}

// Only the OS PTY/process-tree boundary is substituted; the setup/terminal owners are real.
class NativeSetupProcess implements PtyProcess {
    readonly pid = 23456;
    readonly ownedProcessGroupId = 23456;
    private readonly exits = new Set<(event: PtyExitEvent) => void>();
    write() { throw new Error('not interactive'); }
    resize() {}
    kill() {}
    onData() { return { dispose() {} }; }
    onExit(listener: (event: PtyExitEvent) => void) { this.exits.add(listener); return { dispose: () => this.exits.delete(listener) }; }
    exit() { for (const listener of this.exits) listener({ exitCode: 0, signal: 0 }); }
}

function setupFixture() {
    const started = deferred();
    const processes: NativeSetupProcess[] = [];
    const provider: PtyProvider = { spawn() {
        const process = new NativeSetupProcess();
        processes.push(process);
        if (processes.length === 1) started.resolve();
        else queueMicrotask(() => process.exit());
        return process;
    } };
    const terminalSessions = createTerminalPtySessionManager({ ptyProvider: provider, env: { SHELL: '/bin/sh' },
        probeProcessGroup: () => 'absent', stopProcessTree: async () => {},
        config: { bufferMaxBytes: 100000, bufferMaxEvents: 1000,
            urlParseBufferLimit: 32768, maxWriteChunkBytes: 16384, defaultCols: 80, defaultRows: 24 } });
    const controller = new AbortController();
    const input = {
        homeId: 'home', machineId: 'machine', preset: { id: 'preset', revision: 1 }, requesterAccountId: 'person',
        userHomeDirectory: '/tmp', setup: { scripts: [{ body: 'portable-setup', affects: 'none' as const }] }, terminalSessions,
        hostEnvironment: { SHELL: '/bin/sh', PATH: '/bin' }, platform: 'linux' as const,
        environmentIo: { resolveTool: async () => null, run: async () => ({ exitCode: 0, stdout: '{"ID":"engine"}\n' }) },
        operation: { actionRequestId: 'setup-first', signal: controller.signal,
            operationOwnerUpdate: { update() {} }, operationProgress: { update() {} } },
        isCurrent: async () => true,
    };
    return { input, started, processes, controller, terminalSessions };
}

describe('Setup with unreadable Docker', () => {
    it.each(['ENOENT', 'EACCES', 'ECONNREFUSED', 'plugin_exec_system_tool_unavailable'])(
        'runs setup with unreadable Docker (%s) and makes concurrent native work wait', async code => {
        const setup = setupFixture();
        const input = { ...setup.input, setup: { scripts: [{ body: 'install-docker', affects: 'dockerEngine' as const }] },
            environmentIo: { ...setup.input.environmentIo, async run() {
                throw Object.assign(new Error('Docker probe unavailable'), { code });
            } } };
        const first = applyMachineSetup(input);
        let competing: Promise<void> | undefined;
        let competingEffects = 0;
        try {
            await waitForSetupSpawn(setup.started.promise, first);
            competing = machineNativeEffectAdmission.run({
                operation: { operationId: `concurrent-${code}`, kind: 'service-control' },
                keys: [{ kind: 'composeProject', dockerEndpoint: 'another-engine', projectName: 'app' }],
            }, async () => { competingEffects++; });
            await Promise.resolve();
            expect(competingEffects).toBe(0);
            setup.processes[0]!.exit();
            expect(await first).toMatchObject({ ok: true });
            await competing;
            expect(competingEffects).toBe(1);
        } finally {
            for (const process of setup.processes) process.exit();
            await first;
            await competing;
            setup.terminalSessions.dispose();
        }
    });

    it('waits for keys-empty native work before running broad setup', async () => {
        const owner = createMachineNativeEffectAdmission();
        const entered = deferred(), finish = deferred();
        const current = owner.run({ operation: { operationId: 'current', kind: 'service-control' }, keys: [] }, async () => {
            entered.resolve(); await finish.promise;
        });
        await entered.promise;
        let effects = 0;
        const waiting = owner.run({ operation: { operationId: 'setup', kind: 'setup' }, keys: [], allNative: true },
            async () => { effects++; });
        try { await Promise.resolve(); expect(effects).toBe(0); }
        finally { finish.resolve(); await current; await waiting; }
        expect(effects).toBe(1);
    });

    it('cancels a broad effect waiting for keys-empty native work without running it', async () => {
        const owner = createMachineNativeEffectAdmission();
        const entered = deferred(), finish = deferred();
        const current = owner.run({ operation: { operationId: 'current', kind: 'service-control' }, keys: [] }, async () => {
            entered.resolve(); await finish.promise;
        });
        await entered.promise;
        const controller = new AbortController();
        let effects = 0;
        const waiting = owner.run({ operation: { operationId: 'setup', kind: 'setup', signal: controller.signal },
            keys: [], allNative: true }, async () => { effects++; });
        try {
            controller.abort();
            await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
            expect(effects).toBe(0);
        } finally { finish.resolve(); await current; }
        await owner.run({ operation: { operationId: 'retry', kind: 'setup' }, keys: [], allNative: true }, async () => { effects++; });
        expect(effects).toBe(1);
    });
});
