import { describe, expect, it } from 'vitest';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { createPythonPtyRelayProvider, resolvePythonPtyRelayExecutable } from '@/terminal/pty/pythonRelay';
import { authorizeResolvedProjectExecLaunchForHost } from './exec';
import { createManagedServiceProcessSupervisorHost } from './managedProcessSupervisor';

// The service and its view share the real OS PTY, byte ring, and supervisor.
describe.skipIf(process.platform === 'win32' || !resolvePythonPtyRelayExecutable({ env: process.env, platform: process.platform }))('interactive managed service', () => {
    it('attaches to the supervised process and retains its stopped output after Ctrl-C', async () => {
        const provider = createPythonPtyRelayProvider({ env: process.env, platform: process.platform });
        if (!provider) throw new Error('PTY provider unavailable');
        const sessions = createTerminalPtySessionManager({ ptyProvider: provider, config: {
            bufferMaxBytes: 1_000_000, bufferMaxEvents: 1000, urlParseBufferLimit: 32_768,
            maxWriteChunkBytes: 16_384, defaultCols: 80, defaultRows: 24,
        } });
        const cwd = process.cwd();
        const custody = { serverId: 'home', machineId: 'machine', installationId: 'installation',
            workspaceRefId: 'workspace', projectKey: 'project', rootPath: cwd, requesterAccountId: 'starter' };
        const host = createManagedServiceProcessSupervisorHost();
        const supervisor = host.bind({ kind: 'project', projectRoot: cwd, isOccurrenceCurrent: () => true });
        const spec = {
            id: 'interactive-fixture', mode: { kind: 'managedSpawn' as const, endpointNone: true as const },
            watchdog: { intervalMs: 5000, missedIntervals: 2 },
            interactiveTerminal: { sessions, custody, terminalKey: 'service-fixture' },
            authorizeLaunch: async ({ signal }: { signal: AbortSignal }) => authorizeResolvedProjectExecLaunchForHost({
                launch: { command: '/bin/sh', args: ['-c', 'trap "exit 0" INT; printf "SERVICE_READY\\n"; while :; do read value; done'], cwd, env: { ...process.env } },
                projectLaunch: { status: 'ready', reviewedEffectDigest: 'fixture', toolchain: {
                    selection: { kind: 'host' }, root: cwd, platform: process.platform,
                    io: { resolveTool: async () => null, run: async () => { throw new Error('No native tooling needed'); } },
                } }, signal, assertCurrent() {},
            }),
        };
        const service = await supervisor.supervise(spec);
        try {
            expect(sessions.list()).toHaveLength(1);
            const terminal = sessions.list()[0]!;
            expect(sessions.getCustody(terminal.terminalId)).toEqual(custody);
            await expect.poll(() => sessions.read({ terminalId: terminal.terminalId, cursor: 0, maxBytes: 1000, maxEvents: 10 }))
                .toMatchObject({ ok: true, events: expect.arrayContaining([expect.objectContaining({ t: 'data', data: expect.stringContaining('SERVICE_READY') })]) });
            expect(service.terminalView).toMatchObject({ terminalId: terminal.terminalId, terminalKey: 'service-fixture', interactive: true });
            expect(await service.readNativeLogs?.()).toMatchObject({ kind: 'page', page: { text: expect.stringContaining('SERVICE_READY') } });
            expect(sessions.close({ terminalId: terminal.terminalId })).toMatchObject({ ok: false, errorCode: 'terminal_busy' });
            // Presentation reads are attachments: neither creates another process.
            expect(sessions.list()[0]?.terminalId).toBe(terminal.terminalId);
            expect(sessions.list()).toHaveLength(1);
            expect(await sessions.input({ terminalId: terminal.terminalId, data: '\u0003' })).toEqual({ ok: true });
            await expect.poll(() => service.snapshot().state).toBe('stopped');
            expect(sessions.list()).toMatchObject([{ terminalId: terminal.terminalId, ended: true }]);
            expect(sessions.read({ terminalId: terminal.terminalId, cursor: 0, maxBytes: 1000, maxEvents: 10 })).toMatchObject({ ok: true, done: true });
        } finally { await service.dispose(); sessions.dispose(); }
    });
});
