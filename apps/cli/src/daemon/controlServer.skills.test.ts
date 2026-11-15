import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, onTestFinished, vi } from 'vitest';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { createSkillStore, EnsureSkillSessionDirResultSchema } from '@/prompts/skills/store/skillStore';
import { createDaemonControlApp } from './controlServer';
import { listSessionMarkers, readSessionMarker } from './sessionRegistry';
import { configuration } from '@/configuration';
import type { TrackedSession } from './types';
import { createOnChildExited } from './sessions/onChildExited';
import { createOnHappySessionWebhook, registerExternalSessionIdentity } from './sessions/onHappySessionWebhook';
import { startDaemonHeartbeatLoop } from './lifecycle/heartbeat';
import { spawnInlineNodeTestProcess } from '@/testkit/process/spawn';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { once } from 'node:events';
import fastify from 'fastify';
import axios from 'axios';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveRunnerSkills, type ResolveRunnerSkillsInput } from '@/prompts/skills/runtime/resolveRunnerSkills';
import type { SkillArtifactStore } from '@/prompts/skills/library/readSkillLibraryContent';
import type { AccountArtifact } from '@/api/artifacts/accountArtifactStore';
import { ensureSkillSessionDirHttp } from './controlClient';
import { SkillSessionDirControlRequestSchema } from '@/prompts/skills/store/controlRoutes';
import { writeDaemonState } from '@/persistence';
import * as processCensus from '@/processes/census/processCensus';
import { legacyPidSessionTrackingKey, trackedSessionForSingleSessionProcess, trackedSessionsForProcess, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

// Production registration mints Session keys; these tests address the Session by its host pid.
const markersForProcess = async (pid: number) => (await listSessionMarkers()).filter(marker => marker.pid === pid);

const filesystemBoundary = vi.hoisted(() => ({
    observeWrite: undefined as ((file: Parameters<typeof import('node:fs/promises').writeFile>[0],
        completion: Promise<void>) => void) | undefined,
}));

// Observe the real filesystem boundary without replacing registration or exit logic.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, writeFile: (...args: Parameters<typeof actual.writeFile>) => {
        const completion = actual.writeFile(...args);
        filesystemBoundary.observeWrite?.(args[0], completion);
        return completion;
    } };
});

it('serves the real authenticated skill store and rejects unknown authority fields', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-impl-p3b-store-control-'));
    const skillStore = createSkillStore({ happyHomeDir });
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine-one',
        stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'secret', skillStore });
    const files = [{ path: 'SKILL.md', contentKind: 'utf8' as const, contentBase64: Buffer.from('Route-delivered skill').toString('base64') }];
    const payload = { ownerKey: 'session-one', items: [{ skillId: 'guide', name: 'guide', sourceFolderName: 'source-guide', files,
        digest: computePromptBundleDigestV1({ v: 1, entries: files, createdAtMs: 0, updatedAtMs: 0 }) }], nativeDisables: [] };
    try {
        expect((await app.inject({ method: 'POST', url: '/skills/session-dir', payload })).statusCode).toBe(401);
        const accepted = await app.inject({ method: 'POST', url: '/skills/session-dir', headers: { 'x-happier-daemon-token': 'secret' }, payload });
        expect(accepted.statusCode).toBe(200);
        const delivery = EnsureSkillSessionDirResultSchema.parse(accepted.json());
        expect(delivery.failed).toEqual([]);
        expect(delivery.items).toEqual([{ skillId: 'guide', name: 'guide', digest: payload.items[0]!.digest,
          directory: join(delivery.skillsRoot, 'source-guide') }]);
        expect(await readFile(join(delivery.items[0]!.directory, 'SKILL.md'), 'utf8')).toBe('Route-delivered skill');
        const rejected = await app.inject({ method: 'POST', url: '/skills/session-dir', headers: { 'x-happier-daemon-token': 'secret' }, payload: { ...payload, force: true } });
        expect(rejected.statusCode).toBe(400);
        const traversal = await app.inject({ method: 'POST', url: '/skills/session-dir', headers: { 'x-happier-daemon-token': 'secret' }, payload: { ...payload, ownerKey: '../escape' } });
        expect(traversal.statusCode).toBe(400);
    } finally {
        await app.close();
        const writable = async (path: string): Promise<void> => {
            const info = await lstat(path); if (info.isSymbolicLink()) return;
            await chmod(path, info.isDirectory() ? 0o755 : 0o644);
            if (info.isDirectory()) for (const name of await readdir(path)) await writable(join(path, name));
        };
        await writable(happyHomeDir);
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});

it('tracks foreground identity before report and removes its Session and Runs through existing heartbeat exit cleanup', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-impl-p3b-store-foreground-'));
    const homeDescriptor = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
    const serverDescriptor = Object.getOwnPropertyDescriptor(configuration, 'activeServerDir')!;
    Object.defineProperty(configuration, 'happyHomeDir', { ...homeDescriptor, value: happyHomeDir });
    Object.defineProperty(configuration, 'activeServerDir', { ...serverDescriptor, value: join(happyHomeDir, 'servers', 'fixture') });
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    const childExit = once(child, 'exit');
    const pid = child.pid!;
    const sessions = new Map<SessionTrackingKey, TrackedSession>();
    const skillStore = createSkillStore({ happyHomeDir, readLibraryDigests: async () => [] });
    const metadata = createTestMetadata({ path: happyHomeDir, happyHomeDir, hostPid: pid, startedBy: 'terminal' });
    const ordinaryReport = createOnHappySessionWebhook({ trackedSessionsByKey: sessions, spawnAwaiterByKey: new Map() });
    const app = createDaemonControlApp({ getChildren: () => [...sessions.values()], trackedSessionsByKey: sessions,
        machineId: 'machine-one', stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }), requestShutdown: () => {},
        onHappySessionWebhook: ordinaryReport, controlToken: 'secret', skillStore });
    let restoreInterval = () => {};
    try {
        const response = await app.inject({ method: 'POST', url: '/skills/session-dir',
            headers: { 'x-happier-daemon-token': 'secret' }, payload: {
                ownerKey: 'foreground-session', items: [], nativeDisables: [], startupIdentity: { pid, metadata },
            } });
        expect(response.statusCode).toBe(200);
        const tracked = trackedSessionForSingleSessionProcess(sessions, pid)!;
        expect(tracked.happySessionId).toBe('foreground-session');
        expect((await readSessionMarker(tracked.trackingKey))?.happySessionId).toBe('foreground-session');
        await ordinaryReport('foreground-session', metadata);
        await tracked.sessionMarkerPersistence;
        expect(trackedSessionForSingleSessionProcess(sessions, pid)).toBe(tracked);
        const wrongResolverIdentity = await app.inject({ method: 'POST', url: '/skills/session-dir',
            headers: { 'x-happier-daemon-token': 'secret' }, payload: {
                ownerKey: 'foreground-session/runs/run-one', items: [], nativeDisables: [],
                startupIdentity: { pid: process.pid, metadata },
            } });
        expect(wrongResolverIdentity.statusCode).toBe(503);
        expect(trackedSessionsForProcess(sessions, process.pid)).toEqual([]);
        const run = await app.inject({ method: 'POST', url: '/skills/session-dir',
            headers: { 'x-happier-daemon-token': 'secret' }, payload: {
                ownerKey: 'foreground-session/runs/run-one', items: [], nativeDisables: [], startupIdentity: { pid, metadata },
            } });
        expect(run.statusCode).toBe(200);
        expect(trackedSessionsForProcess(sessions, process.pid)).toEqual([]);
        const exited = createOnChildExited({ trackedSessionsByKey: sessions, spawnResourceCleanupByKey: new Map(),
            sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null, skillStore });
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        restoreInterval = () => { vi.useRealTimers(); };
        startDaemonHeartbeatLoop({ trackedSessionsByKey: sessions, spawnResourceCleanupByKey: new Map(),
            sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null, onChildExited: exited,
            fileState: { pid: process.pid, httpPort: 8765, startedAt: Date.now(),
                startedWithCliVersion: configuration.currentCliVersion, daemonLogPath: join(happyHomeDir, 'daemon.log') },
            currentCliVersion: configuration.currentCliVersion });
        child.kill(); await childExit;
        await vi.advanceTimersToNextTimerAsync();
        await vi.waitFor(() => expect(sessions.size).toBe(0));
        await expect(lstat(join(happyHomeDir, 'skills', 'sessions', 'foreground-session'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
        restoreInterval();
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await childExit; }
        await app.close(); await skillStore.releaseSkillSessionDirs('foreground-session');
        Object.defineProperty(configuration, 'happyHomeDir', homeDescriptor);
        Object.defineProperty(configuration, 'activeServerDir', serverDescriptor);
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});

it('releases a fresh startup folder on failure before the readiness webhook', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-impl-p3b-store-startup-'));
    const pid = 424242;
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: `PID-${pid}`,
        spawnOptions: { directory: happyHomeDir } };
    const sessions = new Map([[tracked.trackingKey, tracked]]);
    const skillStore = createSkillStore({ happyHomeDir, readLibraryDigests: async () => [] });
    let ready = false;
    const app = createDaemonControlApp({ getChildren: () => [...sessions.values()], machineId: 'machine-one',
        stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => { ready = true; }, controlToken: 'secret', skillStore });
    try {
        const result = await app.inject({ method: 'POST', url: '/skills/session-dir',
            headers: { 'x-happier-daemon-token': 'secret' }, payload: {
                ownerKey: 'fresh-session', items: [], nativeDisables: [],
                startupIdentity: { pid, metadata: { hostPid: pid, startedBy: 'daemon', path: happyHomeDir } },
            } });
        expect(result.statusCode).toBe(200);
        expect(tracked.happySessionId).toBe('fresh-session');
        expect(ready).toBe(false);
        const exited = createOnChildExited({ trackedSessionsByKey: sessions, spawnResourceCleanupByKey: new Map(),
            sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null,
            removeSessionMarkerFn: async () => {}, skillStore });
        await exited(pid, { reason: 'startup-failed', code: 1, signal: null });
        await expect(lstat(join(happyHomeDir, 'skills', 'sessions', 'fresh-session'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
        await app.close();
        await skillStore.releaseSkillSessionDirs('fresh-session');
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});

it.each(['registered', 'untracked index parent'] as const)('does not recreate an exited parent folder from an already-issued Session-owned Run ensure (%s)', async parentMode => {
    // Home transport reports an observed empty Project association; resolution,
    // skill planning and daemon materialization continue through their real owners.
    const projectMode = vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        throw new Error(`Unexpected skill preparation Home read: ${String(url)}`);
    });
    const projectRows = vi.spyOn(axios, 'post').mockImplementation(async url => {
        if (String(url).endsWith(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`)) return { status: 200,
            data: ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [] }) };
        throw new Error(`Unexpected skill preparation Home write: ${String(url)}`);
    });
    onTestFinished(() => { projectMode.mockRestore(); projectRows.mockRestore(); withdrawActiveProjectAccountRowsSnapshot(); });
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-impl-p3b-store-late-run-'));
    const homeDescriptor = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
    const serverDescriptor = Object.getOwnPropertyDescriptor(configuration, 'activeServerDir')!;
    const stateDescriptor = Object.getOwnPropertyDescriptor(configuration, 'daemonStateFile')!;
    Object.defineProperty(configuration, 'happyHomeDir', { ...homeDescriptor, value: happyHomeDir });
    Object.defineProperty(configuration, 'activeServerDir', { ...serverDescriptor, value: join(happyHomeDir, 'servers', 'fixture') });
    Object.defineProperty(configuration, 'daemonStateFile', { ...stateDescriptor, value: join(happyHomeDir, 'daemon.state.json') });
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    const childExit = once(child, 'exit');
    const pid = child.pid!;
    const sessions = new Map<SessionTrackingKey, TrackedSession>();
    const skillStore = createSkillStore({ happyHomeDir, readLibraryDigests: async () => [] });
    const metadata = createTestMetadata({ path: happyHomeDir, happyHomeDir, hostPid: pid, startedBy: 'terminal' });
    const ordinaryReport = createOnHappySessionWebhook({ trackedSessionsByKey: sessions, spawnAwaiterByKey: new Map() });
    const app = createDaemonControlApp({ getChildren: () => [...sessions.values()], trackedSessionsByKey: sessions,
        machineId: 'machine-one', stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }), requestShutdown: () => {},
        onHappySessionWebhook: ordinaryReport, controlToken: 'secret', skillStore });
    const forwarder = fastify();
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>(resolve => { releaseRequest = resolve; });
    let observeIssued!: () => void;
    const issued = new Promise<void>(resolve => { observeIssued = resolve; });
    let pending: ReturnType<typeof resolveRunnerSkills> | undefined;
    let retirement: Promise<void> | undefined;
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let observeCleanup!: () => void;
    const cleanupStarted = new Promise<void>(resolve => { observeCleanup = resolve; });
    let pendingResponseStatus: number | undefined;
    let pendingRequest: ReturnType<typeof SkillSessionDirControlRequestSchema.parse> | undefined;
    let parentWasLiveWhenIssued = false;
    let deliveredRunIdentity: ReturnType<typeof SkillSessionDirControlRequestSchema.parse>['startupIdentity'];
    const artifact: AccountArtifact = {
        artifactId: 'library', ownerAccountId: 'account', access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 },
        seq: 1, createdAt: 1, updatedAt: 1,
        header: { v: 1, kind: 'prompt_bundle.v2', title: 'Guide', bundleSchemaId: 'skills.skill_md_v1' },
        body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
            { path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from('---\nname: guide\ndescription: Guide\n---\nRun body').toString('base64') },
            { path: 'references/note.md', contentKind: 'utf8', contentBase64: Buffer.from('Run supporting file').toString('base64') },
        ] }),
    };
    // Account Artifact persistence is external I/O; plan, body parsing, native
    // scan, resolver, HTTP client, daemon route, store and exit owner stay real.
    const artifacts: SkillArtifactStore = {
        list: async () => ({ items: [{ ...artifact, headerVersion: artifact.revision.headerVersion,
            bodyVersion: artifact.revision.bodyVersion }], coverage: 'complete' }), read: async () => artifact,
    };
    try {
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Missing daemon loopback address');
        forwarder.post('/skills/session-dir', async (request, reply) => {
            const body = SkillSessionDirControlRequestSchema.parse(request.body);
            if (body.ownerKey === 'late-parent/runs/live-run') deliveredRunIdentity = body.startupIdentity;
            if (body.ownerKey === 'late-parent/runs/pending-run') {
                pendingRequest = body;
                parentWasLiveWhenIssued = trackedSessionsForProcess(sessions, pid).length > 0 && child.exitCode === null && child.signalCode === null;
                observeIssued();
                // Hold an actual HTTP request already emitted by the resolver,
                // not a new synthetic request manufactured after parent exit.
                await requestGate;
            }
            const response = await fetch(`http://127.0.0.1:${address.port}/skills/session-dir`, {
                method: 'POST', headers: { 'content-type': 'application/json', 'x-happier-daemon-token': 'secret' },
                body: JSON.stringify(body),
            });
            if (body.ownerKey === 'late-parent/runs/pending-run') pendingResponseStatus = response.status;
            return reply.code(response.status).type('application/json').send(await response.text());
        });
        await forwarder.listen({ host: '127.0.0.1', port: 0 });
        const forwardingAddress = forwarder.server.address();
        if (!forwardingAddress || typeof forwardingAddress === 'string') throw new Error('Missing forwarding loopback address');
        const target = { pid: process.pid, httpPort: forwardingAddress.port, controlToken: 'secret' };
        writeDaemonState({ ...target, startedAt: Date.now(), startedWithCliVersion: configuration.currentCliVersion });
        const input: ResolveRunnerSkillsInput = {
            ownerKey: 'late-parent/runs/live-run', agentId: 'test', machineId: 'machine-one', directory: happyHomeDir, home: happyHomeDir,
            credentials: { token: 'token', encryption: null }, sessionMetadata: metadata, agentHasActionChannel: true,
            contributes: { catalogEntriesById: { test: { skills: { delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'supported' } } } },
            isCurrent: () => child.exitCode === null && child.signalCode === null && trackedSessionForSingleSessionProcess(sessions, pid)?.reportMarkerCustody?.retiring !== true,
            accountSnapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
                promptLibraryCatalog: { status: 'ready', rows: [{ revision: 1, record: { key: 'skill-rules', value: { v: 1, rules: [
                    { id: 'everywhere', skillId: 'library', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 },
                    // This lifecycle scenario isolates the Account skill; the built-in
                    // happier skill's default delivery has dedicated coverage.
                    { id: 'core-off', skillId: 'happier:happier', target: { t: 'allMachines' }, enabled: false, createdAt: 1, updatedAt: 1 },
                ] } } }], tombstones: [], diagnostics: [] } },
        };
        const parentIndex = await resolveRunnerSkills({ ...input, ownerKey: 'late-parent', contributes: { catalogEntriesById: {} } }, { artifacts });
        expect(parentIndex.plan.plan).toBe('index');
        expect(sessions.size).toBe(0);
        if (parentMode === 'registered') {
            await ensureSkillSessionDirHttp({ ownerKey: 'late-parent', items: [], nativeDisables: [] }, { target }, { pid, metadata });
        }
        const transports = { artifacts };
        const live = await resolveRunnerSkills(input, transports);
        expect(live.unavailable).toBeUndefined();
        expect(live.delivery?.items).toEqual([expect.objectContaining({ skillId: 'library', name: 'guide' })]);
        expect(await readFile(join(live.delivery!.skillsRoot, 'guide', 'references', 'note.md'), 'utf8')).toBe('Run supporting file');
        expect(deliveredRunIdentity?.pid).toBe(pid);
        expect(deliveredRunIdentity?.metadata.path).toBe(metadata.path);
        const tracked = trackedSessionForSingleSessionProcess(sessions, pid)!;
        expect(tracked).toBeDefined();
        expect(tracked.happySessionId).toBe('late-parent');
        await ordinaryReport('late-parent', metadata);
        await tracked.sessionMarkerPersistence;
        expect(trackedSessionForSingleSessionProcess(sessions, pid)).toBe(tracked);
        pending = resolveRunnerSkills({ ...input, ownerKey: 'late-parent/runs/pending-run' }, transports);
        await issued;
        expect(parentWasLiveWhenIssued).toBe(true);
        const exited = createOnChildExited({ trackedSessionsByKey: sessions,
            // OS resource teardown is an external boundary. Keep retirement
            // in progress while the previously emitted request reaches HTTP.
            spawnResourceCleanupByKey: new Map([[tracked.trackingKey, async () => { observeCleanup(); await cleanupGate; }]]),
            sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null, skillStore });
        child.kill(); await childExit;
        retirement = exited(pid, { reason: 'process-missing', code: null, signal: null });
        await cleanupStarted;
        expect(tracked.reportMarkerCustody?.retiring).toBe(true);
        const parentFolder = join(happyHomeDir, 'skills', 'sessions', 'late-parent');
        releaseRequest();
        const retired = await pending;
        expect(retired.unavailable).toBe(true);
        expect(retired.delivery).toBeUndefined();
        expect(pendingResponseStatus).toBe(503);
        await expect(lstat(join(parentFolder, 'runs', 'pending-run'))).rejects.toMatchObject({ code: 'ENOENT' });
        releaseCleanup(); await retirement;
        expect(trackedSessionsForProcess(sessions, pid)).toEqual([]);
        await expect(lstat(parentFolder)).rejects.toMatchObject({ code: 'ENOENT' });
        // Repeat the real producer's exact payload after retirement removes
        // the tracker, not a differently shaped hand-built request.
        expect(pendingRequest).toBeDefined();
        const afterExit = await app.inject({ method: 'POST', url: '/skills/session-dir',
            headers: { 'x-happier-daemon-token': 'secret' }, payload: pendingRequest });
        expect(afterExit.statusCode).toBe(503);
        await expect(lstat(parentFolder)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
        releaseRequest(); releaseCleanup();
        await pending?.catch(() => undefined);
        await retirement?.catch(() => undefined);
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await childExit; }
        await forwarder.close(); await app.close();
        await skillStore.releaseSkillSessionDirs('late-parent');
        await skillStore.collectSkillCache({ libraryDigests: [] });
        Object.defineProperty(configuration, 'happyHomeDir', homeDescriptor);
        Object.defineProperty(configuration, 'activeServerDir', serverDescriptor);
        Object.defineProperty(configuration, 'daemonStateFile', stateDescriptor);
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});

it('does not register a dead native-materialization parent or overwrite its retained identity marker', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-impl-p3b-store-dead-parent-'));
    const homeDescriptor = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
    const serverDescriptor = Object.getOwnPropertyDescriptor(configuration, 'activeServerDir')!;
    Object.defineProperty(configuration, 'happyHomeDir', { ...homeDescriptor, value: happyHomeDir });
    Object.defineProperty(configuration, 'activeServerDir', { ...serverDescriptor, value: join(happyHomeDir, 'servers', 'fixture') });
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    const childExit = once(child, 'exit');
    const pid = child.pid!;
    const sessions = new Map<SessionTrackingKey, TrackedSession>();
    const metadata = createTestMetadata({ path: happyHomeDir, happyHomeDir, hostPid: pid, startedBy: 'terminal' });
    try {
        const live = await registerExternalSessionIdentity({ trackedSessionsByKey: sessions, pid, sessionId: 'index-parent', metadata });
        expect(live).not.toBeNull();
        const marker = await readSessionMarker(live!.trackingKey);
        expect(marker?.happySessionId).toBe('index-parent');
        expect(marker?.processStartTimeMs).toBeDefined();
        expect(await registerExternalSessionIdentity({ trackedSessionsByKey: sessions, pid, sessionId: 'index-parent',
            metadata: { ...metadata, hostProcessStartTimeMs: marker!.processStartTimeMs! + 60_000 } })).toBeNull();
        expect(await readSessionMarker(live!.trackingKey)).toEqual(marker);
        child.kill(); await childExit;
        const dead = await registerExternalSessionIdentity({ trackedSessionsByKey: sessions, pid, sessionId: 'index-parent', metadata });
        expect(dead).toBeNull();
        expect(trackedSessionForSingleSessionProcess(sessions, pid)).toBe(live);
        expect(await readSessionMarker(live!.trackingKey)).toEqual(marker);
        const untracked = new Map<SessionTrackingKey, TrackedSession>();
        expect(await registerExternalSessionIdentity({ trackedSessionsByKey: untracked, pid, sessionId: 'index-parent', metadata })).toBeNull();
        expect(untracked.size).toBe(0);
        expect(await readSessionMarker(live!.trackingKey)).toEqual(marker);
    } finally {
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await childExit; }
        Object.defineProperty(configuration, 'happyHomeDir', homeDescriptor);
        Object.defineProperty(configuration, 'activeServerDir', serverDescriptor);
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});

it('keeps native registration inside exit custody while the OS observation is pending', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-impl-p3b-store-pending-parent-'));
    const homeDescriptor = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
    const serverDescriptor = Object.getOwnPropertyDescriptor(configuration, 'activeServerDir')!;
    Object.defineProperty(configuration, 'happyHomeDir', { ...homeDescriptor, value: happyHomeDir });
    Object.defineProperty(configuration, 'activeServerDir', { ...serverDescriptor, value: join(happyHomeDir, 'servers', 'fixture') });
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    const childExit = once(child, 'exit');
    const pid = child.pid!;
    const sessions = new Map<SessionTrackingKey, TrackedSession>();
    const exitReportPath = join(happyHomeDir, 'logs', 'session-exit', `session-pending-parent-pid-${pid}.json`);
    let observeExitReportWrite!: (completion: Promise<void>) => void;
    const exitReportWrite = new Promise<{ completion: Promise<void> }>(resolve => {
        observeExitReportWrite = completion => resolve({ completion });
    });
    let releaseSample!: () => void;
    const sampleGate = new Promise<void>(resolve => { releaseSample = resolve; });
    let observeSample!: () => void;
    const sampled = new Promise<void>(resolve => { observeSample = resolve; });
    const readCensus = processCensus.readProcessCensus;
    let restoreCensusBoundary = () => {};
    let registration: ReturnType<typeof registerExternalSessionIdentity> | undefined;
    let retirement: Promise<void> | undefined;
    try {
        // The exit owner intentionally publishes diagnostics asynchronously. Join
        // this owned filesystem write before removing its temporary destination.
        filesystemBoundary.observeWrite = (file, completion) => {
            if (file === exitReportPath) observeExitReportWrite(completion);
        };
        // Hold a real OS-adapter observation, not registration or lifecycle logic.
        const boundary = vi.spyOn(processCensus, 'readProcessCensus').mockImplementation(async request => {
            const snapshot = await readCensus(request);
            if (request?.pids?.includes(pid)) { observeSample(); await sampleGate; }
            return snapshot;
        });
        restoreCensusBoundary = () => { boundary.mockRestore(); };
        registration = registerExternalSessionIdentity({ trackedSessionsByKey: sessions, pid, sessionId: 'pending-parent',
            metadata: createTestMetadata({ path: happyHomeDir, happyHomeDir, hostPid: pid, startedBy: 'terminal' }) });
        await sampled;
        child.kill(); await childExit;
        const exited = createOnChildExited({ trackedSessionsByKey: sessions, spawnResourceCleanupByKey: new Map(),
            sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null });
        retirement = exited(pid, { reason: 'process-missing', code: null, signal: null });
        releaseSample();
        expect(await registration).toBeNull();
        await retirement;
        expect(sessions.size).toBe(0);
        expect(await markersForProcess(pid)).toEqual([]);
    } finally {
        releaseSample(); await registration?.catch(() => undefined); await retirement?.catch(() => undefined);
        try {
            if (retirement && trackedSessionsForProcess(sessions, pid).length === 0) await (await exitReportWrite).completion;
        } finally {
            filesystemBoundary.observeWrite = undefined;
            restoreCensusBoundary();
            if (child.exitCode === null && child.signalCode === null) { child.kill(); await childExit; }
            Object.defineProperty(configuration, 'happyHomeDir', homeDescriptor);
            Object.defineProperty(configuration, 'activeServerDir', serverDescriptor);
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    }
});
