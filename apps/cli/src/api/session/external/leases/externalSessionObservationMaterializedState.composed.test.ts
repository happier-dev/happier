import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { TrackedSession } from '@/daemon/types';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

it('authorizes only the external Agent state roots actually materialized for this Session, including marker adoption', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'observation-materialized-state-')));
    vi.stubEnv('HAPPIER_HOME_DIR', join(root, 'home'));
    vi.resetModules();
    const { createAuthoredAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    const { materializeConnectedServicesForSpawn } = await import('@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn');
    const { createConnectedAccountPurposeBindingOwner } = await import('@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner');
    const { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } = await import('@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn');
    const { readSessionMarker } = await import('@/daemon/sessionRegistry');
    const { createSpawnLifecycleCallbacks } = await import('@/daemon/spawn/createSpawnLifecycleCallbacks');
    const { persistAcceptedSpawnMarker } = await import('@/daemon/spawn/persistAcceptedSpawnMarker');
    const { readOrCreateDeviceLocalSecretStorage } = await import('@/daemon/deviceLocalSecretStorage');
    const { buildTrackedSessionFromMarker, readTrackedSessionMaterializedStateObservationBinding } = await import('@/daemon/sessions/trackedSessionFromMarker');
    const { createExternalSessionObservationDaemonProjection } = await import('./createExternalSessionObservationDaemonProjection');
    const { resolveExternalSessionObservationLinkInput } = await import('./resolveExternalSessionObservationLinkInput');
    const { validateExternalSessionObservationWatchFileChanges } = await import('@/session/external/observationFileSetPathValidation');
    const { acquireCanonicalExternalSessionFollowLease } = await import('./acquireCanonicalExternalSessionFollowLease');
    const { loadLinkedExternalSession } = await import('@/api/session/external/takeover/loadLinkedExternalSession');
    const { resolveExternalSessionSurfaceOps } = await import('@/session/actions/externalSessions/providerOpsResolution');
    const { buildSessionMetadataEnvelopeFields } = await import('@/session/metadata/buildSessionMetadataEnvelopeCreateFields');
    const { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } = await import('@/testkit/backends/sessionFixtures');
    const { installAxiosFastifyAdapter } = await import('@/testkit/http/axiosAdapter');
    const { resolveServerHttpBaseUrl } = await import('@/session/transport/http/serverHttpBaseUrl');
    const { SessionCurrentProjectionRecordV1Schema } = await import('@happier-dev/protocol');
    const pluginId = 'acme.materialized-observation';
    const localId = 'native';
    const manifest = {
        schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Materialized native observation',
        engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
        hostAccess: { required: [
            { id: 'workspace', capability: 'filesystem', reason: 'Read admitted source files', scope: { locations: [{ root: 'workspace' }], access: ['read'] } },
            { id: 'environment', capability: 'environment', reason: 'Bind native home', scope: { keys: ['ACME_NATIVE_HOME'] } },
        ], optional: [] },
        contributes: { agents: [{
            id: localId, title: 'Native fixture', runtime: { kind: 'custom' }, primary: 'sessions',
            connectedAccounts: [],
            capabilities: { surfaces: ['externalSessions'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
            surfaces: { externalSession: { sources: [{
                sourceKind: 'acme.native',
                schema: { fields: [{ name: 'kind', kind: 'literal', value: 'acme.native' }, { name: 'configDir', kind: 'string', min: 1, nullish: true }] },
                key: { segments: [{ kind: 'literal', value: 'acme.native' }, { kind: 'field', field: 'configDir' }] },
                instances: [{ kind: 'default', constants: {} }],
            }] } },
        }] },
    };
    const daemon = [
        "import { realpath } from 'node:fs/promises';",
        "import { join } from 'node:path';",
        "import { createRuntime, externalSessions } from './runner.mjs';",
        'export function activate(api) {',
        ' api.agents.register("native", createRuntime, { sessionRunnerFactory: { module: "./runner.mjs", export: "createRuntime", externalSessionsExport: "externalSessions", runtimeApiVersion: 1 }, connectedAccountLaunch: { stateSharingDescriptor: {',
        '  providerSupportStatus: "supported", nativeHome: { environmentKey: "ACME_NATIVE_HOME", defaultRelativePath: ".acme" },',
        '  config: { supported: true, modes: ["isolated"], entries: [] },',
        '  state: { supported: true, modes: ["isolated", "shared"], entries: [{ path: "state", mode: "linked" }], sharedStatePrivacyRiskAcknowledgementRequired: true, symlinkUnavailableDegradePolicy: "block_continuity" },',
        '  authIsolation: { mode: "materialized_home", secretEntries: [] }',
        ' } } });',
        ' api.agents.registerExternalSessions("native", externalSessions);',
        ' api.agents.registerExternalSessionObservation("native", {',
        '  describeResource: request => ({ resourceKey: "native-state", linkKey: request.remoteSessionId }),',
        '  observeResource: () => ({ dispose() {} }),',
        '  async reconcileResource(request) { return request.purpose === "resource_descriptors" ? { purpose: request.purpose, outcomes: await Promise.all(request.links.map(async link => ({ kind: "described", descriptor: { resourceKey: request.resourceKey, linkKey: link.linkKey, changeObservation: "watch_file_changes", watchFileChanges: { files: [await realpath(join(link.linkedSource.source.configDir, link.linkKey === "undeclared" ? "extra" : "state", link.linkKey + ".jsonl"))] } } }))) } : { purpose: request.purpose, outcomes: request.links.map(link => ({ linkKey: link.linkKey, facts: [] })) }; }',
        ' });',
        '}',
    ].join('\n');
    const runner = [
        "import { readFile } from 'node:fs/promises';",
        "import { join } from 'node:path';",
        'export async function createRuntime() { return { sessions: { async open() { throw new Error("Read-only source fixture cannot spawn a Session"); } } }; }',
        'const identity = request => ({ source: request.source, remoteSessionId: request.remoteSessionId, linkData: request.linkData ?? {} });',
        'export const externalSessions = {',
        ' resolveSource: request => ({ ok: true, value: { source: request.source } }),',
        ' listCandidates: () => ({ ok: true, value: { candidates: [], nextCursor: null } }),',
        ' resolveLinkIdentity: request => ({ ok: true, value: identity(request) }),',
        ' resolveLinkedIdentity: request => ({ ok: true, value: identity(request) }),',
        ' async pageTranscript(request) { try { const text = await readFile(join(request.source.configDir, "state", request.remoteSessionId + ".jsonl"), "utf8"); return { ok: true, value: { items: text.trim().split("\\n").map((line, index) => ({ id: "source-row-" + index, createdAtMs: 1000, raw: JSON.parse(line) })), nextCursor: null, tailCursor: "tail:" + Buffer.byteLength(text), hasMore: false } }; } catch (error) { return { ok: false, code: "agent_error", message: error.message }; } },',
        ' async readAfterTranscript(request) { const text = await readFile(join(request.source.configDir, "state", request.remoteSessionId + ".jsonl"), "utf8"); return { ok: true, value: { outcome: request.cursor === "tail:" + Buffer.byteLength(text) ? "already_current" : "gap_or_cursor_expired" } }; }',
        '};',
    ].join('\n');
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
        controller: pluginReloadController, plugins: [{ manifest, files: { 'daemon.mjs': daemon, 'runner.mjs': runner } }],
    });
    let materialized: Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>> = null;
    try {
        expect(fixture.registry.pluginDiagnosticsByPluginId[pluginId]).toEqual([]);
        const agentId = [...fixture.registry.agentRuntimesByAgentId.values()].find(value => value.pluginId === pluginId)!.agentId;
        expect(agentId).not.toBe(localId);
        const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId, contributions: fixture.registry.contributes });
        if (!declaration) throw new Error('Declared Agent unavailable');
        const nativeHome = join(root, 'native');
        await mkdir(join(nativeHome, 'state'), { recursive: true });
        const sourceRow = { role: 'user', content: { type: 'text', text: 'Owned source fixture' } };
        const sourceText = `${JSON.stringify(sourceRow)}\n`;
        await writeFile(join(nativeHome, 'state', 'allowed.jsonl'), sourceText);
        const noAccountIo = async (): Promise<never> => { throw new Error('State-only fixture cannot access account I/O'); };
        const owner = createConnectedAccountPurposeBindingOwner({
            store: { read: noAccountIo, update: noAccountIo, subscribe: () => ({ dispose() {} }) },
            selectTarget: noAccountIo, resolveTarget: noAccountIo, materializeAccount: noAccountIo,
            projectTargetAccounts: noAccountIo, assertTargetAccountMaterializable: noAccountIo,
        });
        materialized = await materializeConnectedServicesForSpawn({
            agentId, materializationKey: 'owned-session', exactPurposeBindingSubjectId: 'owned-state',
            activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
            connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [], requestAuthPurposeBindings: [] },
            qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [] }, connectedAccountsOwner: owner,
            processEnv: { ACME_NATIVE_HOME: nativeHome },
            accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
                v: 1, defaults: { configMode: 'isolated', stateMode: 'shared' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
            } },
        });
        expect(materialized?.materializedStateObservationBinding).toBeDefined();
        const home = materialized!.env.ACME_NATIVE_HOME!;
        const binding = materialized!.materializedStateObservationBinding!;
        expect(await realpath(join(home, 'state'))).toBe(await realpath(join(nativeHome, 'state')));
        const sessionId = 'owned-session';
        const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(root, 'fixture-secret.key') });
        const live: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, startedBy: 'daemon', happySessionId: sessionId,
            spawnOptions: { directory: root, backendTarget: { kind: 'backend', backendId: agentId, sourceKind: 'built_in' } } };
        const callbacks = createSpawnLifecycleCallbacks({
            connectedServicesBindingsRaw: null, catalogAgentId: null, materializationKey: 'owned-session',
            materializedStateObservationBinding: binding, hasConnectedServiceAuth: () => false,
            getSpawnResourceCleanupOnExit: () => null, onSpawnResourceCleanupArmed: () => {},
            spawnResourceCleanupByKey: new Map(), getSessionAttachCleanup: () => null,
            setSessionAttachCleanup: () => {}, sessionAttachCleanupByKey: new Map(),
            persistAcceptedSpawnMarker: async tracked => {
                await persistAcceptedSpawnMarker({ trackedSession: tracked, deviceLocalSecretStorage: storage });
            },
        });
        callbacks.onTrackedSessionRegistered?.(live);
        await callbacks.persistAcceptedSpawnMarker?.(live);
        const marker = await readSessionMarker(live.trackingKey);
        if (!marker) throw new Error('Owned marker unavailable');
        expect(marker.processStartTimeMs).toBe(live.processStartTimeMs);
        const adopted = buildTrackedSessionFromMarker({ marker, startedByFallback: 'daemon', reattachedFromDiskMarker: true });
        expect(readTrackedSessionMaterializedStateObservationBinding([adopted], sessionId)).toEqual(binding);
        const foreign = join(root, 'foreign');
        await mkdir(foreign);
        await writeFile(join(foreign, 'escape.jsonl'), '{}\n');
        await writeFile(join(foreign, 'undeclared.jsonl'), '{}\n');
        await symlink(join(foreign, 'escape.jsonl'), join(nativeHome, 'state', 'escape.jsonl'));
        await symlink(foreign, join(home, 'extra'), process.platform === 'win32' ? 'junction' : 'dir');
        const source = { kind: 'acme.native', configDir: home };
        const resolve = async (remoteSessionId: string, configDir = home) => {
            const source = { kind: 'acme.native', configDir };
            const resolved = await resolveExternalSessionObservationLinkInput({ sessionId, linked: {
                agentId, source, remoteSessionId, linkGeneration: '1000', metadata: { externalSessionV1: {
                    v: 1, agentId, machineId: 'machine', source, remoteSessionId, linkedAtMs: 1000, linkData: {},
                    qualifiedIdentity: { v: 1, agent: { pluginId, localId }, source: { kind: source.kind, contractVersion: 1 } },
                } },
            } });
            if (!resolved) throw new Error('Admitted source unavailable');
            return resolved;
        };
        const watched: string[] = [];
        const admit = async (remoteSessionId: string, trackedSessions: readonly TrackedSession[] = [adopted], configDir = home, wireBinding = true) => {
            const projection = createExternalSessionObservationDaemonProjection({
                publishField: async () => {},
                ...(wireBinding ? { readMaterializedStateObservationBinding: (id: string) => readTrackedSessionMaterializedStateObservationBinding(trackedSessions, id) } : {}),
                watchFile: file => { watched.push(file); return () => {}; },
            });
            try { return await projection.reconcileTranscriptDemand({ resolved: await resolve(remoteSessionId, configDir), demanded: true }); }
            finally { await projection.dispose(); }
        };
        expect(await admit('allowed')).toMatchObject({ state: 'observing' });
        expect(watched).toEqual([await realpath(join(nativeHome, 'state', 'allowed.jsonl'))]);

        // Only Home HTTP is substituted. Registry activation, custody, source
        // paging, descriptor admission and native watcher readiness stay real.
        const credentials = { token: 'owned-fixture-token', encryption: null };
        const metadata = { externalSessionV1: {
            v: 1, agentId, machineId: 'machine', source, remoteSessionId: 'allowed', linkedAtMs: 1000, linkData: {},
            qualifiedIdentity: { v: 1, agent: { pluginId, localId }, source: { kind: source.kind, contractVersion: 1 } },
        } };
        const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
            storedContentMode: 'plain', metadata, agentState: null });
        const rawSession = SessionCurrentProjectionRecordV1Schema.parse({
            ...createSessionNotificationContextFixture(sessionId), encryptionMode: 'plain',
            metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
            ownerMetadata: fields.ownerMetadata, share: null, agentState: fields.agentState, agentStateVersion: 0,
        });
        const http = fastify();
        http.addHook('preHandler', async request => {
            expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
        });
        http.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ version: 1, updatedAt: 1 }));
        http.get<{ Params: { sessionId: string } }>('/v2/sessions/:sessionId', async request => {
            expect(request.params.sessionId).toBe(sessionId);
            return { session: rawSession };
        });
        await http.ready();
        const restoreHttp = installAxiosFastifyAdapter({ app: http, origin: new URL(resolveServerHttpBaseUrl()).origin });
        const projection = createExternalSessionObservationDaemonProjection({
            publishField: async () => {},
            readMaterializedStateObservationBinding: id => readTrackedSessionMaterializedStateObservationBinding([adopted], id),
        });
        let lease: Awaited<ReturnType<typeof acquireCanonicalExternalSessionFollowLease>> | null = null;
        try {
            const loaded = await loadLinkedExternalSession({ credentials, sessionId, machineId: 'machine' });
            if (!loaded.ok) throw new Error(`Owned link refused: ${loaded.error}`);
            const observation = await resolve('allowed');
            const providerOps = await resolveExternalSessionSurfaceOps(agentId);
            lease = await acquireCanonicalExternalSessionFollowLease({
                credentials, sessionId, machineId: 'machine', linked: loaded.session,
                resource: { linkGeneration: loaded.session.linkGeneration, occurrenceId: observation.resource.occurrenceId },
                observation, providerOps, maxBytes: 64_000, maxItems: 200, observationProjection: projection,
            });
            const page = await providerOps.pageTranscript!({ source, remoteSessionId: 'allowed', direction: 'older', maxBytes: 64_000, maxItems: 200 });
            expect(page).toMatchObject({ items: [{ id: 'source-row-0', createdAtMs: 1000, raw: sourceRow }], hasMore: false });
            const cursor = lease.readAcceptedCursor?.();
            if (!cursor) throw new Error('Canonical follow did not admit a source baseline cursor');
            expect(cursor).toBe(page.tailCursor);
            expect(await providerOps.readAfterTranscript!({ source, remoteSessionId: 'allowed', cursor, maxBytes: 64_000, maxItems: 200 }))
                .toEqual({ outcome: 'already_current' });
            await lease.release();
            lease = null;
            expect(await projection.reconcileTranscriptDemand({ resolved: observation, demanded: false })).toMatchObject({ state: 'not-demanded' });
        } finally {
            await lease?.release();
            await projection.dispose();
            restoreHttp();
            await http.close();
        }

        expect(await admit('allowed', [], nativeHome)).toMatchObject({ state: 'observing' });
        await expect(admit('allowed', [adopted], home, false)).rejects.toBeInstanceOf(TypeError);
        await expect(admit('allowed', [{ ...adopted, materializedStateObservationBinding: undefined }])).rejects.toBeInstanceOf(TypeError);
        await expect(admit('allowed', [{ ...adopted, happySessionId: 'other-session' }])).rejects.toBeInstanceOf(TypeError);
        await expect(admit('allowed', [{ ...adopted, reportMarkerCustody: { pending: Promise.resolve(), retiring: true } }])).rejects.toBeInstanceOf(TypeError);
        await expect(admit('allowed', [{ ...adopted, materializedStateObservationBinding: { ...binding, pluginId: 'other.plugin' } }])).rejects.toBeInstanceOf(TypeError);
        await expect(admit('allowed', [{ ...adopted, materializedStateObservationBinding: { ...binding, agentId: 'other-agent' } }])).rejects.toBeInstanceOf(TypeError);
        await expect(admit('allowed', [{ ...adopted, materializedStateObservationBinding: { ...binding, nativeHomeRoot: join(root, 'other-profile') } }])).rejects.toBeInstanceOf(TypeError);
        await expect(admit('allowed', [{ ...adopted, materializedStateObservationBinding: { ...binding, sourceCustody: { kind: 'managed', immutableGenerationId: 'other-generation', installSource: 'localPath' } } }])).rejects.toBeInstanceOf(TypeError);
        await expect(admit('undeclared')).rejects.toBeInstanceOf(TypeError);
        await expect(admit('escape')).rejects.toBeInstanceOf(TypeError);
        expect(validateExternalSessionObservationWatchFileChanges({
            requested: { files: [await realpath(join(nativeHome, 'state', 'allowed.jsonl'))] },
            linkedSource: { source, remoteSessionId: 'allowed', linkData: {} },
            filesystemReadAllowedPaths: new Set(),
            materializedStateObservationBinding: binding,
        })).toBeNull();
        await writeFile(join(foreign, 'allowed.jsonl'), '{}\n');
        await unlink(join(home, 'state'));
        await symlink(foreign, join(home, 'state'), process.platform === 'win32' ? 'junction' : 'dir');
        await expect(admit('allowed')).rejects.toBeInstanceOf(TypeError);
        expect(watched).toHaveLength(2);
    } finally {
        await materialized?.cleanupOnExit?.();
        await fixture.dispose();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
    }
});
