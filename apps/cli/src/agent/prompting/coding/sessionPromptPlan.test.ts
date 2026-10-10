import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { BUILT_IN_ROLES_V1, accountSettingsParse } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { DaemonAgentRuntimeTurnContributionsBridge } from '@/agent/runtime/session/process/agentRuntimeDaemonTurnContributionsBridge';

import { createSessionPromptPlanResolver } from './sessionPromptPlan';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { resolveSessionNativeToolDescriptors } from '@/agent/tools/happierTools/resolveSessionNativeToolBridge';
import { shouldDenyAgentSessionTitleToolCall } from '@/agent/permissions/codingPromptTitlePermission';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { CodexLikePermissionHandler } from '@/agent/permissions/CodexLikePermissionHandler';
import { applySessionRuntimeControls } from '@/api/session/sessionRuntimeControls';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, beginActiveProfileCatalogRefresh, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
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

function createProjectedIdentityTestMetadata(params: Parameters<typeof projectSessionOwnerCompatibilityViewV1>[0]) {
  const { work, bot, createdAsBot } = projectSessionOwnerCompatibilityViewV1(params);
  return createTestMetadata({ work, bot, createdAsBot });
}

describe('session prompt-plan producer', () => {
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

  it('keeps opaque plan evidence scoped to the prepared Session and withdraws it with the current Profile', async () => {
    let metadata = createTestMetadata();
    const params = { opts: { credentials: { token: 'context-token', encryption: null } },
      session: { sessionId: 'composition-session', getMetadataSnapshot: () => metadata },
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
      session: { sessionId: 'created-bot', getMetadataSnapshot: () => metadata },
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
      session: { sessionId: 'promoted-session', getMetadataSnapshot: () => metadata },
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project',
      memoryRecallGuidanceEnabled: false, readNativeSessionId: () => 'native', daemonBridge,
    });
    expect(await resolve()).not.toMatch(/focus question/i);
  });

  it('demand-loads the current Account prompt rows before the first preparation', async () => {
    const credentials = { token: 'first-context-token', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, scopeKey,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
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
      if (path === '/v1/artifacts') return { status: 200, data: [row] };
      if (path === '/v1/artifacts/first') return { status: 200, data: row };
      throw new Error(`Unexpected first preparation HTTP path: ${path}`);
    });
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials, accountSettingsContext: { source: 'network', settings, scopeKey,
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], whenRefreshed: null } },
      session: { sessionId: 'test-session', getMetadataSnapshot: () => createTestMetadata() },
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project', memoryRecallGuidanceEnabled: false,
      readNativeSessionId: () => 'native', daemonBridge,
    });
    expect(await resolve({ baseOverride: 'Base' })).toContain('First admitted Account context');
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
      session: { sessionId: 'test-session', getMetadataSnapshot: () => createTestMetadata() },
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
      session: { sessionId: 'test-session', getMetadataSnapshot: () => createTestMetadata({ work: { memoryEnabled: true,
        promptStack: [{ id: 'current', ref: { kind: 'doc', artifactId: 'current' }, enabled: true, placement: 'system_append' }] } }) },
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

  it('withdraws prepared policy after a catalog-only Profile change without a Settings revision change', async () => {
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
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } } : { status: 200, data: [] });
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials, accountSettingsContext: { source: 'network', settings, scopeKey,
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], whenRefreshed: null } },
      session: { sessionId: 'test-session', getMetadataSnapshot: () => createTestMetadata({ profileId: 'focused' }) },
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project', memoryRecallGuidanceEnabled: false,
      readNativeSessionId: () => 'native', daemonBridge,
    });
    await resolve();
    expect(resolve.readCodingPromptBehavior?.()?.sessionTitleUpdates).toBe('ongoing');
    beginActiveProfileCatalogRefresh({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
    expect(resolve.readCodingPromptBehavior?.()).toBeNull();
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
      session: { sessionId: 'test-session', getMetadataSnapshot: metadata },
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
        : { status: 200, data: available ? [row] : [] };
      if (path === '/v1/artifacts/published-profile') return available
        ? { status: 200, data: row } : { status: 404, data: { error: 'not_found' } };
      throw new Error(`Unexpected HTTP path: ${path}`);
    });
    const settings = accountSettingsParse({ profiles: source === 'owned' ? [{ artifactId: 'published-profile' }] : [] });
    const credentials = { token: 'published-profile-test-token', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: { profiles: settings.profiles }, scopeKey,
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
    const handlers = [createProviderEnforcedPermissionHandler({ session, logPrefix: '[Test]', ...policy }),
      new CodexLikePermissionHandler({ session, logPrefix: '[Test]', ...policy })];
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
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      const row = { id: 'stack-doc', ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Stack' }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown, createdAtMs: 1, updatedAtMs: 1 }) }),
      };
      return { status: 200, data: path === '/v1/artifacts' ? [row] : row };
    });
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials: { token: 'test-token', encryption: null },
        accountSettingsContext: { source: 'cache', settingsVersion: 1, loadedAtMs: 1,
          settingsSecretsReadKeys: [], whenRefreshed: null, settings: accountSettingsParse({ promptStacksV1: {
          v: 1, surfaces: { coding: [{ id: 'stack-entry', ref: { kind: 'doc', artifactId: 'stack-doc' },
            enabled: true, placement: 'system_append', editPolicy: 'user_only' }], voice: [], profilesById: {} },
        } }) } },
      session: { sessionId: 'test-session', getMetadataSnapshot: () => null },
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
      session: { sessionId: 'fresh-session', getMetadataSnapshot: () => createTestMetadata({ work: { memoryEnabled: true, promptStack: entries } }) },
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
  it('retains the full-plan identity and advances its revision only when composed instructions change', async () => {
    let notes = 'Initial worker boundary';
    const resolve = createSessionPromptPlanResolver({
      opts: {
        credentials: { token: 'test-session-token', encryption: null },
        agentSessionStartupInstructionsV1: {
          v: 1, id: 'voice.caller', revision: 9, instructions: 'Caller startup guidance',
        },
      },
      session: { sessionId: 'test-session', getMetadataSnapshot: () => null },
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
