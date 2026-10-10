import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { accountSettingsParse } from '@happier-dev/protocol';
import type { PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { resolveCliVoicePromptStackBlocks } from './resolveCliVoicePromptStackBlocks';
import { configuration } from '@/configuration';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  commitActivePromptLibraryCatalog, commitActiveProfileCatalog } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@happier-dev/protocol/voice/sessionBinding';
import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';

function entry(id: string): PromptStackEntryV1 {
  return {
    id,
    ref: { kind: 'doc', artifactId: id },
    enabled: true,
    placement: 'system_append',
  };
}
function doc(id: string, markdown: string): PromptLibraryStoredArtifact {
  return {
    id,
    header: { v: 1, kind: 'prompt_doc.v2', title: id },
    revision: { headerVersion: 1, bodyVersion: 1 },
    body: JSON.stringify({ v: 1, markdown, createdAtMs: 1, updatedAtMs: 1 }),
  };
}
describe('resolveCliVoicePromptStackBlocks', () => {
  afterEach(() => { clearActiveAccountSettingsSnapshot(); withdrawActiveProjectAccountRowsSnapshot(); vi.restoreAllMocks(); });
  it('refuses a real hidden Voice control Session whose target binding is missing or malformed', async () => {
    const hidden = buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true });
    for (const binding of [undefined, { v: 1, targetSessionId: null }]) {
      await expect(resolveCliVoicePromptStackBlocks({ sessionMetadata: { ...hidden, ...(binding ? { voiceConversationBindingV1: binding } : {}) },
        accountEntries: [], profileEntries: [], readArtifact: async () => null,
      })).rejects.toMatchObject({ reason: 'unavailable' });
    }
  });
  it('reads the hidden control binding and exact target Session instead of using its control or Voice profile', async () => {
    const credentials = { token: 'exact-session-reader', encryption: null };
    const hidden = buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true });
    let markdown = 'FIRST_TARGET';
    let retireOnBody = false;
    let retired = false;
    const sessionReads: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
      const id = path.slice('/v2/sessions/'.length);
      sessionReads.push(id);
      const metadata = id === 'history-session' ? { ...hidden, voiceConversationBindingV1: { v: 1, adapterId: 'local',
        controlSessionId: 'voice-global', transcriptMode: 'synthetic', targetSessionId: retired ? null : 'exact-target', updatedAt: 1 } }
        : id === 'exact-target' ? { profileId: 'target-profile', work: { promptStack: [entry('target-doc')] } }
          : (() => { throw new Error(`Unexpected exact Session read: ${path}`); })();
      return { status: 200, data: { session: { id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, archivedAt: null,
        encryptionMode: 'plain', metadataVersion: 0, agentState: null, agentStateVersion: 0, pendingCount: 0,
        pendingVersion: 0, share: null, metadata: JSON.stringify(metadata), dataEncryptionKey: null } } };
    });
    const args = { credentials, profileId: 'voice-profile', accountEntries: [], profileEntries: [],
      readArtifactHeader: async () => ({ header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' } }),
      sessionId: 'history-session', readArtifact: async (ref: { artifactId: string }) => {
        if (retireOnBody) retired = true;
        return doc(ref.artifactId, markdown);
      } };
    expect(await resolveCliVoicePromptStackBlocks(args)).toEqual(['FIRST_TARGET']);
    markdown = 'EDITED_TARGET';
    expect(await resolveCliVoicePromptStackBlocks(args)).toEqual(['EDITED_TARGET']);
    expect([...new Set(sessionReads)]).toEqual(['history-session', 'exact-target']);
    retireOnBody = true;
    await expect(resolveCliVoicePromptStackBlocks(args)).rejects.toMatchObject({ reason: 'unavailable', admittedEntries: [] });
  });
  it('uses real target Account Profile Project Session and conversational Role owners in canonical order', async () => {
    const serverId = configuration.activeServerId;
    const credentials = { token: 'four-layer-target-reader', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    const bound = { scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    commitActivePromptLibraryCatalog({ ...bound, catalog: { status: 'ready', rows: [{ revision: 1,
      record: { key: 'voice', value: { v: 1, scope: { kind: 'voice' }, entries: [entry('account')] } } }], tombstones: [], diagnostics: [] } });
    commitActiveProfileCatalog({ ...bound, catalog: { status: 'ready', authority: 'active', control: null, controlRevision: 'absent',
      referenceGuardRevision: 'absent', diagnostics: [], records: ['target-profile', 'voice-profile'].map(id => ({ revision: 1,
        record: { v: 1, id, enabled: true, secretBindings: {}, definition: { kind: 'artifact', artifactId: `${id}-definition` }, promptStack: [entry(id)] } })) } });
    const workspaceKey = { kind: 'workspace-ref', serverId, id: 'checkout' };
    const projectKey = { kind: 'project-organization', serverId, projectKey: 'project' };
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
      { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey,
        value: { id: 'checkout', serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 } } } },
      { key: projectKey, revision: 1, content: { t: 'plain', v: { key: projectKey, value: { promptStack: [entry('project')] } } } },
    ] } });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path !== '/v2/sessions/ordinary-target') throw new Error(`Unexpected qualified read: ${path}`);
      return { status: 200, data: { session: { id: 'ordinary-target', seq: 1, createdAt: 1, updatedAt: 1, active: true,
        activeAt: 1, archivedAt: null, encryptionMode: 'plain', metadataVersion: 0, agentState: null, agentStateVersion: 0,
        pendingCount: 0, pendingVersion: 0, share: null, dataEncryptionKey: null, metadata: JSON.stringify({
          profileId: 'target-profile', workspaceId: 'checkout', projectId: 'project', machineId: 'machine', path: '/repo',
          work: { promptStack: [entry('session')], sessionRolesV1: { roleId: 'builder', inheritedFrom: 'lead', overrides: {}, notes: 'ROLE_NOTES',
            sessionRoles: { builder: { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder', instructions: 'ROLE_PERSONA', workspaceWrites: 'allow' } } } },
        }) } } };
    });
    const blocks = await resolveCliVoicePromptStackBlocks({ credentials, serverId, sessionId: 'ordinary-target', profileId: 'voice-profile',
      readArtifactHeader: async () => ({ header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' } }),
      readArtifact: async ref => doc(ref.artifactId, ref.artifactId) });
    expect(blocks.slice(0, 4)).toEqual(['account', 'target-profile', 'project', 'session']);
    expect(blocks[4]).toContain('ROLE_PERSONA');
    expect(blocks[4]).toContain('ROLE_NOTES');
    expect(blocks.join('\n')).not.toContain('voice-profile');
    expect(blocks[4]).not.toContain('lead_session_id');
  });
  it('keeps explicit hidden global Voice free of misleading control Profile Project Session and Role facts', async () => {
    const hidden = buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true });
    expect(await resolveCliVoicePromptStackBlocks({ profileId: 'control-profile', accountEntries: [entry('account')],
      profileEntries: [entry('control-profile')], projectEntries: [entry('control-project')], sessionEntries: [entry('control-session')],
      roleContext: { availableRoles: [], notes: 'CONTROL_ROLE_NOTES' },
      sessionMetadata: { ...hidden, profileId: 'history-profile', workspaceId: 'history-project', work: { promptStack: [entry('history-doc')] },
        voiceConversationBindingV1: { v: 1, adapterId: 'local', controlSessionId: 'control-session', transcriptMode: 'synthetic',
          targetSessionId: null, updatedAt: 1 } }, readArtifact: async ref => doc(ref.artifactId, ref.artifactId),
    })).toEqual(['account']);
  });
  it('renders an exact target Notes-only persona without demanding unrelated Role inventory', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
      if (path !== '/v2/sessions/notes-target') throw new Error(`Role sources unavailable: ${path}`);
      return { status: 200, data: { session: { id: 'notes-target', seq: 1, createdAt: 1, updatedAt: 1, active: true,
        activeAt: 1, archivedAt: null, encryptionMode: 'plain', metadataVersion: 0, agentState: null, agentStateVersion: 0,
        pendingCount: 0, pendingVersion: 0, share: null, dataEncryptionKey: null, metadata: JSON.stringify({ work: {
          sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'NOTES_ONLY_PERSONA' },
        } }) } } };
    });
    const blocks = await resolveCliVoicePromptStackBlocks({ credentials: { token: 'notes-only-reader', encryption: null },
      sessionId: 'notes-target', accountEntries: [], profileEntries: [], readArtifact: async () => null });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('NOTES_ONLY_PERSONA');
  });
  it('uses current destination Voice and Profile stacks independently of the Settings revision and refuses unavailable rows', async () => {
    const credentials = { token: 'voice-bound-account', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const settings = { promptStacksV1: { v: 1, surfaces: { voice: [entry('stale-voice')], profilesById: { work: [entry('stale-profile')] } } } };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(settings), rawSettings: settings,
      settingsVersion: 5, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    const bound = { scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    const publishVoice = (id: string) => commitActivePromptLibraryCatalog({ ...bound, catalog: { status: 'ready', rows: [{ revision: 2,
      record: { key: 'voice', value: { v: 1, scope: { kind: 'voice' }, entries: [entry(id)] } } }], tombstones: [], diagnostics: [] } });
    publishVoice('current-voice');
    commitActiveProfileCatalog({ ...bound, catalog: { status: 'ready', authority: 'active', control: null,
      controlRevision: 'absent', referenceGuardRevision: 'absent', diagnostics: [],
      records: [{ revision: 2, record: { v: 1, id: 'work', enabled: true, secretBindings: {},
        definition: { kind: 'artifact', artifactId: 'profile-definition' }, promptStack: [entry('current-profile')] } }] } });
    const args = { credentials, serverId: configuration.activeServerId, settings, profileId: 'work',
      readArtifact: async (ref: { artifactId: string }) => doc(ref.artifactId, ref.artifactId) };
    expect(await resolveCliVoicePromptStackBlocks(args)).toEqual(['current-voice', 'current-profile']);
    publishVoice('next-voice');
    expect(await resolveCliVoicePromptStackBlocks(args)).toEqual(['next-voice', 'current-profile']);
    commitActivePromptLibraryCatalog({ ...bound, catalog: { status: 'unavailable', reason: 'unreachable' } });
    let available = false;
    // Canonical demand recovery runs above the genuine HTTP transport boundary.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (!available) return { status: 503, data: { error: 'unavailable' } };
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
        settingsVersion: 5, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 5, content: { t: 'plain', v: {} } } };
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [{ key: 'voice', revision: 3,
        content: { t: 'plain', v: { key: 'voice', value: { v: 1, scope: { kind: 'voice' }, entries: [entry('recovered-voice')] } } } },
        ...PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== 'voice').map(key => ({ key, revision: 1, content: null }))] } };
      throw new Error(`Unexpected Voice Account GET ${path}`);
    });
    await expect(resolveCliVoicePromptStackBlocks(args)).rejects.toMatchObject({ status: 'preparation_pending', reason: 'unavailable' });
    available = true;
    expect(await resolveCliVoicePromptStackBlocks(args)).toEqual(['recovered-voice', 'current-profile']);
  });
  it('uses the actual remembered builtin selection reader for Voice without inventing private membership or retained attachments', async () => {
    const credentials = { token: 'voice-rowless-builtin', encryption: null };
    const profileId = 'gemini-api-key';
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    let settingsVersion = 5;
    let rawSettings: Record<string, unknown> = { promptStacksV1: { v: 1,
      surfaces: { profilesById: { [profileId]: [entry('stale-builtin-prompt')] } } } };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(rawSettings), rawSettings,
      settingsVersion, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    const bound = { scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    commitActivePromptLibraryCatalog({ ...bound, catalog: { status: 'ready', rows: [{ revision: 2,
      record: { key: 'voice', value: { v: 1, scope: { kind: 'voice' }, entries: [entry('current-voice')] } } }], tombstones: [], diagnostics: [] } });
    commitActiveProfileCatalog({ ...bound, catalog: { status: 'ready', authority: 'inactive', source: 'destination', control: null,
      controlRevision: 'absent', referenceGuardRevision: 'absent', diagnostics: [], records: [] } });
    // Only Home HTTP and the qualified document boundary are replaced. The
    // Account Profile/Artifact/AuthoringMemory readers and admission stay real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
        settingsVersion, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: settingsVersion, content: { t: 'plain', v: rawSettings } } };
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: {
        status: 'present', revision: 1, content: { t: 'plain', v: profileId } } };
      throw new Error(`Unexpected rowless Voice selection boundary: ${path}`);
    });
    const args = { credentials, serverId: configuration.activeServerId, profileId,
      readArtifact: async (ref: { artifactId: string }) => doc(ref.artifactId, ref.artifactId) };
    expect(await resolveCliVoicePromptStackBlocks(args)).toEqual(['current-voice']);
    rawSettings = { ...rawSettings, profileEnabledById: { [profileId]: false } };
    settingsVersion += 1;
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(rawSettings), rawSettings,
      settingsVersion, loadedAtMs: 2, settingsSecretsReadKeys: [], scopeKey });
    await expect(resolveCliVoicePromptStackBlocks(args)).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(resolveCliVoicePromptStackBlocks({ ...args, profileId: 'unknown' })).rejects.toMatchObject({ reason: 'unavailable' });
  });
  it('withdraws partial admitted document facts when the original Account retires during a failed body request', async () => {
    const accountId = 'voice-private-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    commitActivePromptLibraryCatalog({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      catalog: { status: 'ready', rows: [{ revision: 1, record: { key: 'voice', value: { v: 1,
        scope: { kind: 'voice' }, entries: [entry('private-first'), { ...entry('private-second'), required: true }] } } }],
      tombstones: [], diagnostics: [] } });
    const bodyRequests: string[] = [];
    let retirementObserved = false;
    // Only HTTP is replaced: the canonical Home, source admission, Artifact
    // reader, plain envelope codec and Protocol preparation remain real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
        settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
      if (path.startsWith('/v1/artifacts/')) {
        bodyRequests.push(path);
        if (path === '/v1/artifacts/private-second') {
          clearActiveAccountSettingsSnapshot();
          retirementObserved = true;
          return { status: 503, data: { error: 'unavailable' } };
        }
        if (path === '/v1/artifacts/private-first') return { status: 200, data: {
          id: 'private-first', ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
          header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Private first' }),
          body: encodePlainArtifactStoredContent({ body: doc('private-first', 'Private first content').body }),
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
          seq: 1, createdAt: 1, updatedAt: 1,
        } };
      }
      throw new Error(`Unexpected Voice Artifact GET ${path}`);
    });
    const error = await resolveCliVoicePromptStackBlocks({ credentials, serverId: configuration.activeServerId,
      scope: { serverId: configuration.activeServerId, accountId } }).then(() => null, (reason: unknown) => reason);
    expect(bodyRequests).toEqual(['/v1/artifacts/private-first', '/v1/artifacts/private-second']);
    expect(retirementObserved).toBe(true);
    expect(error).toBeInstanceOf(PromptStackPreparationError);
    expect(error).toMatchObject({ status: 'preparation_pending', reason: 'unavailable', admittedEntries: [] });
  });
  it('omits Account context for unbound global Voice', async () => {
    expect(await resolveCliVoicePromptStackBlocks()).toEqual([]);
  });
  it('prepares the admitted Session layer and its memory policy independently of an empty global stack', async () => {
    const bodies: string[] = [];
    const args = {
      accountEntries: [], profileEntries: [],
      sessionMetadata: { work: { memoryEnabled: false, disabledInheritedEntryIds: ['inherited'],
        promptStack: [entry('session'), { ...entry('memory'), required: true }] } },
      projectEntries: [entry('inherited')],
      readArtifactHeader: async ({ artifactId }: { artifactId: string }) => ({
        header: { v: 1, kind: artifactId === 'memory' ? 'memory_doc.v1' : 'prompt_doc.v2', title: artifactId },
      }),
      readArtifact: async ({ artifactId }: { artifactId: string }) => {
        bodies.push(artifactId);
        return doc(artifactId, artifactId === 'session' ? 'Exact target persona' : artifactId);
      },
    };
    expect(await resolveCliVoicePromptStackBlocks(args)).toEqual(['Exact target persona']);
    expect(bodies).toEqual(['session']);
  });
  it('uses admitted four-layer inputs and current qualified documents without requiring ambient credentials', async () => {
    // The bound Voice host supplies this qualified remote-document read port.
    const rows = new Map(
      ['account', 'profile', 'project', 'session'].map((id) => [
        id,
        doc(id, id),
      ]),
    );
    const args = {
      settings: {},
      credentials: null,
      accountEntries: [entry('account')],
      profileEntries: [entry('profile')],
      projectEntries: [entry('project')],
      sessionEntries: [entry('session')],
      readArtifact: async (ref: { artifactId: string }) =>
        rows.get(ref.artifactId) ?? null,
    };
    expect(await resolveCliVoicePromptStackBlocks(args)).toEqual([
      'account',
      'profile',
      'project',
      'session',
    ]);
    rows.set('session', doc('session', 'current second turn'));
    expect(await resolveCliVoicePromptStackBlocks(args)).toEqual([
      'account',
      'profile',
      'project',
      'current second turn',
    ]);
  });
  it('retains genuine predecessor Voice/profile selection without coding entries', async () => {
    const args = {
      // Retained layers have already been admitted by the canonical source port.
      accountEntries: [entry('voice')],
      profileEntries: [entry('profile')],
      profileId: 'work',
      readArtifact: async (ref: { artifactId: string }) =>
        doc(ref.artifactId, ref.artifactId),
    };
    expect(await resolveCliVoicePromptStackBlocks(args)).toEqual([
      'voice',
      'profile',
    ]);
  });
  it('suppresses required inherited memory before a bound body read when memory is off', async () => {
    expect(
      await resolveCliVoicePromptStackBlocks({
        settings: {},
        accountEntries: [{ ...entry('memory'), required: true }],
        memoryEnabled: false,
        readArtifactHeader: async () => ({ header: { kind: 'memory_doc.v1' } }),
        readArtifact: async () => {
          throw new Error('Suppressed memory body must not be read');
        },
      }),
    ).toEqual([]);
  });
});
