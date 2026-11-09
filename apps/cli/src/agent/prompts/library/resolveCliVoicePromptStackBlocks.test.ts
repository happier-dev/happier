import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { accountSettingsParse } from '@happier-dev/protocol';
import type { PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { resolveCliVoicePromptStackBlocks, resolveCliVoicePromptPreparation } from './resolveCliVoicePromptStackBlocks';
import { configuration } from '@/configuration';
import { classifyHomeReadPreparationError } from './homeReadPreparationError';
import { logger } from '@/ui/logger';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { projectAccountRowReadResponse } from '@/testkit/http/projectAccountRows';
import type { ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
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
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { readSettings, writeSettings, writeStoredCredentialsForServerId } from '@/persistence';

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
async function installExactHomeIdentity(profileId: string, homeServerIdentityId: string) {
  const previous = await readSettings();
  await writeSettings({ ...previous, servers: { ...previous.servers, [profileId]: {
    id: profileId, name: 'Receipt Home', serverUrl: 'https://receipt.example.test', webappUrl: 'https://receipt.example.test',
    // A valid stored descriptor is read back with exact authority.
    createdAt: 1, updatedAt: 1, lastUsedAt: 1,
    homeConnectionDescriptor: { v: 1, homeServerIdentityId, canonicalServerUrl: 'https://receipt.example.test', revision: 1,
      endpoints: [{ kind: 'https', url: 'https://receipt.example.test' }] },
  } } });
  onTestFinished(async () => { await writeSettings(previous); });
}
describe('resolveCliVoicePromptStackBlocks', () => {
  it('records the original Home cause before its safe preparation carrier replaces it', () => {
    const logs = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const error = Object.assign(new TypeError('private prompt and credential'), { code: 'ECONNRESET' });
    expect(classifyHomeReadPreparationError(error)).toMatchObject({ reason: 'unavailable' });
    expect(logs).toHaveBeenCalledWith('[Session] Prompt preparation failed', expect.objectContaining({
      step: 'home.read', errorClass: 'TypeError', errorCode: 'ECONNRESET',
    }));
    expect(JSON.stringify(logs.mock.calls)).not.toContain('private');
  });

  it.each(['ECONNRESET', 'private-credential'] as const)('privately discriminates target currentness failure without copying content (%s)', async code => {
    const logs = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    vi.spyOn(axios, 'get').mockRejectedValue(Object.assign(new TypeError('private prompt and credential'), {
      code, config: { headers: { authorization: 'private bearer' } },
    }));
    await expect(resolveCliVoicePromptPreparation({
      sessionId: 'private-session', credentials: { token: 'private-token', encryption: null },
    })).rejects.toMatchObject({ reason: 'unavailable' });
    expect(logs).toHaveBeenCalledWith('[Session] Prompt preparation failed', expect.objectContaining({
      step: 'target.currentness', errorClass: 'AccountEncryptionCurrentnessUnavailableError', causeClass: 'TypeError',
      causeCode: code === 'ECONNRESET' ? code : 'unclassified',
    }));
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/private|authorization|bearer/);
  });

  it.each(['Instructions', ''])('receipts only the admitted reserved Session instruction entry (%j)', async markdown => {
    await installExactHomeIdentity('home', 'srv_receipt_home');
    const args = { sessionId: 'target', serverId: 'home', accountEntries: [], profileEntries: [], projectEntries: [],
      sessionMetadata: { work: { promptStack: [{ ...entry('session.instructions'), required: true }] } },
      readArtifactHeader: async () => ({ header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' } }),
      readArtifact: async () => doc('session.instructions', markdown) };
    expect(await resolveCliVoicePromptPreparation(args)).toHaveProperty('preparedInstructionsFor', { serverId: 'srv_receipt_home', sessionId: 'target' });
    expect(await resolveCliVoicePromptPreparation({ ...args, serverId: 'unknown-profile' })).not.toHaveProperty('preparedInstructionsFor');
    expect(await resolveCliVoicePromptPreparation({ ...args, sessionMetadata: { work: { promptStack: [entry('other')] } } }))
      .not.toHaveProperty('preparedInstructionsFor');
    expect(await resolveCliVoicePromptPreparation({ ...args, sessionId: null, sessionMetadata: undefined }))
      .not.toHaveProperty('preparedInstructionsFor');
  });
  afterEach(() => { clearActiveAccountSettingsSnapshot(); withdrawActiveProjectAccountRowsSnapshot(); vi.restoreAllMocks(); });
  it('refuses a real hidden Voice control Session whose target binding is missing or malformed', async () => {
    const hidden = buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true });
    const logs = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    for (const binding of [undefined, { v: 1, targetSessionId: null }]) {
      logs.mockClear();
      await expect(resolveCliVoicePromptStackBlocks({ sessionMetadata: { ...hidden, ...(binding ? { voiceConversationBindingV1: binding } : {}) },
        accountEntries: [], profileEntries: [], readArtifact: async () => null,
      })).rejects.toMatchObject({ reason: 'unavailable' });
      expect(logs).toHaveBeenCalledWith('[Session] Prompt preparation failed', expect.objectContaining({
        step: 'target.binding', errorClass: 'VoicePromptTargetBindingError',
        errorCode: binding ? 'voice_target_binding_invalid' : 'voice_target_binding_missing',
        ...(binding ? { causeClass: '$ZodError', schemaIssues: expect.arrayContaining([
          expect.objectContaining({ code: 'invalid_value', path: ['transcriptMode'] }),
        ]) } : {}),
      }));
    }
  });
  it.each([null, 'global-carrier', 'nested-carrier'] as const)('keeps Global native prompt scope unbound and refuses carrier targets (%s)', async targetSessionId => {
    const logs = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const hidden = buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true });
    const metadata = { ...hidden, profileId: 'carrier-profile', voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
      voiceConversationBindingV1: { v: 1, adapterId: 'happier.agent.codex/realtime-codex',
        controlSessionId: 'global-carrier', transcriptMode: 'native_session', targetSessionId, updatedAt: 1 } };
    const sessionReads: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
      const id = path.slice('/v2/sessions/'.length);
      sessionReads.push(id);
      if (id !== 'global-carrier' && id !== 'nested-carrier') throw new Error('Unexpected Session read');
      return { status: 200, data: { session: { id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        archivedAt: null, encryptionMode: 'plain', metadataVersion: 1, agentState: null, agentStateVersion: 0,
        pendingCount: 0, pendingVersion: 0, share: null, dataEncryptionKey: null,
        metadata: JSON.stringify(id === 'global-carrier' ? metadata : { ...hidden,
          voiceConversationScopeV1: { v: 1, kind: 'session_root', sessionRootId: 'ordinary-root' } }) } } };
    });
    const preparation = resolveCliVoicePromptPreparation({
      sessionId: 'global-carrier', credentials: { token: 'global-reader', encryption: null }, sessionMetadata: metadata,
      accountEntries: [entry('account')], profileEntries: [entry('carrier-profile')],
      roleContext: { availableRoles: [], notes: 'CARRIER_ROLE_MUST_NOT_LEAK' },
      readArtifact: async ref => doc(ref.artifactId, ref.artifactId),
    });
    if (targetSessionId === null) {
      await expect(preparation).resolves.toMatchObject({ systemAppendBlocks: ['account'] });
      expect([...new Set(sessionReads)]).toEqual(['global-carrier']);
    } else {
      await expect(preparation).rejects.toMatchObject({ reason: 'unavailable' });
      expect(logs).toHaveBeenCalledWith('[Session] Prompt preparation failed', expect.objectContaining({
        step: 'target.binding', errorCode: 'voice_target_binding_target_is_carrier',
      }));
      // The prompt reader must reject nesting, not recursively follow another carrier's scope.
      expect(sessionReads).not.toContain('ordinary-root');
    }
  });
  it.each([false, true])('reads the hidden control binding and exact target Session with a native host snapshot=%s', async suppliedSnapshot => {
    await installExactHomeIdentity(configuration.activeServerId, 'srv_control_home');
    const credentials = { token: 'exact-session-reader', encryption: null };
    const hidden = buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true });
    let markdown = 'FIRST_TARGET';
    let retireOnBody = false;
    let retired = false;
    let controlRetired = false;
    const sessionReads: string[] = [];
    // Run 49 carrier shape, with identities/content replaced: hidden voice_home, local native transcript.
    const controlMetadata = () => ({ ...hidden, voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
      voiceConversationBindingV1: { v: 1, adapterId: 'local_conversation', controlSessionId: 'voice-global',
        transcriptMode: 'native_session', targetSessionId: retired ? null : 'exact-target', targetServerId: 'srv_control_home', updatedAt: 1 } });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
      const id = path.slice('/v2/sessions/'.length);
      sessionReads.push(id);
      const metadata = id === 'history-session' ? (controlRetired ? {} : controlMetadata())
        : id === 'exact-target' ? { profileId: 'target-profile', voiceConversationBindingV1: {
          v: 1, adapterId: 'happier.agent.codex/realtime-codex', controlSessionId: 'exact-target',
          transcriptMode: 'native_session', targetSessionId: 'exact-target', targetServerId: 'srv_control_home', updatedAt: 1 }, work: { promptStack: [{ ...entry('session.instructions'), ref: { kind: 'doc', artifactId: 'target-doc' }, required: true }] } }
          : (() => { throw new Error(`Unexpected exact Session read: ${path}`); })();
      return { status: 200, data: { session: { id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, archivedAt: null,
        encryptionMode: 'plain', metadataVersion: 0, agentState: null, agentStateVersion: 0, pendingCount: 0,
        pendingVersion: 0, share: null, metadata: JSON.stringify(metadata), dataEncryptionKey: null } } };
    });
    const args = { credentials, serverId: configuration.activeServerId, machineId: 'machine', profileId: 'voice-profile', accountEntries: [], profileEntries: [],
      ...(suppliedSnapshot ? { sessionMetadata: controlMetadata(),
        roleContext: { availableRoles: [], notes: 'CONTROL_ROLE_NOTES' } } : {}),
      readArtifactHeader: async () => ({ header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' } }),
      sessionId: 'history-session', readArtifact: async (ref: { artifactId: string }) => {
        if (retireOnBody) retired = true;
        return doc(ref.artifactId, markdown);
      } };
    expect(await resolveCliVoicePromptStackBlocks(args)).toEqual(['FIRST_TARGET']);
    expect(await resolveCliVoicePromptPreparation(args)).toHaveProperty('preparedInstructionsFor', {
      serverId: 'srv_control_home', sessionId: 'exact-target',
    });
    markdown = 'EDITED_TARGET';
    expect(await resolveCliVoicePromptStackBlocks(args)).toEqual(['EDITED_TARGET']);
    expect([...new Set(sessionReads)]).toEqual(['history-session', 'exact-target']);
    retireOnBody = true;
    await expect(resolveCliVoicePromptStackBlocks(args)).rejects.toMatchObject({ reason: 'unavailable', admittedEntries: [] });
    if (suppliedSnapshot) {
      // A snapshot captured as a carrier cannot be reinterpreted as an ordinary target after retirement.
      retireOnBody = false;
      retired = false;
      controlRetired = true;
      await expect(resolveCliVoicePromptStackBlocks(args)).rejects.toMatchObject({ reason: 'unavailable' });
    }
  });
  it.each(['foreign', 'same'] as const)('reads a %s-Home Voice target with the correct Account custody', async relationship => {
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    try {
      await withTempDir('happier-voice-target-home-', async homeDir => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
          HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
        reloadConfiguration();
        const settings = await readSettings();
        await writeSettings({ ...settings, servers: { ...settings.servers, target: {
          id: 'target', name: 'Target', serverUrl: 'https://target-auth.example.test',
          localServerUrl: 'http://127.0.0.1:43127', webappUrl: 'https://target-app.example.test',
          createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        } } });
        await writeStoredCredentialsForServerId('target', { token: 'target-home-reader', encryption: null });
        const { adoptServerProfileHomeConnectionDescriptor } = await import('@/server/serverProfiles');
        if (relationship === 'same') await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: 'target', observation: 'exact', descriptor: {
          v: 1, homeServerIdentityId: 'srv_voice_target', canonicalServerUrl: 'https://target-auth.example.test',
          revision: 1, endpoints: [{ kind: 'https', url: 'https://target-auth.example.test' }],
        } });
        const hidden = buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true });
        const targetReads: string[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
          const parsed = new URL(String(url));
          const target = parsed.pathname === '/v2/sessions/exact-target'
            || options?.headers?.Authorization === 'Bearer target-home-reader';
          if (target) targetReads.push(String(url));
          expect(options?.headers?.Authorization).toBe(relationship === 'same' || !target
            ? 'Bearer control-home-reader' : 'Bearer target-home-reader');
          expect(parsed.origin).toBe(target && relationship === 'foreign' ? 'http://127.0.0.1:43127' : 'https://control.example.test');
          if (parsed.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
            mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
          } };
          const id = target ? 'exact-target' : 'history-session';
          expect(parsed.pathname).toBe(`/v2/sessions/${id}`);
          const metadata = target ? { work: { promptStack: [entry('target-doc')] } } : { ...hidden,
            voiceConversationBindingV1: { v: 1, adapterId: 'local', controlSessionId: 'voice-global',
              transcriptMode: 'synthetic', targetSessionId: 'exact-target', targetServerId: 'target', updatedAt: 1 } };
          return { status: 200, data: { session: { id, seq: 1, createdAt: 1, updatedAt: 1,
            active: true, activeAt: 1, archivedAt: null, encryptionMode: 'plain', metadataVersion: 0,
            agentState: null, agentStateVersion: 0, pendingCount: 0, pendingVersion: 0,
            share: null, metadata: JSON.stringify(metadata), dataEncryptionKey: null } } };
        });
        const outcome = await resolveCliVoicePromptStackBlocks({
          credentials: { token: 'control-home-reader', encryption: null }, serverId: relationship === 'same' ? 'srv_voice_target' : 'control',
          serverUrl: 'https://control.example.test', sessionId: 'history-session', machineId: 'machine',
          accountEntries: [], profileEntries: [],
          readArtifactHeader: async () => ({ header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' } }),
          readArtifact: async ref => doc(ref.artifactId, 'EXACT_TARGET_HOME'),
        }).catch(error => error);
        expect(outcome).toEqual(['EXACT_TARGET_HOME']);
        expect(targetReads).toEqual(relationship === 'foreign'
          ? ['http://127.0.0.1:43127/v1/account/encryption/currentness', 'http://127.0.0.1:43127/v2/sessions/exact-target']
          : ['https://control.example.test/v2/sessions/exact-target']);
        expect((await readSettings()).activeServerId).toBe(settings.activeServerId);
      });
    } finally {
      envScope.restore();
      reloadConfiguration();
    }
  });
  it.each(['ids', 'path', 'unregistered', 'unavailable'] as const)('uses real target Account Profile Project Session and conversational Role owners in canonical order (%s)', async association => {
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
        record: { v: 1, id, enabled: true, secretBindings: {}, skillSeeds: [], definition: { kind: 'artifact', artifactId: `${id}-definition` }, promptStack: [entry(id)] } })) } });
    const workspaceKey = { kind: 'workspace-ref', serverId, id: 'checkout' } satisfies ProjectAccountRowV1['key'];
    const projectKey = { kind: 'project-organization', serverId, projectKey: 'project' } satisfies ProjectAccountRowV1['key'];
    const projectRows = [
      { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey,
        value: { id: 'checkout', serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 } } } },
      { key: projectKey, revision: 1, content: { t: 'plain', v: { key: projectKey, value: { promptStack: [entry('project')] } } } },
    ] satisfies readonly ProjectAccountRowV1[];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (association === 'unavailable') throw Object.assign(new Error('Project Home unavailable'), { code: 'ECONNRESET' });
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/read')) return projectAccountRowReadResponse(projectRows, body);
      if (path.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows: projectRows } };
      throw new Error(`Unexpected Project Account POST ${path}`);
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path !== '/v2/sessions/ordinary-target') throw new Error(`Unexpected qualified read: ${path}`);
      return { status: 200, data: { session: { id: 'ordinary-target', seq: 1, createdAt: 1, updatedAt: 1, active: true,
        activeAt: 1, archivedAt: null, encryptionMode: 'plain', metadataVersion: 0, agentState: null, agentStateVersion: 0,
        pendingCount: 0, pendingVersion: 0, share: null, dataEncryptionKey: null, metadata: JSON.stringify({
          profileId: 'target-profile', ...(association === 'ids' ? { workspaceId: 'checkout', projectId: 'project' } : {}),
          machineId: 'machine', path: association === 'unregistered' ? '/unregistered' : '/repo',
          work: { promptStack: [entry('session')], sessionRolesV1: { roleId: 'builder', inheritedFrom: 'lead', overrides: {}, notes: 'ROLE_NOTES',
            sessionRoles: { builder: { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder', instructions: 'ROLE_PERSONA', workspaceWrites: 'allow' } } } },
        }) } } };
    });
    const preparation = resolveCliVoicePromptStackBlocks({ credentials, serverId, sessionId: 'ordinary-target', profileId: 'voice-profile',
      readArtifactHeader: async () => ({ header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' } }),
      readArtifact: async ref => doc(ref.artifactId, ref.artifactId) });
    if (association === 'unavailable') {
      await expect(preparation).rejects.toMatchObject({ reason: 'unavailable' });
      return;
    }
    const blocks = await preparation;
    const layers = association === 'unregistered' ? ['account', 'target-profile', 'session'] : ['account', 'target-profile', 'project', 'session'];
    expect(blocks.slice(0, layers.length)).toEqual(layers);
    expect(blocks[layers.length]).toContain('ROLE_PERSONA');
    expect(blocks[layers.length]).toContain('ROLE_NOTES');
    expect(blocks.join('\n')).not.toContain('voice-profile');
    expect(blocks[layers.length]).not.toContain('lead_session_id');
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
      sessionId: 'notes-target', machineId: 'machine', accountEntries: [], profileEntries: [], readArtifact: async () => null });
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
      records: [{ revision: 2, record: { v: 1, id: 'work', enabled: true, secretBindings: {}, skillSeeds: [],
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
      if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(String(url), []) };
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
