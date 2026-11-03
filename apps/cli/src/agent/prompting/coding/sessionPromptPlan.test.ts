import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { installEmptyProjectAccountRowsHttpBoundary } from '@/testkit/http/projectAccountRows';
import { ArtifactReadHeadersBatchInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { artifactReadResponse, artifactListResponse } from '@/testkit/http/artifactHome';
import { BUILT_IN_ROLES_V1, accountSettingsParse } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { DaemonAgentRuntimeTurnContributionsBridge } from '@/agent/runtime/session/process/agentRuntimeDaemonTurnContributionsBridge';

import { createSessionPromptPlanResolver } from './sessionPromptPlan';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { resolveSessionNativeToolDescriptors } from '@/agent/tools/happierTools/resolveSessionNativeToolBridge';
import { shouldDenyAgentSessionTitleToolCall } from '@/agent/permissions/codingPromptTitlePermission';
import { createApiSessionClientFixture, createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { applySessionRuntimeControls } from '@/api/session/sessionRuntimeControls';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, beginActiveProfileCatalogRefresh, beginActivePromptLibraryCatalogRefresh, getActiveAccountSettingsSnapshotLifetimeToken, getActiveAccountSettingsSnapshot, commitActivePromptLibraryCatalog, commitActiveProfileCatalog } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { applyInitialSessionCreationFactsToMetadata } from '@/agent/runtime/createSessionMetadata';
import { createSessionOwnerMetadataV1, projectSessionOwnerCompatibilityViewV1,
  projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

// The daemon IPC service is a system boundary; no plugin contributions are selected in these cases.
const daemonBridge: DaemonAgentRuntimeTurnContributionsBridge = {
  resolvePrompt: async () => ({ kind: 'prompt', promptAssetBlocks: [], toolPromptContributions: [] }),
  resolveAgentComposition: async () => { throw new Error('Unexpected composition request'); },
  resolveComposerReference: async () => { throw new Error('Unexpected reference request'); },
  resolveComposerAttachment: async () => { throw new Error('Unexpected attachment request'); },
  afterComposerAttachmentMessageAccepted: async () => { throw new Error('Unexpected attachment acceptance'); },
  transformAgentContext: async () => { throw new Error('Unexpected context transform'); },
  transformSessionInput: async () => { throw new Error('Unexpected input transform'); },
  transformAgentRequest: async () => { throw new Error('Unexpected request transform'); },
};

function plainPromptDocument(id: string, markdown: string) {
  return { id, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
    header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: id }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown, createdAtMs: 1, updatedAtMs: 1 }) }),
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
  };
}

function installPromptDocumentHeaderHttpBoundary(readDocument: (artifactId: string) => ReturnType<typeof plainPromptDocument>) {
  const projectRowsPost = vi.mocked(axios.post).getMockImplementation();
  if (!projectRowsPost) throw new Error('Missing Project Account rows HTTP boundary');
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    if (new URL(String(url)).pathname !== '/v1/artifacts/read') return projectRowsPost(url, body, options);
    expect(ArtifactReadHeadersBatchInputV1Schema.parse(body).artifactIds).toHaveLength(1);
    return artifactReadResponse(body, artifactId => readDocument(artifactId));
  });
}

function createProjectedIdentityTestMetadata(params: Parameters<typeof projectSessionOwnerCompatibilityViewV1>[0]) {
  const { work, bot, createdAsBot } = projectSessionOwnerCompatibilityViewV1(params);
  return createTestMetadata({ work, bot, createdAsBot });
}

describe('session prompt-plan producer', () => {
  it('withdraws prepared compaction guidance when its delivered Action tool is disabled', async () => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'compaction-context-account' })).toString('base64url')}.signature`, encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const settings = accountSettingsParse({ codingPromptBehaviorV1: { sessionCompactionNudge: true } });
    const snapshot = { source: 'network' as const, settings, rawSettings: {}, scopeKey,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      promptLibraryCatalog: { status: 'ready' as const, rows: [], tombstones: [], diagnostics: [] } };
    setActiveAccountSettingsSnapshot(snapshot);
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials, accountSettingsContext: { ...snapshot, whenRefreshed: null } },
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'compaction-context-session', getMetadataSnapshot: () => createTestMetadata({
        agentRuntimeCapabilitiesV1: { sessionCapabilities: { sessionListing: 'unsupported',
          sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
          sessionRollback: { conversation: 'unsupported' }, compaction: { events: true, manual: true } } },
      }) }),
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project', memoryRecallGuidanceEnabled: false,
      readNativeSessionId: () => 'native', daemonBridge,
    });
    expect(await resolve()).toContain('In long sessions,');
    expect(resolve.assertPreparedPlanCurrent).not.toThrow();
    setActiveAccountSettingsSnapshot({ ...snapshot, settingsVersion: 2, settings: accountSettingsParse({
      ...settings, actionsSettingsV1: { v: 1, actions: { 'session.compact': { enabled: false } } },
    }) });
    expect(resolve.assertPreparedPlanCurrent).toThrow(expect.objectContaining({ reason: 'active-account-settings-changed' }));
  });

  beforeEach(() => { installEmptyProjectAccountRowsHttpBoundary(); });
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

  it('keeps optional outages pending, notices only definitive absence, withdraws required context and recovers', async () => {
    const events: unknown[] = [];
    let required = false;
    let status = 503;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (new URL(String(url)).pathname === '/v1/account/encryption')
        return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      return status === 200 ? { status: 200, data: plainPromptDocument('private-document', 'Current selected context') }
        : { status, data: { error: status === 404 ? 'not_found' : 'unavailable' } };
    });
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials: { token: 'optional-context-token', encryption: null } },
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'optional-context-session', getMetadataSnapshot: () => createTestMetadata({ work: {
        memoryEnabled: true, promptStack: [{ id: 'private-entry', ref: { kind: 'doc', artifactId: 'private-document' },
          enabled: true, required, placement: 'system_append' }] } }),
        enqueueSessionEventCommitted: async (event: unknown) => {
          events.push(event); return { persisted: true as const, delivered: false as const };
        } }),
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project', memoryRecallGuidanceEnabled: false,
      readNativeSessionId: () => 'native', daemonBridge,
    });
    await expect(resolve({ baseOverride: 'Required base instructions', includeAdmittedInventory: true }))
      .rejects.toMatchObject({ code: 'preparation_pending', reason: 'unavailable' });
    expect(events).toEqual([]);
    expect(resolve.readStartupInstructions?.()).toBeNull();
    status = 404;
    await expect(resolve({ baseOverride: 'Required base instructions', includeAdmittedInventory: true }))
      .resolves.toMatchObject({ text: expect.stringContaining('Required base instructions'),
        admittedEntries: [{ outcome: 'unavailable', reason: 'not_found' }] });
    expect(events).toMatchObject([{ capabilityNoticeV1: { v: 1, items: [
      { kind: 'prompt_library', code: 'prompt_library_unavailable' },
    ] } }]);
    expect(JSON.stringify(events)).not.toContain('private-document');
    expect(resolve.readStartupInstructions?.()).not.toBeNull();
    status = 503;
    await expect(resolve({ baseOverride: 'Required base instructions' })).rejects.toMatchObject({ code: 'preparation_pending', reason: 'unavailable' });
    expect(resolve.readStartupInstructions?.()).toBeNull();
    expect(resolve.readCodingPromptBehavior?.()).toBeNull();
    expect(resolve.readComposition?.()).toBeNull();
    expect(events).toHaveLength(1);
    status = 404;
    required = true;
    await expect(resolve({ baseOverride: 'Required base instructions' })).rejects.toMatchObject({ code: 'attachment_unavailable', reason: 'not_found' });
    expect(resolve.readStartupInstructions?.()).toBeNull();
    expect(resolve.readCodingPromptBehavior?.()).toBeNull();
    expect(resolve.readComposition?.()).toBeNull();
    expect(events).toHaveLength(1);
    status = 200;
    expect(await resolve({ baseOverride: 'Required base instructions' })).toContain('Current selected context');
    expect(resolve.readStartupInstructions?.()).not.toBeNull();
  });

  it('keeps opaque plan evidence scoped to the prepared Session and withdraws it with the current Profile', async () => {
    let metadata = createTestMetadata();
    const params = { opts: { credentials: { token: 'context-token', encryption: null } },
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'composition-session', getMetadataSnapshot: () => metadata }),
      agentId: 'codex', machineId: 'test-machine', directory: '/private/repo',
      memoryRecallGuidanceEnabled: false, readNativeSessionId: () => 'native', daemonBridge };
    const resolve = createSessionPromptPlanResolver(params);
    await resolve({ baseOverride: 'PRIVATE instruction 🦉' });
    expect(resolve).toHaveProperty('readComposition');
    const read = () => resolve.readComposition?.();
    const first = read();
    expect(first).not.toBeNull();
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE|\/private\/repo/);
    await resolve({ baseOverride: 'PRIVATE instruction 🦉' });
    expect(read()).toEqual(first);
    const other = createSessionPromptPlanResolver(params);
    await other({ baseOverride: 'PRIVATE instruction 🦉' });
    const readOther = () => other.readComposition?.();
    expect(readOther()).not.toEqual(first);
    metadata = createTestMetadata({ profileId: 'different-profile' });
    expect(read()).toBeNull();
    expect(resolve.assertPreparedPlanCurrent).toThrow(expect.objectContaining({ reason: 'profile-selection-changed' }));
  });

  it('keeps the created-as-Bot first-message rule and caller guidance stable across preparations and native identity changes', async () => {
    const created = applyInitialSessionCreationFactsToMetadata(createTestMetadata(), {
      identity: { createdAsBot: true, bot: { kind: 'bot' } },
    });
    const retained = createSessionOwnerMetadataV1({ metadata: created });
    if (!retained.ok) throw new Error(`Creation metadata must be admitted: ${retained.unsupportedFields.join(', ')}`);
    let metadata = createProjectedIdentityTestMetadata({ ownerMetadata: retained.ownerMetadata,
      sharedMetadata: projectSessionSharedMetadataV1({ metadata: created }) });
    let nativeSessionId = 'native-bot';
    const params = {
      opts: { credentials: { token: 'creation-context-token', encryption: null }, agentSessionStartupInstructionsV1: {
        v: 1 as const, id: 'caller.startup', revision: 9, instructions: 'Original caller instructions',
      } },
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'created-bot', getMetadataSnapshot: () => metadata }),
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project',
      memoryRecallGuidanceEnabled: false, readNativeSessionId: () => nativeSessionId, daemonBridge,
    };
    const resolve = createSessionPromptPlanResolver(params);
    const first = await resolve();
    expect(first).toMatch(/task or remit[\s\S]*proceed[\s\S]*without asking/i);
    expect(first).toMatch(/empty or general[\s\S]*one concise focus question/i);
    expect(first).toMatch(/later messages[\s\S]*(?:do not|never)[\s\S]*focus question/i);
    expect(first).not.toContain('task changes significantly');
    expect(first.match(/Original caller instructions/g)).toHaveLength(1);
    const startup = resolve.readStartupInstructions?.();
    expect(startup).not.toBeNull();
    expect(await resolve()).toBe(first);
    expect(resolve.readStartupInstructions?.()).toEqual(startup);
    // Demotion changes the display marker, never the persisted creation fact.
    const { bot: _bot, ...retainedWork } = retained.ownerMetadata.work ?? {};
    metadata = createProjectedIdentityTestMetadata({ ownerMetadata: { ...retained.ownerMetadata, work: retainedWork },
      sharedMetadata: projectSessionSharedMetadataV1({ metadata: {} }) });
    expect(await resolve()).toBe(first);
    // The native reopen/reset owner retains this producer and its original caller input.
    nativeSessionId = 'native-bot-reopened';
    expect(await resolve()).toBe(first);
    expect(resolve.readStartupInstructions?.()).toEqual(startup);
    // Ordinary preparation/compaction keeps the same first-message-scoped base.
    expect(await resolve()).toBe(first);
    expect(resolve.readStartupInstructions?.()).toEqual(startup);
  });

  it('does not insert creation guidance when an existing ordinary Session is promoted', async () => {
    const retained = createSessionOwnerMetadataV1({ metadata: { ...createTestMetadata(), bot: { kind: 'bot' } } });
    if (!retained.ok) throw new Error(`Promoted metadata must be admitted: ${retained.unsupportedFields.join(', ')}`);
    const metadata = createProjectedIdentityTestMetadata({ ownerMetadata: retained.ownerMetadata,
      sharedMetadata: projectSessionSharedMetadataV1({ metadata: { bot: { kind: 'bot' } } }) });
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials: { token: 'promotion-context-token', encryption: null } },
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'promoted-session', getMetadataSnapshot: () => metadata }),
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project',
      memoryRecallGuidanceEnabled: false, readNativeSessionId: () => 'native', daemonBridge,
    });
    expect(await resolve()).not.toMatch(/focus question/i);
  });

  it.each(['network', 'none'] as const)('demand-loads the current Account prompt rows before the first preparation from %s Settings', async source => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'first-context-account' })).toString('base64url')}.signature`, encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({ source, settings, ...(source === 'network' ? { rawSettings: {} } : {}), scopeKey,
      settingsVersion: source === 'network' ? 1 : 0, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('Missing initial Account snapshot');
    const operationContext = source === 'none' ? createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
      serverHttpBaseUrl: 'http://localhost:3005', isCurrent: async () => getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey }) : undefined;
    installPromptDocumentHeaderHttpBoundary(artifactId => {
      expect(artifactId).toBe('first');
      return plainPromptDocument(artifactId, 'First admitted Account context');
    });
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: { status: 'listed',
        rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: { t: 'plain',
          v: key === 'coding' ? { key, value: { v: 1, scope: { kind: 'coding' }, entries: [{ id: 'first',
            ref: { kind: 'doc', artifactId: 'first' }, enabled: true, placement: 'system_append' }] } }
            : emptyPromptLibraryRecordV1(key) } })) } };
      const row = plainPromptDocument('first', 'First admitted Account context');
      if (path === '/v1/artifacts/first') return { status: 200, data: row };
      throw new Error(`Unexpected first preparation HTTP path: ${path}`);
    });
    const preparationBridge = source === 'none' ? { ...daemonBridge, resolvePrompt: async () => {
      // The background bootstrap confirms equal Settings through the actual
      // publication owner while the captured prompt preparation is in flight.
      setActiveAccountSettingsSnapshot({ ...snapshot, source: 'network', rawSettings: {}, settingsVersion: 1 });
      return await daemonBridge.resolvePrompt({ sessionId: 'test-session', machineId: 'test-machine', featureIds: [], signal: new AbortController().signal });
    } } : daemonBridge;
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials, accountSettingsContext: { ...snapshot, whenRefreshed: null } },
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'test-session', getMetadataSnapshot: () => createTestMetadata() }),
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project', memoryRecallGuidanceEnabled: false,
      readNativeSessionId: () => 'native', daemonBridge: preparationBridge,
      ...(operationContext ? { readOperationContext: () => operationContext } : {}),
    });
    expect(await resolve({ baseOverride: 'Base' })).toContain('First admitted Account context');
    // Captured and Active Account catalogues are separate projections. The
    // catalogue refresh assertions below belong to the ordinary Active reader.
    if (operationContext) {
      expect(resolve.assertPreparedPlanCurrent).not.toThrow();
      setActiveAccountSettingsSnapshot({ ...getActiveAccountSettingsSnapshot()!,
        settings: accountSettingsParse({ codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'disabled' } }), settingsVersion: 2 });
      expect(resolve.assertPreparedPlanCurrent).toThrow(expect.objectContaining({ reason: 'active-account-settings-changed' }));
      setActiveAccountSettingsSnapshot({ ...getActiveAccountSettingsSnapshot()!, source: 'none', settings, settingsVersion: 3 });
      // This plan started without Settings availability. Once its captured
      // read confirms the source, losing that availability still refuses it.
      expect(resolve.assertPreparedPlanCurrent).toThrow(expect.objectContaining({ reason: 'active-account-availability-changed' }));
      return;
    }
    const catalog = getActiveAccountSettingsSnapshot()?.promptLibraryCatalog;
    if (!catalog || catalog.status !== 'ready') throw new Error('First demand did not admit the prompt catalog');
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    expect(commitActivePromptLibraryCatalog({ scopeKey, lifetimeToken, catalog: { ...catalog,
      cleanup: { status: 'cleanup-pending', reason: 'history-incomplete' } } })).toBe(true);
    // Source/history bookkeeping never withdraws already-admitted destination instructions.
    expect(resolve.assertPreparedPlanCurrent).not.toThrow();
    expect(resolve.readStartupInstructions?.()?.instructions).toContain('First admitted Account context');
    expect(beginActivePromptLibraryCatalogRefresh({ scopeKey, lifetimeToken })).toBe(true);
    expect(resolve.assertPreparedPlanCurrent).not.toThrow();
    expect(resolve.readStartupInstructions?.()?.instructions).toContain('First admitted Account context');
    expect(commitActivePromptLibraryCatalog({ scopeKey, lifetimeToken, catalog: { ...catalog,
      rows: catalog.rows.filter(row => row.record.key !== 'coding') } })).toBe(true);
    // Same-lifetime catalog changes apply at the next preparation, without
    // withdrawing the already admitted startup plan.
    expect(resolve.assertPreparedPlanCurrent).not.toThrow();
    expect(resolve.readStartupInstructions?.()?.instructions).toContain('First admitted Account context');
    expect(await resolve({ baseOverride: 'Base' })).not.toContain('First admitted Account context');
    const admitted = getActiveAccountSettingsSnapshot();
    if (!admitted) throw new Error('Missing admitted Account');
    setActiveAccountSettingsSnapshot({ ...admitted, settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: admitted.settingsVersion + 1, loadedAtMs: 2, settingsSecretsReadKeys: [] });
    expect(resolve.assertPreparedPlanCurrent).not.toThrow();
    expect(resolve.readStartupInstructions?.()).not.toBeNull();
    setActiveAccountSettingsSnapshot({ ...getActiveAccountSettingsSnapshot()!,
      settings: accountSettingsParse({ codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'disabled' } }),
      settingsVersion: admitted.settingsVersion + 2 });
    expect(resolve.assertPreparedPlanCurrent).toThrow(expect.objectContaining({ reason: 'active-account-settings-changed' }));
    expect(resolve.readStartupInstructions?.()).toBeNull();
  });

  it.each([false, true])('keeps coding preparation current across unrelated Account preferences (captured: %s)', async captured => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'preference-context-account' })).toString('base64url')}.signature`, encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const snapshot = { source: 'network' as const, settings: accountSettingsParse({ memoryUseInNewSessions: false }), rawSettings: {}, scopeKey,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      promptLibraryCatalog: { status: 'ready' as const, rows: [], tombstones: [], diagnostics: [] } };
    setActiveAccountSettingsSnapshot(snapshot);
    const operation = createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl: 'http://localhost:3005',
      isCurrent: async () => getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey });
    let changedDuringRead = false;
    installPromptDocumentHeaderHttpBoundary(artifactId => {
      expect(artifactId).toBe('current');
      return plainPromptDocument(artifactId, 'Prepared current instructions');
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/artifacts/current' && !changedDuringRead) {
        changedDuringRead = true;
        const settings = accountSettingsParse({ memoryUseInNewSessions: true });
        expect(settings).not.toEqual(snapshot.settings);
        setActiveAccountSettingsSnapshot({ ...getActiveAccountSettingsSnapshot()!, settings, settingsVersion: 2 });
      }
      if (path === '/v1/artifacts/current') return { status: 200, data: plainPromptDocument('current', 'Prepared current instructions') };
      throw new Error(`Unexpected current preparation HTTP path: ${path}`);
    });
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials, accountSettingsContext: { ...snapshot, whenRefreshed: null } },
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'preference-context-session', getMetadataSnapshot: () => createTestMetadata({
        work: { promptStack: [{ id: 'instructions', ref: { kind: 'doc', artifactId: 'current' },
          enabled: true, required: true, placement: 'system_append' }] },
      }) }),
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project', memoryRecallGuidanceEnabled: false,
      readNativeSessionId: () => 'native', daemonBridge,
      ...(captured ? { readOperationContext: () => operation } : {}),
    });
    expect(await resolve()).toContain('Prepared current instructions');
    expect(changedDuringRead).toBe(true);
    setActiveAccountSettingsSnapshot({ ...getActiveAccountSettingsSnapshot()!,
      settings: accountSettingsParse({ memoryUseInNewSessions: false }), settingsVersion: 3 });
    expect(resolve.assertPreparedPlanCurrent).not.toThrow();
    expect(resolve.readStartupInstructions?.()?.instructions).toContain('Prepared current instructions');
    setActiveAccountSettingsSnapshot({ ...getActiveAccountSettingsSnapshot()!, settingsVersion: 4,
      settings: accountSettingsParse({ codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'disabled' } }) });
    expect(resolve.assertPreparedPlanCurrent).toThrow(expect.objectContaining({ reason: 'active-account-settings-changed' }));
  });

  it('refuses a captured Account context when its credentials belong to another Account scope', async () => {
    const credentials = { token: 'other-account-token', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey({ token: 'captured-account-token', encryption: null });
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, scopeKey,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200, data: [] }));
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials, accountSettingsContext: { source: 'network', settings, scopeKey,
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], whenRefreshed: null } },
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'test-session', getMetadataSnapshot: () => createTestMetadata() }),
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project', memoryRecallGuidanceEnabled: false,
      readNativeSessionId: () => 'native', daemonBridge,
    });
    await expect(resolve({ baseOverride: 'Base', includeAdmittedInventory: true })).rejects.toMatchObject({
      code: 'context_source_unavailable', status: 'preparation_pending',
    });
    expect(resolve.readStartupInstructions?.()).toBeNull();
    expect(resolve.readCodingPromptBehavior?.()).toBeNull();
  });

  it.each(['ready', 'unavailable'] as const)('does not publish a plan or private inventory after its Account lifetime retires during %s document preparation', async outcome => {
    const credentials = { token: 'retiring-context-token', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const settings = accountSettingsParse({});
    const snapshot = { source: 'network' as const, settings, rawSettings: {}, scopeKey,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      promptLibraryCatalog: { status: 'ready' as const, rows: [], tombstones: [], diagnostics: [] } };
    setActiveAccountSettingsSnapshot(snapshot);
    let retireDuringRead = false;
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      const row = plainPromptDocument('current', 'Retired Account content');
      if (path === '/v1/artifacts') return { status: 200, data: [row] };
      if (!retireDuringRead) return { status: 200, data: row };
      setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: resolveAccountSettingsScopeKey({ token: 'next-context-token', encryption: null }) });
      return outcome === 'ready' ? { status: 200, data: row } : { status: 503, data: { error: 'unavailable' } };
    });
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials, accountSettingsContext: { source: 'network', settings, scopeKey,
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], whenRefreshed: null } },
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'test-session', getMetadataSnapshot: () => createTestMetadata({ work: { memoryEnabled: true,
        promptStack: [{ id: 'current', ref: { kind: 'doc', artifactId: 'current' }, enabled: true, placement: 'system_append' }] } }) }),
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project', memoryRecallGuidanceEnabled: false,
      readNativeSessionId: () => 'native', daemonBridge,
    });
    expect(await resolve({ baseOverride: 'Base' })).toContain('Retired Account content');
    expect(resolve.readStartupInstructions?.()?.instructions).toContain('Retired Account content');
    retireDuringRead = true;
    const result = await resolve({ baseOverride: 'Base', includeAdmittedInventory: true }).catch(error => error);
    expect(result).toMatchObject({ code: 'context_source_unavailable' });
    expect(result).not.toHaveProperty('admittedEntries');
    expect(resolve.readCodingPromptBehavior?.()).toBeNull();
    expect(resolve.readStartupInstructions?.()).toBeNull();
  });

  it.each([null, 'focused'])('withdraws prepared policy after a catalog-only Profile change only for the selected Profile (%s)', async profileId => {
    const credentials = { token: 'current-profile-context-token', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, scopeKey,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] },
      profileCatalog: { status: 'ready', authority: 'active', source: 'destination', diagnostics: [], referenceGuardRevision: 1,
        control: null, controlRevision: 'absent', records: [{ revision: 1, record: ProfileRecordV1Schema.parse({
          v: 1, id: 'focused', enabled: true, promptStack: [], secretBindings: {},
          definition: { kind: 'inline', profile: { v: 2, id: 'focused', name: 'Focused', createdAt: 1, updatedAt: 1,
            codingPromptBehaviorOverrides: { sessionTitleUpdates: 'ongoing' } } },
        }) }],
      },
    });
    vi.spyOn(axios, 'get').mockImplementation(async (url) => new URL(String(url)).pathname === '/v1/account/encryption'
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } } : { status: 200, data: artifactListResponse(String(url), []) });
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials, accountSettingsContext: { source: 'network', settings, scopeKey,
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], whenRefreshed: null } },
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'test-session', getMetadataSnapshot: () => createTestMetadata({ profileId }) }),
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project', memoryRecallGuidanceEnabled: false,
      readNativeSessionId: () => 'native', daemonBridge,
    });
    await resolve();
    let preparedBehavior = resolve.readCodingPromptBehavior?.();
    expect(preparedBehavior).not.toBeNull();
    if (profileId) expect(preparedBehavior?.sessionTitleUpdates).toBe('ongoing');
    const catalog = getActiveAccountSettingsSnapshot()?.profileCatalog;
    if (catalog?.status !== 'ready') throw new Error('Missing prepared Profile catalog');
    commitActiveProfileCatalog({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), catalog: {
      ...catalog, referenceGuardRevision: 2, records: [...catalog.records, { revision: 1, record: ProfileRecordV1Schema.parse({
        v: 1, id: 'unrelated', enabled: true, promptStack: [], secretBindings: {},
        definition: { kind: 'inline', profile: { v: 2, id: 'unrelated', name: 'Unrelated', createdAt: 1, updatedAt: 1 } },
      }) }],
    } });
    expect(resolve.readCodingPromptBehavior?.()).toEqual(preparedBehavior);
    expect(resolve.assertPreparedPlanCurrent).not.toThrow();
    commitActiveProfileCatalog({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), catalog: {
      ...catalog, referenceGuardRevision: 3, records: catalog.records.map(row => row.record.id !== 'focused'
        || row.record.definition.kind !== 'inline' ? row : { revision: row.revision + 1, record: ProfileRecordV1Schema.parse({
          ...row.record, definition: { ...row.record.definition, profile: { ...row.record.definition.profile,
            codingPromptBehaviorOverrides: { sessionTitleUpdates: 'disabled' } } },
        }) }),
    } });
    if (profileId) {
      expect(resolve.readCodingPromptBehavior?.()).toBeNull();
      expect(resolve.assertPreparedPlanCurrent).toThrow(expect.objectContaining({ reason: 'active-account-profile-changed' }));
      await resolve();
      preparedBehavior = resolve.readCodingPromptBehavior?.();
      expect(preparedBehavior?.sessionTitleUpdates).toBe('disabled');
    } else {
      expect(resolve.readCodingPromptBehavior?.()).toEqual(preparedBehavior);
      expect(resolve.assertPreparedPlanCurrent).not.toThrow();
    }
    beginActiveProfileCatalogRefresh({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
    if (profileId) {
      expect(resolve.readCodingPromptBehavior?.()).toBeNull();
      expect(resolve.assertPreparedPlanCurrent).toThrow(expect.objectContaining({ reason: 'active-account-profile-changed' }));
    } else {
      expect(resolve.readCodingPromptBehavior?.()).toEqual(preparedBehavior);
      expect(resolve.assertPreparedPlanCurrent).not.toThrow();
    }
  });

  it('prepares the current Session context without an Account stack and never reuses its previous document', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    let selected = 'first';
    const entry = (id: string) => ({ id, ref: { kind: 'doc' as const, artifactId: id }, enabled: true, placement: 'system_append' as const });
    const metadata = () => createTestMetadata({ work: { memoryEnabled: true, promptStack: [entry(selected)] } });
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/artifacts') return { status: 200, data: ['first', 'second'].map(id => plainPromptDocument(id, `Current ${id}`)) };
      const id = path.split('/').at(-1)!;
      return { status: 200, data: { id, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: id }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: `Current ${id}`, createdAtMs: 1, updatedAtMs: 1 }) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      } };
    });
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials: { token, encryption: null } },
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'test-session', getMetadataSnapshot: metadata }),
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project', memoryRecallGuidanceEnabled: false,
      readNativeSessionId: () => 'native', daemonBridge,
    });
    expect(await resolve({ baseOverride: 'Base' })).toContain('Current first');
    selected = 'second';
    const second = await resolve({ baseOverride: 'Base' });
    expect(second).toContain('Current second');
    expect(second).not.toContain('Current first');
    expect(resolve.readStartupInstructions?.()?.revision).toBe(2);
    const current = await resolve({ baseOverride: 'Base', includeAdmittedInventory: true });
    expect(current.text).toBe(second);
    expect(current.admittedEntries).toEqual([{
      entryId: 'second', layer: 'session', outcome: 'ready',
      scope: { serverId: expect.any(String), accountId: 'account', sessionId: 'test-session' },
      ref: { kind: 'doc', artifactId: 'second', serverId: expect.any(String) },
      revision: { headerVersion: 1, bodyVersion: 1 },
    }]);
  });

  it.each(['owned', 'shared'] as const)('uses the %s published profile on each preparation for prompt, native tools and title admission', async (source) => {
    let sessionTitleUpdates: 'disabled' | 'ongoing' = 'disabled';
    let available = true;
    let listFailed = false;
    const metadata = createTestMetadata({ profileId: 'focused' });
    // HTTP is the Artifact boundary; mode checking, profile opening and prompt composition stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      const row = { id: 'published-profile', ownerAccountId: 'account', access: source === 'owned' ? 'owner' : 'view', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ kind: 'launch-profile.v1', profileId: 'focused', name: 'Focused' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'launch-profile.v1', profile: {
          v: 2, id: 'focused', name: 'Focused', createdAt: 1, updatedAt: 1,
          codingPromptBehaviorOverrides: { sessionTitleUpdates },
        } }) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      if (path === '/v1/artifacts') return listFailed ? { status: 503, data: { error: 'unavailable' } }
        : { status: 200, data: artifactListResponse(String(url), available ? [row] : []) };
      if (path === '/v1/artifacts/published-profile') return available
        ? { status: 200, data: row } : { status: 404, data: { error: 'not_found' } };
      throw new Error(`Unexpected HTTP path: ${path}`);
    });
    const rawSettings = { profiles: source === 'owned' ? [{ artifactId: 'published-profile' }] : [] };
    const settings = accountSettingsParse(rawSettings);
    const credentials = { token: 'published-profile-test-token', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings, scopeKey,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] }, profileCatalog: {
        status: 'ready', authority: 'inactive', source: 'legacy', records: [], diagnostics: [], referenceGuardRevision: 'absent',
        control: null, controlRevision: 'absent',
      } });
    const session = createMutableApiSessionClientFixture({ metadata });
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials,
        accountSettingsContext: { source: 'cache', scopeKey, settingsVersion: 1, loadedAtMs: 1,
          settingsSecretsReadKeys: [], whenRefreshed: null, settings } },
      session,
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project',
      memoryRecallGuidanceEnabled: false, readNativeSessionId: () => 'native-conversation', daemonBridge,
    });
    const disabled = await resolve();
    expect(disabled).not.toContain('change_title');
    const behavior = resolve.readCodingPromptBehavior?.();
    expect(behavior?.sessionTitleUpdates).toBe('disabled');
    expect(resolveSessionNativeToolDescriptors({ accountSettings: settings, profileId: 'focused',
      codingPromptBehavior: behavior, sessionId: 'test-session', memoryRecallGuidanceEnabled: false,
    }).map(tool => tool.name)).not.toContain('change_title');
    expect(shouldDenyAgentSessionTitleToolCall({ settings, profileId: 'focused', codingPromptBehavior: behavior,
      toolName: 'change_title', input: { title: 'Title' } })).toBe(true);
    const controls: Partial<SessionRuntimeControls> = {};
    const publishedControls = { readCodingPromptBehavior: () => resolve.readCodingPromptBehavior?.() ?? null };
    const policy = { getAccountSettings: () => settings,
      getCodingPromptBehavior: () => controls.readCodingPromptBehavior?.() ?? null };
    const handlers = [createProviderEnforcedPermissionHandler({ session, logPrefix: '[Test]', ...policy })];
    // The client owns a stable controls object; the producer can attach after the handler.
    for (const handler of handlers) expect(handler.getImmediateDecision('title', 'change_title', { title: 'Title' }))
      .toEqual({ decision: 'denied' });
    applySessionRuntimeControls(controls, publishedControls);
    for (const handler of handlers) expect(handler.getImmediateDecision('title', 'change_title', { title: 'Title' }))
      .toEqual({ decision: 'denied' });
    settings.codingPromptBehaviorV1 = { ...settings.codingPromptBehaviorV1, sessionTitleUpdates: 'disabled' };
    sessionTitleUpdates = 'ongoing';
    expect(await resolve()).toContain('change_title');
    expect(resolve.readCodingPromptBehavior?.()?.sessionTitleUpdates).toBe('ongoing');
    for (const handler of handlers) expect(handler.getImmediateDecision('title', 'change_title', { title: 'Title' })?.decision)
      .not.toBe('denied');
    available = false;
    // An unresolved profile uses the canonical policy owner's Account defaults.
    expect(await resolve()).not.toContain('change_title');
    expect(resolve.readCodingPromptBehavior?.()?.sessionTitleUpdates).toBe('disabled');
    available = true;
    listFailed = true;
    await expect(resolve()).rejects.toMatchObject({ code: 'list_failed' });
    expect(resolve.readCodingPromptBehavior?.()).toBeNull();
    for (const handler of handlers) expect(handler.getImmediateDecision('title', 'change_title', { title: 'Title' }))
      .toEqual({ decision: 'denied' });
    listFailed = false;
    expect(await resolve()).toContain('change_title');
    const controller = new AbortController();
    const cancelled = new Error('Preparation cancelled');
    controller.abort(cancelled);
    await expect(resolve({ signal: controller.signal })).rejects.toBe(cancelled);
    for (const handler of handlers) expect(handler.getImmediateDecision('title', 'change_title', { title: 'Title' }))
      .toEqual({ decision: 'denied' });
    expect(await resolve()).toContain('change_title');
    applySessionRuntimeControls(controls, null);
    for (const handler of handlers) expect(handler.getImmediateDecision('title', 'change_title', { title: 'Title' }))
      .toEqual({ decision: 'denied' });
    applySessionRuntimeControls(controls, publishedControls);
    for (const handler of handlers) expect(handler.getImmediateDecision('title', 'change_title', { title: 'Title' })?.decision)
      .not.toBe('denied');
  });

  it('re-reads selected stack documents on each preparation and revises the full plan after an edit', async () => {
    let markdown = 'Initial stack document';
    // Artifact HTTP is the boundary; document opening, stack rendering and plan revision stay real.
    installPromptDocumentHeaderHttpBoundary(artifactId => plainPromptDocument(artifactId, markdown));
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/artifacts/stack-doc') return { status: 200, data: plainPromptDocument('stack-doc', markdown) };
      throw new Error(`Unexpected stack HTTP path: ${path}`);
    });
    const credentials = { token: 'test-token', encryption: null };
    const rawSettings = { promptStacksV1: {
          v: 1, surfaces: { coding: [{ id: 'stack-entry', ref: { kind: 'doc', artifactId: 'stack-doc' },
            enabled: true, placement: 'system_append', editPolicy: 'user_only' }], voice: [], profilesById: {} },
    } };
    const settings = accountSettingsParse(rawSettings);
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings, scopeKey,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials,
        accountSettingsContext: { source: 'network', scopeKey, settingsVersion: 1, loadedAtMs: 1,
          settingsSecretsReadKeys: [], whenRefreshed: null, settings } },
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'test-session', getMetadataSnapshot: () => createTestMetadata() }),
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project',
      memoryRecallGuidanceEnabled: false, readNativeSessionId: () => 'native-conversation',
      daemonBridge,
    });
    const first = await resolve({ baseOverride: 'Base instructions' });
    expect(first).toContain(markdown);
    const firstRevision = resolve.readStartupInstructions?.()?.revision;
    expect(firstRevision).toBe(1);
    markdown = 'Edited stack document';
    const edited = await resolve({ baseOverride: 'Base instructions' });
    expect(edited).toContain(markdown);
    expect(edited).not.toContain('Initial stack document');
    expect(resolve.readStartupInstructions?.()).toEqual({
      v: 1, id: 'happier.coding_session_plan', revision: 2, instructions: edited,
    });
    expect(await resolve({ baseOverride: 'Base instructions' })).toBe(edited);
    expect(resolve.readStartupInstructions?.()?.revision).toBe(2);
  });
  it('rechecks absent and edited instructions without notifications and deduplicates only within each preparation', async () => {
    let markdown: string | null = null;
    let detailReads = 0;
    const selected = { kind: 'doc' as const, artifactId: 'fresh-instructions' };
    const entries = [
      { id: 'optional-context', ref: selected, enabled: true, placement: 'system_append' as const },
      { id: 'same-document', ref: selected, enabled: true, placement: 'system_append' as const },
    ];
    // Only HTTP is replaced; current Artifact decoding, per-preparation reads,
    // the common stack resolver and PromptPlan revision all remain real.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/artifacts') return { status: 200, data: markdown === null ? [] : [plainPromptDocument(selected.artifactId, markdown)] };
      if (path === `/v1/artifacts/${selected.artifactId}`) {
        detailReads += 1;
        return markdown === null ? { status: 404, data: { error: 'not_found' } }
          : { status: 200, data: plainPromptDocument(selected.artifactId, markdown) };
      }
      throw new Error(`Unexpected freshness HTTP path: ${path}`);
    });
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials: { token: 'fresh-instructions-token', encryption: null } },
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'fresh-session', getMetadataSnapshot: () => createTestMetadata({ work: { memoryEnabled: true, promptStack: entries } }) }),
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project',
      memoryRecallGuidanceEnabled: false, readNativeSessionId: () => 'native', daemonBridge,
    });
    const absent = await resolve({ baseOverride: 'Base' });
    expect(resolve.readStartupInstructions?.()?.revision).toBe(1);
    expect(detailReads).toBe(1);
    markdown = 'Accepted instruction text';
    const present = await resolve({ baseOverride: 'Base' });
    expect(present).toContain(markdown);
    expect(present).not.toBe(absent);
    expect(resolve.readStartupInstructions?.()?.revision).toBe(2);
    expect(detailReads).toBe(2);
    expect(await resolve({ baseOverride: 'Base' })).toBe(present);
    expect(resolve.readStartupInstructions?.()?.revision).toBe(2);
    expect(detailReads).toBe(3);
    markdown = 'Changed accepted instructions';
    const edited = await resolve({ baseOverride: 'Base' });
    expect(edited).toContain(markdown);
    expect(edited).not.toContain('Accepted instruction text');
    expect(resolve.readStartupInstructions?.()?.revision).toBe(3);
    expect(detailReads).toBe(4);
  });
  it('retains a prepared instruction snapshot during an edit and reads current text at the next preparation and resume', async () => {
    let markdown = 'QA_PERSONA_ALPHA';
    let bodyVersion = 1;
    installPromptDocumentHeaderHttpBoundary(artifactId => {
      expect(artifactId).toBe('turn-instructions');
      return { ...plainPromptDocument(artifactId, markdown), bodyVersion };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      const document = { ...plainPromptDocument('turn-instructions', markdown), bodyVersion };
      if (path === '/v1/artifacts/turn-instructions') return { status: 200, data: document };
      throw new Error(`Unexpected instruction-turn HTTP path: ${path}`);
    });
    const params = {
      opts: { credentials: { token: 'turn-instructions-token', encryption: null } },
      session: Object.assign(createApiSessionClientFixture(), {
        sessionId: 'instruction-turn-session',
        getMetadataSnapshot: () => createTestMetadata({ work: { memoryEnabled: false, promptStack: [{
          id: 'session.instructions', ref: { kind: 'doc' as const, artifactId: 'turn-instructions' },
          enabled: true, required: true, placement: 'system_append' as const,
        }] } }),
      }),
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project',
      memoryRecallGuidanceEnabled: false, readNativeSessionId: () => 'resumed-native-thread', daemonBridge,
    };
    const resolve = createSessionPromptPlanResolver(params);
    expect(await resolve({ baseOverride: 'Base' })).toContain('QA_PERSONA_ALPHA');
    // An idle edit is observed by the immediately following preparation.
    markdown = 'QA_PERSONA_BRAVO'; bodyVersion += 1;
    expect(await resolve({ baseOverride: 'Base' })).toContain('QA_PERSONA_BRAVO');
    const running = resolve.readStartupInstructions?.();
    expect(running?.revision).toBe(2);
    // Dispatch retains this prepared value; editing its source cannot mutate it.
    markdown = 'QA_PERSONA_CHARLIE'; bodyVersion += 1;
    expect(resolve.assertPreparedPlanCurrent).not.toThrow();
    expect(resolve.readStartupInstructions?.()).toEqual(running);
    expect(running?.instructions).toContain('QA_PERSONA_BRAVO');
    expect(running?.instructions).not.toContain('QA_PERSONA_CHARLIE');
    const next = await resolve({ baseOverride: 'Base' });
    expect(next).toContain('QA_PERSONA_CHARLIE');
    expect(next).not.toContain('QA_PERSONA_BRAVO');
    expect(resolve.readStartupInstructions?.()?.revision).toBe(3);
    expect(running?.instructions).toContain('QA_PERSONA_BRAVO');
    // A reloaded Session creates a new producer while resuming its native thread.
    markdown = 'QA_PERSONA_DELTA'; bodyVersion += 1;
    const resumed = createSessionPromptPlanResolver(params);
    const reloaded = await resumed({ baseOverride: 'Base' });
    expect(reloaded).toContain('QA_PERSONA_DELTA');
    expect(reloaded).not.toContain('QA_PERSONA_CHARLIE');
  });
  it('retains the full-plan identity and advances its revision only when composed instructions change', async () => {
    let notes = 'Initial worker boundary';
    const resolve = createSessionPromptPlanResolver({
      opts: {
        credentials: { token: 'test-session-token', encryption: null },
        agentSessionStartupInstructionsV1: {
          v: 1, id: 'voice.caller', revision: 9, instructions: 'Caller startup guidance',
        },
      },
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'test-session', getMetadataSnapshot: () => createTestMetadata() }),
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project',
      memoryRecallGuidanceEnabled: false,
      readNativeSessionId: () => 'native-conversation',
      daemonBridge,
      resolveRoleContext: async () => ({
        role: { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder' }, notes,
      }),
    });
    const first = await resolve({ baseOverride: 'Base instructions' });
    expect(first).toContain('Caller startup guidance');
    expect(first).toContain(BUILT_IN_ROLES_V1.builder.instructions);
    expect(first).toContain(notes);
    expect(resolve.readStartupInstructions?.()).toEqual({
      v: 1, id: 'happier.coding_session_plan', revision: 9, instructions: first,
    });
    await resolve({ baseOverride: 'Base instructions' });
    expect(resolve.readStartupInstructions?.()?.revision).toBe(9);

    notes = 'Revised worker boundary';
    const revised = await resolve({ baseOverride: 'Base instructions' });
    expect(revised).toContain(notes);
    expect(resolve.readStartupInstructions?.()).toEqual({
      v: 1, id: 'happier.coding_session_plan', revision: 10, instructions: revised,
    });
    notes = 'Initial worker boundary';
    expect(await resolve({ baseOverride: 'Base instructions' })).toBe(first);
    expect(resolve.readStartupInstructions?.()?.revision).toBe(11);
    await resolve({ baseOverride: 'Base instructions' });
    expect(resolve.readStartupInstructions?.()?.revision).toBe(11);
  });
});
