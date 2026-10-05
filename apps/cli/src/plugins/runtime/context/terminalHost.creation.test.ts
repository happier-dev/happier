import { readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { SessionMetadataTuplePatchV1Schema, V2SessionByIdResponseSchema } from '@happier-dev/protocol';

const inventory = vi.hoisted(() => ({ socketPath: '', inheritedSpawns: 0, startedServers: [] as string[] }));
const sessionTransport = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', async original => ({ ...await original<typeof import('socket.io-client')>(), io: sessionTransport.io }));
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: async () => null }));
// Only executable inventory and child spawning are substituted; sockets, adapters,
// current-pane verification, and attachment persistence use their real owners.
vi.mock('node:child_process', async (importOriginal) => {
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');
    return {
        ...await importOriginal<typeof import('node:child_process')>(),
        spawn: vi.fn((_command: string, args: readonly string[], options: { stdio?: unknown }) => {
            if (args.includes('server')) {
                inventory.startedServers.push(args[0] === '--session' ? args[1]! : 'default');
                return Object.assign(new EventEmitter(), { unref() {} });
            }
            if (Array.isArray(options?.stdio) && options.stdio.slice(0, 3).every((stream) => stream === 'inherit')) {
                inventory.inheritedSpawns += 1;
                const child = new EventEmitter();
                // The real owned launcher ACKs native startup before --version exits.
                setImmediate(() => {
                    child.emit('message', { type: 'terminal-native-spawned' });
                    setImmediate(() => child.emit('exit', 0, null));
                });
                return child;
            }
            const child = Object.assign(new EventEmitter(), {
                stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
            });
            setImmediate(() => child.emit('error', Object.assign(new Error('not installed'), { code: 'ENOENT' })));
            return child;
        }),
        execFile: Object.assign(vi.fn((binary: string, args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
            const child = Object.assign(new EventEmitter(), {
                stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null,
                kill: () => true,
            });
            setImmediate(() => {
                const error = binary === 'tmux' ? Object.assign(new Error('not installed'), { code: 'ENOENT' }) : null;
                const stdout = binary === 'herdr' && args[0] === '--version'
                    ? 'herdr 0.9.2'
                    : JSON.stringify({ sessions: ['default', 'work', 'explicit', ...inventory.startedServers].map((name) => ({
                        name, socket_path: inventory.socketPath, running: true,
                    })) });
                child.exitCode = error ? 1 : 0;
                child.emit('exit', child.exitCode, null);
                callback(error, error ? '' : stdout, '');
                child.emit('close', child.exitCode, null);
            });
            return child;
        }), {
            [Symbol.for('nodejs.util.promisify.custom')]: async (binary: string, args: readonly string[]) => {
                if (binary === 'tmux') throw Object.assign(new Error('not installed'), { code: 'ENOENT' });
                return {
                    stdout: binary === 'herdr' && args[0] === '--version'
                        ? 'herdr 0.9.2'
                        : JSON.stringify({ sessions: ['default', 'work', 'explicit', ...inventory.startedServers].map((name) => ({
                            name, socket_path: inventory.socketPath, running: true,
                        })) }),
                    stderr: '',
                };
            },
        }),
    };
});

import { createHerdrTerminalHostAdapter } from '@/integrations/herdr/adapter';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { resolveTerminalHost } from '@/integrations/terminal/host/resolveTerminalHost';
import { requireAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import { readTerminalHostAttachmentInfo, writeTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { withTempDir } from '@/testkit/fs/tempDir';
import { resolveInheritedHerdrRuntime } from '@/terminal/runtime/inheritedHerdrRuntime';
import { buildTerminalMetadataFromRuntimeFlags } from '@/terminal/runtime/terminalMetadata';
import { buildTerminalMetadataFromHostHandle } from '@/terminal/runtime/terminalMetadata';
import { acquireSessionRunnerLock } from '@/daemon/sessionRunnerLock';
import { withSessionRunnerOwnership } from '@/daemon/sessionRunnerLock';
import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession';
import { configuration } from '@/configuration';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { createApiSessionSocketStub, bindApiSessionSocketPairMock } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture, createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionHooksService } from '@/plugins/runtime/hooks/session/service';
import { createEventsFixture, createPluginContextFixture } from '../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import { createClaudeUnifiedTerminalTurnOperations } from '../../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/turnOperations';
import { createProviderCliAttachSurface } from '@/session/attach/providerCliAttach';
import { resolveOpenCodeAttachTarget, createOpenCodeAttachArgs } from '../../../../../../packages/plugins/opencode/src/agent/surfaces/sessions/attach/descriptor';
import { executeTerminalHostDisposition } from '@/terminal/attachment/terminalHostDisposition';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import { createDefaultPluginTerminalHostService, createDefaultPreparedTerminalHostOwner, createPluginTerminalHostService } from './terminalHost';

describe('plugin terminal-host creation rollback', () => {
    it.each(['current', 'predecessor', 'ordinary', 'borrowed', 'mismatched', 'unreadable', 'absent', 'retired', 'snapshot-unavailable', 'plain-current', 'plain-predecessor', 'missing-current', 'missing-predecessor', 'fresh'] as const)('preserves the exact retained provider through real headless initialization and adoption (%s)', async (format) => {
        await withTempDir('retained-startup-', async happyHomeDir => await withHerdrApi(async api => {
            inventory.socketPath = api.socketPath;
            const previousHome = configuration.happyHomeDir;
            Object.assign(configuration, { happyHomeDir });
            const sessionId = `retained-startup-${format}`;
            api.panes.add('original-provider');
            const attachment = await writeTerminalHostAttachmentInfo({ happyHomeDir, sessionId, lifecycle: format === 'borrowed' ? 'borrowed' : 'owned',
                handle: { kind: 'herdr', sessionName: 'work', socketPath: api.socketPath, terminalId: 'original-provider', paneId: 'original-provider',
                    attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' } } });
            const terminal = buildTerminalMetadataFromHostHandle(attachment.handle)!;
            const missingAssociation = format.startsWith('plain-') || format.startsWith('missing-');
            const predecessor = format === 'predecessor' || format.endsWith('-predecessor');
            const snapshotTerminal = format.startsWith('missing-') ? undefined
                : format.startsWith('plain-') || format === 'fresh' ? { mode: 'plain' as const }
                : format === 'mismatched'
                ? { ...terminal, herdr: { ...terminal.herdr!, terminalId: 'different-provider' } }
                : format === 'retired' ? { ...terminal, controlServiceabilityV1: { ...terminal.controlServiceabilityV1!, retired: true } } : terminal;
            if (format === 'unreadable') await writeFile(join(happyHomeDir, 'terminal', 'sessions', `${sessionId}.host.json`), '{');
            if (format === 'absent' || format === 'fresh') await unlink(join(happyHomeDir, 'terminal', 'sessions', `${sessionId}.host.json`));
            if (predecessor) {
                // The supported predecessor persists the exact v2 binding in the display filename.
                await writeFile(join(happyHomeDir, 'terminal', 'sessions', `${sessionId}.json`), JSON.stringify({ ...attachment, terminal }));
                await unlink(join(happyHomeDir, 'terminal', 'sessions', `${sessionId}.host.json`));
            }
            const fixture = createPlainSessionFixture({ id: sessionId, metadata: createTestMetadata({ startedBy: 'daemon', terminal: snapshotTerminal }) });
            const retainedRecordPath = join(happyHomeDir, 'terminal', 'sessions', `${sessionId}.${predecessor ? 'json' : 'host.json'}`);
            const retainedRecord = missingAssociation ? await readFile(retainedRecordPath, 'utf8') : null;
            let row: ReturnType<typeof V2SessionByIdResponseSchema.parse>['session'] & { agentStateVersion: number } = {
                ...createSessionNotificationContextFixture(sessionId), active: true, metadata: JSON.stringify(fixture.metadata),
                metadataVersion: fixture.metadataVersion, agentState: null, agentStateVersion: fixture.agentStateVersion,
                encryptionMode: 'plain', metadataLayoutVersion: 0, share: null,
            };
            const originalMetadata = row.metadata;
            const socket = createApiSessionSocketStub({ connected: true });
            const userSocket = createApiSessionSocketStub({ connected: true });
            bindApiSessionSocketPairMock(sessionTransport.io, { sessionSocket: socket, userSocket });
            vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
                if (path === `/v2/sessions/${sessionId}`) {
                    if (format === 'snapshot-unavailable') {
                        setImmediate(() => userSocket.trigger('disconnect', 'transport close'));
                        throw new Error('Snapshot transport unavailable');
                    }
                    return { status: 200, data: V2SessionByIdResponseSchema.parse({ session: row }) };
                }
                throw new Error(`Unexpected HTTP path ${path}`);
            });
            vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
                const patch = SessionMetadataTuplePatchV1Schema.parse(body);
                if (patch.mode === 'shared_editor') throw new Error('Unexpected shared editor');
                const target = patch.mode === 'owner_migration' ? patch.target : patch;
                row = { ...row, metadataLayoutVersion: 1, metadata: target.sharedMetadata.ciphertext,
                    metadataVersion: row.metadataVersion + 1, ownerMetadata: target.ownerMetadata,
                    agentState: target.agentState.ciphertext, agentStateVersion: row.agentStateVersion + 1 };
                return { status: 200, data: { success: true, metadataLayoutVersion: 1,
                    sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
            });
            let client: ApiSessionClient | undefined;
            try {
                await withSessionRunnerOwnership(async () => {
                    const initialize = {
                        api: { getOrCreateSession: async () => { throw new Error('Must not create another Session'); },
                            sessionSyncClient: (base: Parameters<typeof createTestApiSessionClient>[2]) => {
                                client = createTestApiSessionClient(ApiSessionClient, 'fixture-token', base,
                                    { metadataAuthority: { kind: 'owner', credentials: { token: 'fixture-token', encryption: null } } });
                                return client;
                            } },
                        existingSessionId: sessionId, sessionTag: sessionId, metadata: createTestMetadata({ startedBy: 'daemon', terminal: { mode: 'plain', requested: 'herdr' } }),
                        sessionAttachSecret: { encryptionMode: 'plain' as const, snapshot: { metadata: fixture.metadata,
                            metadataVersion: format === 'snapshot-unavailable' ? -1 : fixture.metadataVersion, agentState: fixture.agentState, agentStateVersion: fixture.agentStateVersion } },
                        state: { controlledByUser: false }, uiLogPrefix: '[retained-test]',
                        startupMetadataOverrides: { permissionModeOverride: { mode: 'default' as const, updatedAt: 1 } },
                        ...(format === 'ordinary' ? {} : { retainedTerminalRecovery: 'adopt' as const }),
                    };
                    if (missingAssociation || format === 'mismatched' || format === 'unreadable' || format === 'absent' || format === 'snapshot-unavailable') {
                        const outcome = await initializeBackendRunSession(initialize).then(() => 'completed', (error: unknown) => error);
                        if (missingAssociation) {
                            expect(await readFile(retainedRecordPath, 'utf8')).toBe(retainedRecord);
                            expect(row.metadata).toBe(originalMetadata);
                            expect(await readTerminalHostAttachmentInfo({ happyHomeDir, sessionId })).toMatchObject({ version: 2, attachmentId: attachment.attachmentId });
                        }
                        expect(outcome).toMatchObject({ code: 'PLUGIN_TERMINAL_HOST_UNAVAILABLE' });
                        expect(row.metadataVersion).toBe(fixture.metadataVersion);
                        expect(row.metadata).toBe(originalMetadata);
                        return;
                    }
                    const initialized = await initializeBackendRunSession(initialize);
                    const retained = format === 'current' || format === 'predecessor';
                    expect(initialized.session.getMetadataSnapshot()?.terminal).toEqual(retained ? terminal : initialize.metadata.terminal);
                    const currentAttachment = await readTerminalHostAttachmentInfo({ happyHomeDir, sessionId });
                    if (format === 'fresh') expect(currentAttachment).toBeNull();
                    else expect(currentAttachment).toMatchObject({ version: attachment.version, attachmentId: attachment.attachmentId });
                    const service = createDefaultPluginTerminalHostService({ happyHomeDir, hasCapability: capability => capability === 'terminalHost',
                        readSessionId: () => sessionId, readSessionMetadata: () => initialized.session.getMetadataSnapshot(),
                        currentTerminalMetadata: { terminal: initialize.metadata.terminal } });
                    if (retained) await expect(service.adoptExistingHost?.()).resolves.toMatchObject({ kind: 'herdr', terminalId: 'original-provider', attachmentId: attachment.attachmentId });
                    else if (format === 'borrowed' || format === 'fresh') await expect(service.adoptExistingHost?.()).resolves.toBeNull();
                    else await expect(service.adoptExistingHost?.()).rejects.toMatchObject({ code: 'PLUGIN_TERMINAL_HOST_UNAVAILABLE' });
                    expect(api.requests.some(request => request.method === 'layout.apply' || request.method === 'pane.close')).toBe(false);
                });
            } finally {
                await client?.close();
                Object.assign(configuration, { happyHomeDir: previousHome });
                vi.restoreAllMocks(); vi.unstubAllGlobals();
            }
        }));
    });
    it('keeps the admitted Herdr endpoint before a native provider selects a different ambient configuration root', async () => {
        await withTempDir('admitted-herdr-endpoint-', async happyHomeDir => await withHerdrApi(async admitted => await withHerdrApi(async ambient => {
            inventory.socketPath = ambient.socketPath;
            const params = { happyHomeDir, hasCapability: (capability: string) => capability === 'terminalHost',
                readSessionId: () => 'admitted-endpoint-session',
                herdrRuntime: { herdrSessionName: 'work', herdrSocketPath: admitted.socketPath } };
            const service = createDefaultPluginTerminalHostService(params);
            try {
                const handle = await service.createOrAttachHost({ preference: 'herdr', sessionName: 'work',
                    workingDirectory: tmpdir(), isolatedEnv: true,
                    launch: { kind: 'agent-cli', agentId: 'claude', args: ['--version'], env: { HAPPIER_CLAUDE_PATH: process.execPath } } });
                expect(handle.socketPath).toBe(admitted.socketPath);
                expect(admitted.requests.filter(request => request.method === 'layout.apply')).toHaveLength(1);
                expect(ambient.requests).toEqual([]);
            } finally {
                for (const api of [admitted, ambient]) {
                    const layout = api.requests.find(request => request.method === 'layout.apply');
                    const root = layout?.params.root as { command?: string[] } | undefined;
                    const specPath = root?.command?.[2];
                    if (specPath) { await unlink(specPath); await rmdir(dirname(specPath)); }
                }
            }
        })));
    });
    it('retries private cleanup after positive exact physical disposal without destroying the host twice', async () => {
        await withTempDir('prepared-host-cleanup-', async happyHomeDir => await withHerdrApi(async api => {
            inventory.socketPath = api.socketPath;
            const owner = createDefaultPreparedTerminalHostOwner({ happyHomeDir, readSessionId: () => 'cleanup-session',
                herdrRuntime: { herdrSessionName: 'work', herdrSocketPath: api.socketPath } });
            const created = await owner.createPreparedHost({ preference: 'herdr', sessionName: 'work', workingDirectory: happyHomeDir,
                spawnArgv: [process.execPath, '--version'], spawnEnv: {} });
            const extra = join(dirname(created.launch.specPath), 'retained.fixture');
            await writeFile(extra, 'owned fixture');
            try {
                await expect(owner.dispose(created.handle, { kind: 'destroy_owned_host', reason: 'session_closed' }))
                    .rejects.toMatchObject({ code: 'ENOTEMPTY' });
                expect(api.requests.filter(request => request.method === 'pane.close')).toHaveLength(1);
                await unlink(extra);
                await expect(owner.dispose(created.handle, { kind: 'destroy_owned_host', reason: 'session_closed' })).resolves.toBeUndefined();
                expect(api.requests.filter(request => request.method === 'pane.close')).toHaveLength(1);
                expect(await readTerminalHostAttachmentInfo({ happyHomeDir, sessionId: 'cleanup-session' })).toBeNull();
            } finally {
                await unlink(extra).catch(() => undefined);
                await created.launch.discard();
            }
        }));
    });

    it('keeps an unbound created presenter in the same owner until its failed exact rollback can retry', async () => {
        await withTempDir('prepared-host-unbound-', async happyHomeDir => await withHerdrApi(async api => {
            inventory.socketPath = api.socketPath;
            const blockedParent = join(happyHomeDir, 'terminal');
            api.beforeResponse.set('layout.apply', () => {
                writeFileSync(blockedParent, 'filesystem boundary refuses binding only after physical host creation');
            });
            api.faults.set('pane.close', 'error');
            const owner = createDefaultPreparedTerminalHostOwner({ happyHomeDir, readSessionId: () => 'unbound-session',
                herdrRuntime: { herdrSessionName: 'work', herdrSocketPath: api.socketPath } });
            const request = { preference: 'herdr' as const, sessionName: 'work', workingDirectory: happyHomeDir,
                spawnArgv: [process.execPath, '--version'], spawnEnv: {} };
            let specPath: string | undefined;
            try {
                await expect(owner.createPreparedHost(request)).rejects.toBeInstanceOf(AggregateError);
                const root = api.requests.find(item => item.method === 'layout.apply')?.params.root as { command: string[] };
                specPath = root.command[2];
                expect(api.panes.has('managed')).toBe(true);
                await expect(owner.createPreparedHost(request)).rejects.toMatchObject({ code: 'PLUGIN_TERMINAL_HOST_HANDLE_NOT_ACTIVE' });
                expect(api.requests.filter(item => item.method === 'layout.apply')).toHaveLength(1);
                api.faults.delete('pane.close');
                await unlink(blockedParent);
                await expect(owner.disposePending()).resolves.toBeUndefined();
                expect(api.panes.has('managed')).toBe(false);
                await expect(readFile(specPath!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            } finally {
                api.faults.delete('pane.close');
                await unlink(blockedParent).catch(() => undefined);
                await owner.disposePending();
            }
        }));
    });

    it('hosts only the prepared same-server native client, retaining the admitted Session after its pane exits', async ({ task }) => {
        await withTempDir('prepared-native-host-', async happyHomeDir => await withHerdrApi(async api => {
            inventory.socketPath = api.socketPath;
            const sessionId = 'prepared-native-session';
            const record = join(happyHomeDir, 'native.json');
            const script = join(happyHomeDir, 'native.cjs');
            await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({args:process.argv.slice(2),herdrEnv:process.env.HERDR_ENV}));setInterval(()=>{},1000);`);
            const metadata = createTestMetadata({ path: happyHomeDir });
            const session = createMutableApiSessionClientFixture({ sessionId, metadata });
            const owner = createDefaultPreparedTerminalHostOwner({ happyHomeDir, readSessionId: () => sessionId,
                readSessionMetadata: () => session.getMetadataSnapshot() });
            let nativeExited!: () => void;
            const nativeCompletion = new Promise<void>(resolve => { nativeExited = resolve; });
            const os = await vi.importActual<typeof import('node:child_process')>('node:child_process');
            const nativeBoundary: { child?: ChildProcess } = {};
            api.beforeResponse.set('layout.apply', () => {
                const root = api.requests.at(-1)?.params.root as { command: string[] };
                const native = os.spawn(root.command[0]!, root.command.slice(1), { stdio: 'ignore' });
                nativeBoundary.child = native;
                native.once('error', nativeExited);
                native.once('exit', nativeExited);
            });
            const surface = createProviderCliAttachSurface({ agentId: 'opencode', resolveTarget: resolveOpenCodeAttachTarget,
                createArgs: createOpenCodeAttachArgs, env: { HERDR_ENV: '1' },
                resolveLaunchSpec: () => ({ source: 'managed', resolvedPath: process.execPath, command: process.execPath, args: [script] }) });
            let attached = false;
            try {
                const result = await surface.attachManaged({ sessionId, metadata: { path: happyHomeDir, runtimeDescriptorV1: {
                v: 1, agentId: 'opencode', agent: { backendMode: 'server', providerSessionId: 'native-session-one',
                    serverBaseUrl: 'http://127.0.0.1:4312', serverBaseUrlExplicit: true },
            } }, onAttached: async () => {
                // Startup IPC proves spawning, not that this fixture's own write ran.
                await vi.waitFor(async () => { expect(JSON.parse(await readFile(record, 'utf8')).args).toBeDefined(); }, { timeout: task.timeout });
                attached = true; nativeBoundary.child?.kill('SIGTERM');
            }, hostPresentation: {
                owner, preference: 'herdr', sessionName: 'work', workingDirectory: happyHomeDir,
                startupDeadline: () => Date.now() + 10_000, startupPollIntervalMs: 5,
                bindHost: async handle => { await session.updateMetadata(current => ({ ...current!, terminal: buildTerminalMetadataFromHostHandle(handle) })); },
                waitForRetirement: async handle => {
                    await nativeCompletion;
                    api.panes.delete('managed');
                    const adapter = createHerdrTerminalHostAdapter({ binary: 'herdr', sessionName: 'work',
                        actionTimeoutMs: 500, startupTimeoutMs: 500 });
                    const retired = await executeTerminalHostDisposition({ happyHomeDir, sessionId,
                        expectedAttachmentId: handle.attachmentId!, adapter,
                        intent: { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' } });
                    expect(retired.status).toBe('retired');
                    return true;
                },
            } });
            expect(result).toMatchObject({ ok: true });
            expect(attached).toBe(true);
            expect(api.requests.filter(request => request.method === 'layout.apply')).toHaveLength(1);
            expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({ args: ['attach', 'http://127.0.0.1:4312/', '--dir', happyHomeDir, '--session', 'native-session-one'] });
            expect(await readTerminalHostAttachmentInfo({ happyHomeDir, sessionId })).toBeNull();
            expect(session.sessionId).toBe(sessionId);
            } finally {
                if (nativeBoundary.child) {
                    nativeBoundary.child.kill('SIGTERM');
                    await nativeCompletion;
                }
            }
        }));
    });
    it.skipIf(process.platform === 'win32').each(['missing_lock', 'missing_metadata', 'malformed', 'foreign_terminal', 'replacement', 'unknown'] as const)(
      'keeps retained-host recovery fenced with %s evidence', async (evidence) => {
        await withTempDir('plugin-adopt-fence-', async happyHomeDir => await withHerdrApi(async api => {
            inventory.socketPath = api.socketPath;
            inventory.inheritedSpawns = 0;
            api.panes.add('original-provider');
            const sessionId = 'adoption-fence-session';
            const attachment = await writeTerminalHostAttachmentInfo({ happyHomeDir, sessionId, lifecycle: 'owned',
                handle: { kind: 'herdr', sessionName: 'work', socketPath: api.socketPath,
                    terminalId: 'original-provider', paneId: 'original-provider',
                    attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' } } });
            const lock = evidence === 'missing_lock' ? null
                : await acquireSessionRunnerLock({ happyHomeDir, sessionId, pid: process.pid });
            if (lock && !lock.ok) throw new Error('Could not admit fixture controller');
            let terminal = buildTerminalMetadataFromHostHandle(attachment.handle);
            if (evidence === 'malformed') {
                await writeFile(join(happyHomeDir, 'terminal', 'sessions', `${sessionId}.host.json`), '{');
            } else if (evidence === 'foreign_terminal' && terminal?.herdr) {
                terminal = { ...terminal, herdr: { ...terminal.herdr, terminalId: 'foreign-provider' } };
            } else if (evidence === 'replacement') {
                api.beforeResponse.set('pane.process_info', () => {
                    if (terminal?.herdr) terminal = { ...terminal, herdr: { ...terminal.herdr, terminalId: 'replacement-provider' } };
                });
            } else if (evidence === 'unknown') api.faults.set('pane.process_info', 'disconnect');
            const service = createDefaultPluginTerminalHostService({ happyHomeDir,
                hasCapability: capability => capability === 'terminalHost', readSessionId: () => sessionId,
                readSessionMetadata: () => evidence === 'missing_metadata' ? null : ({ startedBy: 'daemon', terminal }) });
            try {
                await expect(service.adoptExistingHost?.()).rejects.toMatchObject({ code: 'PLUGIN_TERMINAL_HOST_UNAVAILABLE' });
                expect(inventory.inheritedSpawns).toBe(0);
                expect(api.requests.some(request => request.method === 'layout.apply' || request.method === 'pane.close')).toBe(false);
                expect(api.panes.has('original-provider')).toBe(true);
            } finally { if (lock?.ok) await lock.release(); }
        }));
    });
    it.skipIf(process.platform === 'win32').each(['hook', 'statusline', 'foreign_hook', 'changed_preference'] as const)(
      'rebinds an explicit Claude resume to its exact retained owned host without starting another provider (%s)', async (observation) => {
        await withTempDir('plugin-adopt-retained-', async (happyHomeDir) => await withHerdrApi(async (api) => {
            inventory.socketPath = api.socketPath;
            inventory.inheritedSpawns = 0;
            inventory.startedServers = [];
            api.panes.add('original-provider');
            const sessionId = 'retained-claude-session';
            const attachment = await writeTerminalHostAttachmentInfo({
                happyHomeDir, sessionId, lifecycle: 'owned', handle: {
                    kind: 'herdr', sessionName: 'work', socketPath: api.socketPath,
                    terminalId: 'original-provider', paneId: 'original-provider',
                    attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
                },
            });
            const lock = await acquireSessionRunnerLock({ happyHomeDir, sessionId, pid: process.pid });
            if (!lock.ok) throw new Error('Could not admit the fixture controller');
            const hooks = createSessionHooksService({ happyHomeDir, hasCapability: capability => capability === 'sessionHooks' });
            const oldEndpoint = await hooks.startServer({ providerId: 'claude', sessionId,
                lifecycle: { kind: 'session', sessionId }, sessionHookSecret: 'retained-session-secret',
                permissionHookSecret: 'retained-permission-secret' });
            await oldEndpoint.dispose();
            const hostParams = {
                happyHomeDir, hasCapability: (capability: string) => capability === 'terminalHost', readSessionId: () => sessionId,
                readSessionMetadata: () => ({ startedBy: 'daemon' as const, terminal: buildTerminalMetadataFromHostHandle(attachment.handle) }),
            };
            const service = createDefaultPluginTerminalHostService(hostParams);
            const transcriptPath = join(happyHomeDir, 'same-native-provider-id.jsonl');
            await writeFile(transcriptPath, '');
            const operations = createClaudeUnifiedTerminalTurnOperations({
                ctx: createPluginContextFixture(service, createEventsFixture().service, {
                    sessionHooks: hooks, transcriptFileFollowAllowedPaths: [transcriptPath],
                }),
                directory: tmpdir(), happierSessionId: sessionId,
                hostPreference: observation === 'changed_preference' ? 'tmux' : 'herdr',
                launchEnv: { HAPPIER_CLAUDE_PATH: process.execPath }, permissionMode: 'default',
                launchIntent: { kind: 'resume_native', providerSessionId: 'same-native-provider-id' },
                knownProviderSession: { providerSessionId: 'same-native-provider-id', transcriptPath },
            });
            const providerEvents: Array<{ kind: string }> = [];
            let retainedObservationSettled!: () => void;
            const observationSettled = new Promise<void>(resolve => { retainedObservationSettled = resolve; });
            operations.subscribeProviderEvents(event => {
                providerEvents.push(event);
                if (event.kind === 'turn-cancelled') retainedObservationSettled();
            });
            try {
                await expect(operations.startProviderSession()).resolves.toMatchObject({
                    hostKind: 'herdr', hostSessionName: 'work', paneId: 'original-provider',
                });
                expect(inventory.inheritedSpawns).toBe(0);
                expect(api.requests.some(request => request.method === 'layout.apply' || request.method === 'pane.close')).toBe(false);
                expect(await readTerminalHostAttachmentInfo({ happyHomeDir, sessionId })).toEqual(attachment);
                // A surviving Claude process does not emit a new SessionStart.
                // Its authenticated primary observation, not the pane, proves the native ID.
                expect(operations.readProviderIdentity()).toEqual({ sessionId: null });
                const response = await fetch(`http://127.0.0.1:${oldEndpoint.port}/hook/${observation === 'statusline' ? 'statusline' : 'session-start'}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-happier-hook-secret': 'retained-session-secret' },
                    body: JSON.stringify({
                        session_id: observation === 'foreign_hook' ? 'foreign-native-id' : 'same-native-provider-id',
                        hook_event_name: 'PostToolUse', transcript_path: transcriptPath,
                    }),
                });
                expect(response.status).toBe(200);
                // Statusline transport intentionally ACKs before its consumer runs.
                if (observation !== 'foreign_hook') await observationSettled;
                expect(operations.readProviderIdentity()).toEqual({
                    sessionId: observation === 'foreign_hook' ? null : 'same-native-provider-id',
                });
                expect(providerEvents.filter(event => event.kind === 'turn-cancelled')).toHaveLength(
                    observation === 'foreign_hook' ? 0 : 1,
                );
            } finally {
                await operations.disposeProviderSession('runtime_recovery');
                await lock.release();
                const layout = api.requests.find(request => request.method === 'layout.apply');
                const root = layout?.params.root as { command?: string[] } | undefined;
                const specPath = root?.command?.[2];
                if (specPath) { await unlink(specPath).catch(() => {}); await rmdir(dirname(specPath)).catch(() => {}); }
            }
        }));
    });

    it.skipIf(process.platform === 'win32').each(['borrowed', 'owned'] as const)(
        'refuses a metadata-recovered %s Herdr host on an unsupported running server before launching',
        async (lifecycle) => {
            await withTempDir('plugin-current-herdr-version-', async (happyHomeDir) => await withHerdrApi(async (api) => {
                inventory.socketPath = api.socketPath;
                inventory.inheritedSpawns = 0;
                inventory.startedServers = [];
                api.setServerVersion('0.9.1');
                api.panes.add('original-pane');
                const sessionId = 'session-recovered-version';
                const attachment = await writeTerminalHostAttachmentInfo({
                    happyHomeDir, sessionId, lifecycle,
                    handle: {
                        kind: 'herdr', sessionName: 'work', socketPath: api.socketPath,
                        terminalId: 'original-pane', paneId: 'original-pane',
                        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
                    },
                });
                const service = createDefaultPluginTerminalHostService({
                    happyHomeDir, hasCapability: (capability) => capability === 'terminalHost', readSessionId: () => sessionId,
                    currentTerminalMetadata: {
                        terminal: buildTerminalMetadataFromRuntimeFlags({
                            mode: 'herdr', herdrSessionName: 'work', herdrSocketPath: api.socketPath,
                            herdrTerminalId: 'original-pane', herdrPaneId: 'original-pane', attachmentId: attachment.attachmentId,
                        }),
                        startedBy: 'terminal',
                    },
                });
                await expect(service.createOrAttachHost({
                    preference: 'herdr', sessionName: 'recovered-agent-label', workingDirectory: tmpdir(), isolatedEnv: true,
                    launch: { kind: 'agent-cli', agentId: 'claude', args: ['--version'], env: { HAPPIER_CLAUDE_PATH: process.execPath } },
                })).rejects.toMatchObject({ code: 'unsupported_server_version' });
                expect(inventory.inheritedSpawns).toBe(0);
                expect(inventory.startedServers).toEqual([]);
                expect(api.requests.some((request) => request.method === 'layout.apply' || request.method === 'pane.close')).toBe(false);
                expect([...api.panes]).toEqual(['original-pane']);
                await expect(readTerminalHostAttachmentInfo({ happyHomeDir, sessionId })).resolves.toEqual(attachment);
            }));
        },
    );

    it.skipIf(process.platform === 'win32').each([
        { hasCurrentFlags: false, requestedSessionName: 'default', expectedSessionName: 'work' },
        { hasCurrentFlags: false, requestedSessionName: 'explicit', expectedSessionName: 'explicit' },
        { hasCurrentFlags: true, requestedSessionName: 'default', expectedSessionName: 'work' },
    ])('uses verified placement and namespace precedence for $requestedSessionName with inherited flags=$hasCurrentFlags', async ({ hasCurrentFlags, requestedSessionName, expectedSessionName }) => {
        await withTempDir('plugin-current-terminal-', async (happyHomeDir) => await withHerdrApi(async (api) => {
            inventory.socketPath = api.socketPath;
            inventory.inheritedSpawns = 0;
            inventory.startedServers = [];
            const originalPane = hasCurrentFlags ? 'managed' : 'old-user-pane';
            api.panes.add(originalPane);
            const attachment = await writeTerminalHostAttachmentInfo({
                happyHomeDir, sessionId: 'session-existing-terminal', lifecycle: 'borrowed',
                handle: {
                    kind: 'herdr', sessionName: 'work', socketPath: api.socketPath,
                    terminalId: hasCurrentFlags ? 'terminal_1' : originalPane, paneId: originalPane,
                    attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
                },
            });
            const currentRuntime = hasCurrentFlags ? await resolveInheritedHerdrRuntime({
                terminalRuntime: { mode: 'herdr', herdrSessionName: 'work', attachmentId: attachment.attachmentId },
                env: { HERDR_ENV: '1', HERDR_SOCKET_PATH: api.socketPath, HERDR_PANE_ID: originalPane },
            }) : null;
            const service = createDefaultPluginTerminalHostService({
                happyHomeDir, hasCapability: (capability) => capability === 'terminalHost',
                readSessionId: () => 'session-existing-terminal',
                ...(currentRuntime ? { currentTerminalMetadata: {
                    terminal: buildTerminalMetadataFromRuntimeFlags(currentRuntime), startedBy: 'terminal' as const,
                } } : {}),
            });
            let handle: Awaited<ReturnType<typeof service.createOrAttachHost>> | null = null;
            try {
                const request = {
                    preference: 'herdr' as const, sessionName: requestedSessionName, label: 'happier-claude-recovered', workingDirectory: tmpdir(), isolatedEnv: true,
                    launch: { kind: 'agent-cli' as const, agentId: 'claude', args: ['--version'], env: { HAPPIER_CLAUDE_PATH: process.execPath } },
                };
                handle = await service.createOrAttachHost(request);
                expect(handle.sessionName).toBe(expectedSessionName);
                expect(inventory.startedServers).toEqual([]);
                expect(inventory.inheritedSpawns).toBe(hasCurrentFlags ? 1 : 0);
                expect(api.requests.filter((request) => request.method === 'layout.apply')).toHaveLength(hasCurrentFlags ? 0 : 1);
                expect(api.panes.has(originalPane)).toBe(true);
                await expect(readTerminalHostAttachmentInfo({ happyHomeDir, sessionId: 'session-existing-terminal' })).resolves.toMatchObject({
                    version: hasCurrentFlags ? 3 : 2,
                });
            } finally {
                if (handle) await service.dispose(handle, { kind: 'destroy_owned_host', reason: 'session_closed' });
                const layout = api.requests.find((request) => request.method === 'layout.apply');
                const root = layout?.params.root as { command?: string[] } | undefined;
                const specPath = root?.command?.[2];
                if (specPath) {
                    await unlink(specPath).catch(() => {});
                    await rmdir(dirname(specPath)).catch(() => {});
                }
            }
        }));
    });

    it.skipIf(process.platform === 'win32')('creates standalone Claude panes in the default Herdr server with the generated agent label', async () => {
        await withTempDir('plugin-default-herdr-', async (happyHomeDir) => await withHerdrApi(async (api) => {
            inventory.socketPath = api.socketPath;
            inventory.startedServers = [];
            const sessionId = 'standalone-claude-grouping';
            const service = createDefaultPluginTerminalHostService({
                happyHomeDir, hasCapability: (capability) => capability === 'terminalHost', readSessionId: () => sessionId,
            });
            const operations = createClaudeUnifiedTerminalTurnOperations({
                ctx: createPluginContextFixture(service, createEventsFixture().service),
                directory: tmpdir(), happierSessionId: sessionId, hostPreference: 'herdr',
                launchEnv: { HAPPIER_CLAUDE_PATH: process.execPath }, permissionMode: 'default',
            });
            try {
                await expect(operations.startProviderSession()).resolves.toMatchObject({ hostKind: 'herdr', hostSessionName: 'default' });
                expect(inventory.startedServers).toEqual([]);
                expect(api.requests.find((request) => request.method === 'layout.apply')?.params).toMatchObject({
                    tab_label: `happier-claude-${sessionId}`, root: { label: `happier-claude-${sessionId}` },
                });
                await expect(readTerminalHostAttachmentInfo({ happyHomeDir, sessionId })).resolves.toMatchObject({
                    version: 2, handle: { kind: 'herdr', sessionName: 'default' },
                });
            } finally {
                await operations.disposeProviderSession('session_closed');
                const layout = api.requests.find((request) => request.method === 'layout.apply');
                const root = layout?.params.root as { command?: string[] } | undefined;
                const specPath = root?.command?.[2];
                if (specPath) {
                    await unlink(specPath).catch(() => {});
                    await rmdir(dirname(specPath)).catch(() => {});
                }
            }
        }));
    });

    it('retains persistence and host cleanup failures when a created pane cannot be stopped', async () => {
        await withHerdrApi(async (api) => {
            inventory.socketPath = api.socketPath;
            api.faults.set('pane.close', 'error');
            const adapter = createHerdrTerminalHostAdapter({
                binary: 'herdr', sessionName: 'work', actionTimeoutMs: 500, startupTimeoutMs: 500,
            });
            const service = createPluginTerminalHostService({
                hasCapability: (capability) => capability === 'terminalHost',
                resolveTerminalHost: (preference) => resolveTerminalHost({
                    preference, platform: { os: 'linux', arch: process.arch }, adapters: { herdr: adapter },
                    tmuxAvailable: false, zellijAvailable: false,
                }),
                resolveAgentCliLaunch: (launch) => requireAgentCliLaunchSpec(launch.agentId, {
                    processEnv: { HAPPIER_CLAUDE_PATH: process.execPath },
                }),
                // The socket cannot be a directory: exercise the real attachment filesystem owner.
                onHostCreated: async (handle) => {
                    await writeTerminalHostAttachmentInfo({ happyHomeDir: api.socketPath, sessionId: 'test-session', handle });
                },
                disposeHost: async ({ handle }) => await adapter.dispose(handle),
            });
            try {
                const error = await service.createOrAttachHost({
                    preference: 'herdr', sessionName: 'work', workingDirectory: tmpdir(), isolatedEnv: true,
                    launch: { kind: 'agent-cli', agentId: 'claude', args: ['--version'] },
                }).catch((failure: unknown) => failure);
                expect(error).toBeInstanceOf(AggregateError);
                expect(error).toMatchObject({
                    errors: [expect.objectContaining({ code: 'ENOTDIR' }), expect.objectContaining({ code: 'pane.close_failed' })],
                });
                expect([...api.panes]).toEqual(['managed']);
            } finally {
                const layout = api.requests.find((request) => request.method === 'layout.apply');
                const root = layout?.params.root as { command?: string[] } | undefined;
                const specPath = root?.command?.[2];
                if (specPath) {
                    await unlink(specPath).catch(() => {});
                    await rmdir(dirname(specPath)).catch(() => {});
                }
            }
        });
    });
});
