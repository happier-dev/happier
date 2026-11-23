import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { PromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createSessionOwnerMetadataV1, SessionOwnerMetadataV1Schema, SessionMetadataTuplePatchV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema, SessionSharedMetadataV1Schema, projectSessionOwnerCompatibilityViewV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { applyReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordSchemaV1';

import type { ApiClient } from '@/api/api';
import {
  ApiSessionClient,
  type ApiSessionClientOptions,
} from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionSocketTransport } from '@/api/session/connection/createSessionSocketTransport';
import { configuration } from '@/configuration';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveRunnerSkills } from '@/prompts/skills/runtime/resolveRunnerSkills';
import { createSkillStore } from '@/prompts/skills/store/skillStore';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import { DeferredApiSessionClient } from './DeferredApiSessionClient';
import {
  createDeferredStartupBootstrap,
  type DeferredStartupBackendApi,
} from './createDeferredStartupBootstrap';

describe('createDeferredStartupBootstrap', () => {
  it.each(['available', 'own-bundle-unavailable', 'private-captured', 'private-ordinary-captured', 'doc-only', 'doc-only-own-unavailable', 'coding-unavailable'] as const)('migrates retained skill custody through deferred attach before strict Session consumers read it (%s)', async availability => {
    const docOnly = availability === 'doc-only' || availability === 'doc-only-own-unavailable';
    const privateCaptured = availability === 'private-captured' || availability === 'private-ordinary-captured';
    const taskHome = await mkdtemp(join(tmpdir(), 'happier-retained-skill-'));
    const skillStore = createSkillStore({ happyHomeDir: taskHome });
    const entry = (id: string, artifactId: string) => ({ id, enabled: true, placement: 'system_append' as const,
      ref: { kind: 'bundle' as const, artifactId } });
    const retained = createTestMetadata({ machineId: 'machine', path: '/repo', work: {
      promptStack: availability === 'doc-only' ? [{ ...entry('session-entry', 'unreadable-doc'),
        ref: { kind: 'doc', artifactId: 'unreadable-doc' } }] : [entry('session-entry', 'session-skill')],
      disabledInheritedEntryIds: privateCaptured ? ['account-entry', 'profile-entry'] : ['account-entry'],
    }, ...(privateCaptured ? { profileId: 'retained-profile' } : {}) });
    let persistedMetadata = retained;
    let revision = 1;
    const artifact = (id: string) => ({ id, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: id, bundleSchemaId: 'skills.skill_md_v1' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
        { path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from(`---\nname: ${id}\ndescription: Useful\n---\nInstructions`).toString('base64') },
      ] }) }) });
    const http = createServer(async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname;
      response.setHeader('content-type', 'application/json');
      if (path === '/v2/sessions/retained-session' && request.method === 'PATCH') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString()));
        if (patch.mode !== 'owner_migration' || patch.target.ownerMetadata.t !== 'plain') {
          throw new Error('Expected plain retained owner migration');
        }
        // The genuine HTTP persistence boundary consumes the real writer's strict owner tuple.
        persistedMetadata = projectSessionOwnerCompatibilityViewV1({
          sharedMetadata: SessionSharedMetadataV1Schema.parse(JSON.parse(patch.target.sharedMetadata.ciphertext)),
          ownerMetadata: SessionOwnerMetadataV1Schema.parse(patch.target.ownerMetadata.v),
        }) as Metadata;
        revision++;
        response.end(JSON.stringify(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true,
          metadataLayoutVersion: 1, sharedMetadata: { version: revision }, agentState: { version: 1 } })));
        return;
      }
      if (path === '/v1/artifacts/session-skill' && (availability === 'own-bundle-unavailable' || availability === 'doc-only-own-unavailable')) {
        response.statusCode = 503; response.end(JSON.stringify({ error: 'unavailable' }));
      }
      else if (path === '/v1/artifacts') response.end(JSON.stringify([artifact('session-skill'), artifact('account-skill'),
        ...(availability === 'own-bundle-unavailable' ? [artifact('other-skill')] : [])]));
      else if (path.startsWith('/v1/artifacts/')) response.end(JSON.stringify(artifact(path.split('/').at(-1)!)));
      else if (path === '/v1/account/project-rows/list') response.end(JSON.stringify({ status: 'listed', coverage: 'complete', rows: [] }));
      else if (path === '/v1/account/encryption') response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
      else if (path === '/v1/account/encryption/currentness') response.end(JSON.stringify({ mode: 'plain', version: 1, settingsVersion: 7,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
      else if (path === '/v2/sessions/retained-session') response.end(JSON.stringify({ session: createSessionRecordFixture({
        id: 'retained-session', encryptionMode: 'plain', metadata: JSON.stringify(persistedMetadata), metadataVersion: revision,
      }) }));
      else if (path.endsWith('/messages')) response.end(JSON.stringify({ messages: [], hasMore: false, nextAfterSeq: null }));
      else { response.statusCode = 404; response.end(JSON.stringify({ error: 'not_found' })); }
    });
    const io = new Server(http, { path: '/v1/updates/' });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const base = `http://127.0.0.1:${address.port}`;
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`, encryption: null,
      requesterSessionCredentialScope: { serverId: configuration.activeServerId, serverHttpBaseUrl: base } };
    let bootstrap: Awaited<ReturnType<typeof createDeferredStartupBootstrap>> | undefined;
    try {
      await runWithServerHttpBaseUrl(base, async () => {
        const rules = applyReachRulesChangeV1([], { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } },
          { nowMs: 1, newId: () => 'current-on' }).map(rule => ({ ...rule, skillId: 'account-skill' }));
        if (availability === 'own-bundle-unavailable') rules.push({ ...rules[0]!, id: 'other-on', skillId: 'other-skill' });
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
          settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
          promptLibraryCatalog: { status: availability === 'coding-unavailable' ? 'partial' : 'ready', tombstones: [],
            diagnostics: availability === 'coding-unavailable' ? [{ key: 'coding', revision: 1, reason: 'unreachable' }] : [], rows: [{ revision: 1,
            record: PromptLibraryRecordV1Schema.parse({ key: 'coding', value: { v: 1, scope: { kind: 'coding' },
              entries: docOnly ? [{ ...entry('account-entry', 'unreadable-doc'),
                ref: { kind: 'doc', artifactId: 'unreadable-doc' } }] : [{ ...entry('account-entry', 'account-skill'), skillMigrationV1: true }] } }) }, { revision: 1,
            record: PromptLibraryRecordV1Schema.parse({ key: 'skill-rules', value: { v: 1, rules } }) }] },
          ...(privateCaptured ? { profileCatalog: { status: 'ready' as const, source: 'destination' as const,
            authority: 'active' as const, referenceGuardRevision: 1, controlRevision: 'absent' as const, control: null, diagnostics: [],
            records: [{ revision: 1, record: ProfileRecordV1Schema.parse({ v: 1, id: 'retained-profile',
              definition: { kind: 'artifact', artifactId: 'profile' }, enabled: false,
              promptStack: [{ ...entry('profile-entry', 'account-skill'), skillMigrationV1: true }], skillSeeds: ['account-skill'], secretBindings: {} }) }] } } : {}) });
        const api: DeferredStartupBackendApi = {
          getOrCreateSession: async () => { throw new Error('Retained attach must not create a Session'); },
          push: () => null,
          sessionSyncClient: (session, options) => new ApiSessionClient(credentials.token, session, {
            ...options,
            metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials },
            transport: { serverId: configuration.activeServerId, serverUrl: base,
              createSessionSocketTransport: binding => createSessionSocketTransport({ ...binding, token: credentials.token,
                serverUrl: base, machineId: 'machine', accessKeyBinding: 'preestablished' }) },
          }),
        };
        const attach = (metadata: Metadata) => createDeferredStartupBootstrap({ credentials, startedBy: 'terminal', initialMachineId: 'machine',
          machineMetadata: { host: 'test-host', platform: 'linux', happyCliVersion: '1.0.0', homeDir: '/tmp',
            happyHomeDir: '/tmp/.happy', happyLibDir: '/tmp/.happy/lib' },
          sessionTag: 'retained', existingSessionId: 'retained-session',
          sessionAttachSecret: { encryptionMode: 'plain', snapshot: { metadata, metadataVersion: revision,
            agentState: { controlledByUser: false }, agentStateVersion: 1 } },
          initialMetadata: createTestMetadata({ machineId: 'machine', path: '/repo' }),
          createInitializedSessionMetadata: machineId => ({ metadata: createTestMetadata({ machineId, path: '/repo' }),
            state: { controlledByUser: false } }), uiLogPrefix: '[test]',
          startupMetadataOverrides: createStartupMetadataOverrides({ permissionMode: 'default', permissionModeUpdatedAt: 1 }),
          // Already-admitted API/Machine custody is the genuine external initialization boundary.
          initializeBackendApiContext: async () => ({ api, machineId: 'machine' }),
        });
        bootstrap = await attach(retained);
        await bootstrap.start?.();
        const migratesOwnSkill = !docOnly && availability !== 'own-bundle-unavailable' && availability !== 'coding-unavailable';
        expect(persistedMetadata.work).toEqual(migratesOwnSkill ? { ...retained.work,
          promptStack: retained.work?.promptStack?.map(entry => ({ ...entry, skillMigrationV1: true })) } : retained.work);
        const captured = getActiveAccountSettingsSnapshot();
        if (!captured) throw new Error('Missing captured Account');
        const runnerCredentials = availability === 'private-ordinary-captured'
          ? { token: credentials.token, encryption: null } : credentials;
        const operationContext = privateCaptured ? createInvocationSavedSecretOperationContextV1({
          credentials: runnerCredentials, snapshot: captured, serverHttpBaseUrl: base, isCurrent: async () => true,
        }) : undefined;
        if (operationContext) setActiveAccountSettingsSnapshot({ ...captured, scopeKey: resolveAccountSettingsScopeKey({ ...credentials,
          token: `e30.${Buffer.from(JSON.stringify({ sub: 'daemon-account' })).toString('base64url')}.signature` }),
          promptLibraryCatalog: { status: 'ready', tombstones: [], diagnostics: [], rows: [] } });
        const daemonSnapshot = getActiveAccountSettingsSnapshot();
        const resolveSkills = (ownerKey: string, sessionMetadata: Metadata) => resolveRunnerSkills({
          ownerKey, sessionMetadata, credentials: runnerCredentials, accountSnapshot: captured, operationContext,
          agentId: 'test', machineId: 'machine', directory: taskHome, home: taskHome, agentHasActionChannel: true,
          contributes: { catalogEntriesById: { test: { skills: { delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported' } } } },
        }, { ensureSessionDir: input => skillStore.ensureSkillSessionDir(input) });
        const control = await resolveSkills('control', createTestMetadata({ machineId: 'machine', path: taskHome }));
        expect(control.delivery?.items.map(item => item.skillId)).toEqual(availability === 'own-bundle-unavailable'
          ? ['account-skill', 'other-skill'] : ['account-skill']);
        if (!control.delivery) throw new Error('Control skill was not delivered');
        expect(await readFile(join(control.delivery.skillsRoot, 'account-skill', 'SKILL.md'), 'utf8')).toContain('Instructions');
        const delivered = await resolveSkills('retained-session', operationContext ? retained : persistedMetadata);
        if (operationContext) expect(getActiveAccountSettingsSnapshot()).toBe(daemonSnapshot);
        expect(delivered.delivery?.items.map(item => item.skillId) ?? []).toEqual(availability === 'own-bundle-unavailable'
          ? ['other-skill'] : availability === 'coding-unavailable' ? [] : docOnly ? ['account-skill'] : ['session-skill']);
        if (availability === 'coding-unavailable') {
          expect(delivered.unavailable).toBe(true);
          return;
        }
        if (availability === 'own-bundle-unavailable') {
          expect(delivered.unavailable).toBeUndefined();
          expect(persistedMetadata.skillSelectionV1?.forceExcludeSkillIds).toEqual(['account-skill']);
          return;
        }
        if (docOnly) {
          expect(delivered.unavailable).toBeUndefined();
          expect(persistedMetadata.skillSelectionV1).toBeUndefined();
          return;
        }
        expect(persistedMetadata).toMatchObject({ skillSelectionV1: { v: 1, forceIncludeSkillIds: ['session-skill'],
          forceExcludeSkillIds: ['account-skill'] }, work: { ...retained.work,
            promptStack: retained.work?.promptStack?.map(entry => ({ ...entry, skillMigrationV1: true })) } });
        const owner = createSessionOwnerMetadataV1({ metadata: persistedMetadata });
        if (!owner.ok) throw new Error('Invalid persisted owner metadata');
        const strict = SessionOwnerMetadataV1Schema.parse(owner.ownerMetadata);
        const selected = resolveSessionCapabilitiesV1({ context: { machineId: 'machine', machinePlatform: 'posix',
          directory: '/repo', projectKey: null, agentId: 'claude' }, mcp: null, agentAcceptsUserMcp: true,
          skills: { items: ['account-skill', 'session-skill'].map(skillId => ({ skillId, name: skillId })), rules },
          selection: { skills: strict.runtime?.skillSelectionV1 } });
        expect(selected.skills.items[0]).toMatchObject({ selected: false, reason: 'session_removed' });
        expect(selected.skills.items[1]).toMatchObject({ selected: true });
        if (availability === 'available') {
          // User removes the include without Off; actual subsequent attach reads
          // the retained marked row and writes through the strict HTTP tuple.
          persistedMetadata = { ...persistedMetadata, skillSelectionV1: { ...persistedMetadata.skillSelectionV1!,
            forceIncludeSkillIds: [] } };
          revision++;
          for (let pass = 0; pass < 2; pass++) {
            await bootstrap.session.close();
            bootstrap.cancel?.();
            bootstrap = await attach(persistedMetadata);
            await bootstrap.start?.();
            expect(persistedMetadata.skillSelectionV1?.forceIncludeSkillIds).toEqual([]);
            expect(persistedMetadata.skillSelectionV1?.forceExcludeSkillIds).toEqual(['account-skill']);
            const reloaded = await resolveSkills('retained-session', persistedMetadata);
            expect(reloaded.delivery?.items ?? []).toEqual([]);
          }
        }
      });
    } finally {
      await bootstrap?.session.close();
      bootstrap?.cancel?.();
      resetActiveAccountSettingsSnapshotForTests();
      await new Promise<void>(resolve => io.close(() => resolve()));
      await skillStore.releaseSkillSessionDirs('retained-session');
      await skillStore.releaseSkillSessionDirs('control');
      await skillStore.collectSkillCache({ libraryDigests: [] });
      await rm(taskHome, { recursive: true, force: true });
    }
  });

  it('uses an admitted scoped API context and forwards process-local attach authority', async () => {
    const stop = new Error('stop after observing restricted initialization');
    const ordinaryInitialize = vi.fn(async () => {
      throw new Error('ordinary Account initialization must not run');
    });
    const api = {
      getOrCreateSession: vi.fn(),
      sessionSyncClient: vi.fn(),
      push: () => null,
    } satisfies DeferredStartupBackendApi;
    const scopedInitialize = vi.fn(async () => ({
      api,
      machineId: 'runner-machine',
    }));
    const initializeBackendRunSessionFn = vi.fn(async (params) => {
      expect(params.existingSessionId).toBe('runner-session');
      expect(params.sessionAttachSecret).toEqual({ encryptionMode: 'plain' });
      throw stop;
    });
    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 'runtime-token' } as never,
      startedBy: 'terminal',
      initialMachineId: 'runner-machine',
      machineMetadata: {
        host: 'host',
        platform: 'linux',
        happyCliVersion: '1.0.0',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/lib',
      },
      sessionTag: 'runner-session-tag',
      existingSessionId: 'runner-session',
      sessionAttachSecret: { encryptionMode: 'plain' },
      initialMetadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } as never,
      createInitializedSessionMetadata: (machineId) => ({
        metadata: {
          path: '/tmp/workspace',
          permissionMode: 'default',
          permissionModeUpdatedAt: 1,
          machineId,
        } as never,
        state: { controlledByUser: false },
      }),
      uiLogPrefix: '[test]',
      startupMetadataOverrides: createStartupMetadataOverrides({
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      }),
      initializeBackendApiContext: scopedInitialize,
      deps: {
        initializeBackendApiContextFn: ordinaryInitialize,
        initializeBackendRunSessionFn,
      },
    });

    await expect(bootstrap.start?.()).rejects.toBe(stop);
    expect(scopedInitialize).toHaveBeenCalledOnce();
    expect(ordinaryInitialize).not.toHaveBeenCalled();
    expect(initializeBackendRunSessionFn).toHaveBeenCalledOnce();
  });

  it('does not create or persist a server session after cancellation wins during API initialization', async () => {
    type ApiContext = Readonly<{ api: ApiClient; machineId: string }>;
    let resolveApiContext!: (value: ApiContext) => void;
    const apiContext = new Promise<ApiContext>((resolve) => {
      resolveApiContext = resolve;
    });
    const initializeBackendRunSessionFn = vi.fn();
    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 't' } as never,
      startedBy: 'terminal',
      initialMachineId: 'machine-1',
      machineMetadata: {
        host: 'host',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/lib',
      },
      sessionTag: 'session-tag',
      initialMetadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } as never,
      createInitializedSessionMetadata: (machineId) => ({
        metadata: {
          path: '/tmp/workspace',
          permissionMode: 'default',
          permissionModeUpdatedAt: 1,
          machineId,
        } as never,
        state: { controlledByUser: false },
      }),
      uiLogPrefix: '[test]',
      startupMetadataOverrides: createStartupMetadataOverrides({
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      }),
      deps: {
        initializeBackendApiContextFn: async () => await apiContext,
        initializeBackendRunSessionFn,
      },
    });

    const startPromise = bootstrap.start?.();
    const cancel = bootstrap.cancel;
    if (typeof cancel !== 'function') {
      throw new Error('expected deferred startup cancellation');
    }
    cancel();
    await startPromise;
    resolveApiContext({
      api: {
        push: () => ({
          sendToAllDevices: vi.fn(),
          sendToAllDevicesAsync: vi.fn(async () => true),
        }),
      } as unknown as ApiClient,
      machineId: 'machine-1',
    });
    await Promise.resolve();

    expect(initializeBackendRunSessionFn).not.toHaveBeenCalled();
  });

  it('settles startup and disposes a late successful session initialization after cancellation', async () => {
    let sessionInitializationEntered!: () => void;
    const sessionInitializationEnteredPromise = new Promise<void>((resolve) => {
      sessionInitializationEntered = resolve;
    });
    let lateSessionClosed!: () => void;
    const lateSessionClosedPromise = new Promise<void>((resolve) => {
      lateSessionClosed = resolve;
    });
    const lateSessionClose = vi.fn(async () => {
      lateSessionClosed();
    });
    const lateReconnectionCancel = vi.fn();
    let resolveSessionInitialization!: (value: {
      session: ApiSessionClient;
      reconnectionHandle: { cancel: () => void } | null;
      reportedSessionId: string | null;
      attachedToExistingSession: boolean;
    }) => void;
    const sessionInitialization = new Promise<{
      session: ApiSessionClient;
      reconnectionHandle: { cancel: () => void } | null;
      reportedSessionId: string | null;
      attachedToExistingSession: boolean;
    }>((resolve) => {
      resolveSessionInitialization = resolve;
    });
    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 't' } as never,
      startedBy: 'terminal',
      initialMachineId: 'machine-1',
      machineMetadata: {
        host: 'host',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/lib',
      },
      sessionTag: 'session-tag',
      initialMetadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } as never,
      createInitializedSessionMetadata: (machineId) => ({
        metadata: {
          path: '/tmp/workspace',
          permissionMode: 'default',
          permissionModeUpdatedAt: 1,
          machineId,
        } as never,
        state: { controlledByUser: false },
      }),
      uiLogPrefix: '[test]',
      startupMetadataOverrides: createStartupMetadataOverrides({
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      }),
      deps: {
        initializeBackendApiContextFn: async () => ({
          api: {
            push: () => ({
              sendToAllDevices: vi.fn(),
              sendToAllDevicesAsync: vi.fn(async () => true),
            }),
          } as unknown as ApiClient,
          machineId: 'machine-1',
        }),
        initializeBackendRunSessionFn: async () => {
          sessionInitializationEntered();
          return await sessionInitialization;
        },
      },
    });
    const startPromise = bootstrap.start?.();
    if (!startPromise) throw new Error('expected deferred startup start');
    await sessionInitializationEnteredPromise;
    const cancel = bootstrap.cancel;
    if (typeof cancel !== 'function') throw new Error('expected deferred startup cancellation');
    cancel();

    await expect(startPromise).resolves.toBeUndefined();
    resolveSessionInitialization({
      session: { close: lateSessionClose } as unknown as ApiSessionClient,
      reconnectionHandle: { cancel: lateReconnectionCancel },
      reportedSessionId: 'late-session',
      attachedToExistingSession: false,
    });
    await lateSessionClosedPromise;
    expect(lateReconnectionCancel).toHaveBeenCalledOnce();
    expect(lateSessionClose).toHaveBeenCalledOnce();
  });

  it('publishes the resolved machine id before starting background session attach', async () => {
    const order: string[] = [];
    const pushSender = {
      sendToAllDevices: vi.fn(),
      sendToAllDevicesAsync: vi.fn(async () => true),
    };
    const attachedSession = {
      sessionId: 'session-live',
      rpcHandlerManager: {
        registerHandler: vi.fn(),
        invokeLocal: vi.fn(async () => ({})),
      },
      sendSessionEvent: vi.fn(),
      getMetadataSnapshot: vi.fn(() => null),
      fetchLatestUserPermissionIntentFromTranscript: vi.fn(),
    } as unknown as ApiSessionClient;
    const onSessionAttached = vi.fn(async () => {
      order.push('attached');
    });
    const onPushSenderReady = vi.fn(async () => {
      order.push('push');
    });
    const sessionSyncClient = vi.fn(() => attachedSession);
    const transformSessionInputBeforeCommit = vi.fn(async (
      payload: Record<string, unknown>,
    ) => payload);
    const afterComposerAttachmentMessageAccepted = vi.fn(async () => undefined);
    const machineAdmissionTransport = vi.fn(async (
      request: Parameters<NonNullable<
        ApiSessionClientOptions['machineAdmissionTransport']
      >>[0],
    ) => ({
      status: 'accepted' as const,
      localId: request.localId,
    }));
    // Boundary fixture: this test only exercises push-sender propagation.
    const api = {
      push: () => pushSender,
      sessionSyncClient,
    } as unknown as ApiClient;
    const initialMutation = { fieldId: 'runtime.activity' } as const;

    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 't' } as never,
      startedBy: 'terminal',
      initialMachineId: 'machine-1',
      machineMetadata: {
        host: 'host',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/lib',
      },
      sessionTag: 'session-tag',
      existingSessionId: undefined,
      initialMetadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } as never,
      createInitializedSessionMetadata: (machineId) => ({
        metadata: {
          path: '/tmp/workspace',
          permissionMode: 'default',
          permissionModeUpdatedAt: 1,
          machineId,
        } as never,
        state: { controlledByUser: false },
      }),
      uiLogPrefix: '[test]',
      startupMetadataOverrides: createStartupMetadataOverrides({
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      }),
      onSessionAttached,
      onPushSenderReady,
      createInitialRegisteredSessionStateFieldMutations: () => [
        initialMutation as never,
      ],
      transformSessionInputBeforeCommit,
      afterComposerAttachmentMessageAccepted,
      machineAdmissionTransport,
      deps: {
        initializeBackendApiContextFn: async () => ({
          api,
          machineId: 'machine-1',
        }),
        initializeBackendRunSessionFn: async ({ api: runtimeApi }) => {
          const session = await runtimeApi.sessionSyncClient({
            id: 'session-live',
          } as never);
          return {
            session,
            reconnectionHandle: { cancel: vi.fn() },
            reportedSessionId: 'session-live',
            attachedToExistingSession: false,
          };
        },
      },
    });

    expect(bootstrap.session).toBeInstanceOf(DeferredApiSessionClient);
    expect(bootstrap.machineId).toBe('machine-1');
    expect(bootstrap.metadata).toEqual(expect.objectContaining({
      machineId: 'machine-1',
    }));

    await (
      bootstrap.start as unknown as (
        options: Readonly<{
          prepareSession(session: ApiSessionClient): Promise<void>;
        }>,
      ) => Promise<void>
    )({
      prepareSession: async (session) => {
        expect(session).toBe(attachedSession);
        order.push('prepare');
      },
    });

    expect(onSessionAttached).toHaveBeenCalledWith({
      session: attachedSession,
      machineId: 'machine-1',
    });
    expect(onPushSenderReady).toHaveBeenCalledWith(pushSender);
    expect(sessionSyncClient).toHaveBeenCalledWith(
      { id: 'session-live' },
      {
        initialRegisteredSessionStateFieldMutations: [initialMutation],
        durableMutationDeliveryInitiallyActive: false,
        transformSessionInputBeforeCommit,
        afterComposerAttachmentMessageAccepted,
        machineAdmissionTransport,
      },
    );
    expect(order).toEqual(['prepare', 'attached', 'push']);
  });

  it('keeps the initial machine id in bootstrap metadata and publishes rotated identity on attach', async () => {
    const attachedSession = {
      sessionId: 'session-live',
      getMetadataSnapshot: vi.fn(() => null),
      fetchLatestUserPermissionIntentFromTranscript: vi.fn(),
    } as unknown as ApiSessionClient;
    const onSessionAttached = vi.fn(async () => undefined);

    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 't' } as never,
      startedBy: 'terminal',
      initialMachineId: 'machine-stale',
      machineMetadata: {
        host: 'host',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/lib',
      },
      sessionTag: 'session-tag',
      existingSessionId: undefined,
      initialMetadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
        machineId: 'machine-stale',
      } as never,
      createInitializedSessionMetadata: (machineId) => ({
        metadata: {
          path: '/tmp/workspace',
          permissionMode: 'default',
          permissionModeUpdatedAt: 1,
          machineId,
        } as never,
        state: { controlledByUser: false },
      }),
      uiLogPrefix: '[test]',
      startupMetadataOverrides: createStartupMetadataOverrides({
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      }),
      onSessionAttached,
      deps: {
        initializeBackendApiContextFn: async () => ({
          api: {
            push: () => ({
              sendToAllDevices: vi.fn(),
              sendToAllDevicesAsync: vi.fn(async () => true),
            }),
          } as unknown as ApiClient,
          machineId: 'machine-rotated',
        }),
        initializeBackendRunSessionFn: async ({ onSessionSwap }) => {
          await onSessionSwap?.(attachedSession);
          return {
            session: attachedSession,
            reconnectionHandle: { cancel: vi.fn() },
            reportedSessionId: 'session-live',
            attachedToExistingSession: false,
          };
        },
      },
    });

    expect(bootstrap.machineId).toBe('machine-stale');
    expect(bootstrap.metadata).toEqual(expect.objectContaining({
      machineId: 'machine-stale',
    }));

    await bootstrap.start?.();

    expect(onSessionAttached).toHaveBeenCalledWith({
      session: attachedSession,
      machineId: 'machine-rotated',
    });
    expect(bootstrap.session.getMetadataSnapshot?.()).toBeNull();
  });

  it('rejects startup instead of continuing without a durable Session', async () => {
    const sessionUnavailable = Object.assign(
      new Error('Unable to start without a durable Session'),
      {
        name: 'BackendRunSessionUnavailableError',
        code: 'backend_run_session_unavailable' as const,
      },
    );
    const onBackgroundStartFailure = vi.fn();
    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 't' } as never,
      startedBy: 'terminal',
      initialMachineId: 'machine-1',
      machineMetadata: {
        host: 'host',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/lib',
      },
      sessionTag: 'session-tag',
      initialMetadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } as never,
      createInitializedSessionMetadata: (machineId) => ({
        metadata: {
          path: '/tmp/workspace',
          permissionMode: 'default',
          permissionModeUpdatedAt: 1,
          machineId,
        } as never,
        state: { controlledByUser: false },
      }),
      uiLogPrefix: '[test]',
      onBackgroundStartFailure,
      startupMetadataOverrides: createStartupMetadataOverrides({
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      }),
      deps: {
        initializeBackendApiContextFn: async () => ({
          api: {
            push: () => ({
              sendToAllDevices: vi.fn(),
              sendToAllDevicesAsync: vi.fn(async () => true),
            }),
          } as unknown as ApiClient,
          machineId: 'machine-1',
        }),
        initializeBackendRunSessionFn: async () => {
          throw sessionUnavailable;
        },
      },
    });

    await expect(bootstrap.start?.()).rejects.toBe(sessionUnavailable);
    expect(onBackgroundStartFailure).toHaveBeenCalledExactlyOnceWith(sessionUnavailable);
  });

  it('propagates required session-authority preparation failure instead of continuing local readiness', async () => {
    const authorityFailure = new Error('required startup snapshot refresh failed');
    const deactivateDurableMutationDelivery = vi.fn();
    const close = vi.fn(async () => undefined);
    const attachedSession = {
      sessionId: 'session-live',
      rpcHandlerManager: {
        registerHandler: vi.fn(),
        invokeLocal: vi.fn(async () => ({})),
      },
      deactivateDurableMutationDelivery,
      close,
    } as unknown as ApiSessionClient;
    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 't' } as never,
      startedBy: 'terminal',
      initialMachineId: 'machine-1',
      machineMetadata: {
        host: 'host',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/lib',
      },
      sessionTag: 'session-tag',
      initialMetadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } as never,
      createInitializedSessionMetadata: (machineId) => ({
        metadata: {
          path: '/tmp/workspace',
          permissionMode: 'default',
          permissionModeUpdatedAt: 1,
          machineId,
        } as never,
        state: { controlledByUser: false },
      }),
      uiLogPrefix: '[test]',
      startupMetadataOverrides: createStartupMetadataOverrides({
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      }),
      deps: {
        initializeBackendApiContextFn: async () => ({
          api: {
            push: () => ({
              sendToAllDevices: vi.fn(),
              sendToAllDevicesAsync: vi.fn(async () => true),
            }),
          } as unknown as ApiClient,
          machineId: 'machine-1',
        }),
        initializeBackendRunSessionFn: async () => ({
          session: attachedSession,
          reconnectionHandle: null,
          reportedSessionId: 'session-live',
          attachedToExistingSession: false,
        }),
      },
    });

    await expect(bootstrap.start?.({
      prepareSession: async () => {
        throw authorityFailure;
      },
    })).rejects.toBe(authorityFailure);

    expect(deactivateDurableMutationDelivery).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
