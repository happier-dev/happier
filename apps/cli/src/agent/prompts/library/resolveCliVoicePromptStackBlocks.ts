import {
  resolveCliPromptStackSystemAppendBlocks,
  type CliPromptStackSystemAppendInput,
} from './resolveCliPromptStackSystemAppendBlocks';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { configuration } from '@/configuration';
import { resolveCliHomeTarget } from '@/server/homeTarget';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  readActiveAccountPromptStackSources } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { prepareActivePromptLibraryRecord } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { refreshActiveProfileCatalog } from '@/settings/profiles/hydrateProfileCatalog';
import { readAccountLaunchProfiles } from '@/settings/profiles/readProfilesFromAccountSettings';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { migrateRetainedSessionWorkContextV1, SessionPromptStackV1Schema,
  SessionDisabledInheritedEntryIdsV1Schema, readSessionMemoryEnabledV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { isActionEnabledWithSessionMemory } from '@happier-dev/protocol/actions/actionSurfaceAvailability';
import { MEMORY_WRITE_ACTION_IDS_V1 } from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import { renderSessionRoleBlockV1, type SessionRolePromptContextV1 } from '@happier-dev/protocol/prompts/roles/renderSessionRoleBlockV1';
import { resolveSessionProjectPromptStack } from '@/agent/prompting/coding/sessionProjectPromptStack';
import { resolveCliMemoryRecallGuidanceEnabled } from './resolveCliMemoryRecallGuidanceEnabled';
import type { VoicePromptPreparation } from '@/agent/voice/agent/voiceAgentTypes';
import { isVoiceConversationSystemSessionMetadata } from '@happier-dev/protocol/voice/sessionBinding';
import { SessionOwnerCompatibilityViewV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readStoredCredentialsForServerId } from '@/persistence';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createRoleSourceReader } from '@/session/roles/roleSources';
import { createSessionRoleContext } from '@/session/roles/sessionRoleContext';
import { readActiveAccountRoleOverrides } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { prepareActiveAccountRoleOverrides } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';

export type CliVoicePromptStackInput = Omit<CliPromptStackSystemAppendInput, 'surface'> & Readonly<{
  sessionMetadata?: unknown;
  machineId?: string;
  directory?: string;
  roleContext?: SessionRolePromptContextV1 | null;
  /** Host-owned control or ordinary attached Session, never an authored prompt override. */
  sessionId?: string | null;
  serverUrl?: string;
}>;

async function prepareTarget(input?: CliVoicePromptStackInput) {
  if (!input?.sessionId || input.sessionMetadata !== undefined) return { input, assertCurrent: async () => {} };
  const credentials = input.credentials;
  if (!credentials) throw new PromptStackPreparationError('unavailable');
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const capturedAccount = getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey;
  const assertAccountCurrent = () => {
    input.signal?.throwIfAborted();
    if (capturedAccount && (getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey
      || getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken)) throw new PromptStackPreparationError('unavailable');
  };
  const read = async (sessionId: string, args: CliVoicePromptStackInput) => {
    if (!args.credentials) throw new PromptStackPreparationError('unavailable');
    assertAccountCurrent();
    try {
      const currentness = await fetchAccountEncryptionCurrentness({ token: args.credentials.token,
        serverBaseUrl: args.serverUrl, signal: args.signal });
      const rawSession = await fetchSessionById({ token: args.credentials.token, sessionId,
        serverUrl: args.serverUrl, signal: args.signal });
      if (!rawSession || rawSession.id !== sessionId) throw new PromptStackPreparationError('unavailable');
      const metadata = tryDecryptSessionOwnerMetadataView({ credentials: args.credentials,
        accountEncryptionMode: currentness.mode, rawSession });
      if (!metadata) throw new PromptStackPreparationError('unavailable');
      args.signal?.throwIfAborted();
      assertAccountCurrent();
      return { metadata, rawSession };
    } catch (error) {
      assertAccountCurrent();
      if (error instanceof PromptStackPreparationError) throw error;
      throw new PromptStackPreparationError('unavailable');
    }
  };
  const control = await read(input.sessionId, input);
  let target = control;
  let args = input;
  let targetId = input.sessionId;
  let bindingIdentity: string | null = null;
  if (isVoiceConversationSystemSessionMetadata(control.metadata)) {
    const binding = createStoredReadSchema(SessionOwnerCompatibilityViewV1Schema.shape.voiceConversationBindingV1)
      .safeParse(control.metadata.voiceConversationBindingV1);
    if (!binding.success || !binding.data) throw new PromptStackPreparationError('unavailable');
    bindingIdentity = JSON.stringify(binding.data);
    if (binding.data.targetSessionId === null) {
      args = { ...input, sessionId: null, profileId: null, profileEntries: input.profileEntries === undefined ? undefined : [],
        sessionEntries: undefined, projectEntries: undefined, memoryEnabled: true,
        disabledInheritedEntryIds: undefined, roleContext: null,
        scope: input.scope ? { serverId: input.scope.serverId, accountId: input.scope.accountId } : null };
    } else {
      targetId = binding.data.targetSessionId;
      if (binding.data.targetServerId && binding.data.targetServerId !== input.serverId) {
        const home = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: binding.data.targetServerId });
        const targetCredentials = home.profileId ? await readStoredCredentialsForServerId(home.profileId) : null;
        if (!targetCredentials) throw new PromptStackPreparationError('unavailable');
        args = { ...input, credentials: targetCredentials, serverId: binding.data.targetServerId, serverUrl: home.serverUrl };
      }
      target = await read(targetId, args);
      if (isVoiceConversationSystemSessionMetadata(target.metadata)) throw new PromptStackPreparationError('unavailable');
    }
  }
  if (args.sessionId !== null) {
    const metadata = target.metadata;
    let roleContext = args.roleContext;
    if (roleContext === undefined && (readSessionRolesV1(metadata) || target.rawSession.reportsTo)) {
      const scopeKey = resolveAccountSettingsScopeKey(args.credentials!);
      const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
      const roleOwner = createSessionRoleContext({ readMetadata: () => metadata,
        readOrganization: async () => target.rawSession,
        readRoleSources: createRoleSourceReader({ artifactStore: createCredentialedAccountArtifactStore(args.credentials!),
          accountId: readAccountIdFromToken(args.credentials!.token) ?? undefined,
          readRawAccountSettings: async () => {
            const current = getActiveAccountSettingsSnapshot();
            if (!current || current.scopeKey !== scopeKey || getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken
              || current.source === 'none' || !current.rawSettings) throw new PromptStackPreparationError('unavailable');
            return current.rawSettings;
          } }),
        readAccountRoleOverrides: () => readActiveAccountRoleOverrides({ scopeKey, lifetimeToken }),
        prepareAccountRoleOverrides: async signal => { await prepareActiveAccountRoleOverrides({ credentials: args.credentials!, scopeKey, lifetimeToken, signal }); },
      });
      roleContext = await roleOwner.resolvePromptContext(args.signal, { modality: 'voice' });
    }
    const accountId = readAccountIdFromToken(args.credentials!.token) ?? args.scope?.accountId;
    args = { ...args, sessionId: targetId, sessionMetadata: metadata, roleContext,
      machineId: typeof metadata.machineId === 'string' ? metadata.machineId : args.machineId,
      directory: typeof metadata.path === 'string' ? metadata.path : args.directory,
      scope: accountId ? { ...args.scope, serverId: args.serverId ?? configuration.activeServerId,
        accountId, sessionId: targetId, profileId: typeof metadata.profileId === 'string' ? metadata.profileId : undefined } : null };
  }
  return { input: args, assertCurrent: async () => {
    assertAccountCurrent();
    if (bindingIdentity !== null) {
      const latest = await read(input.sessionId!, input);
      const binding = createStoredReadSchema(SessionOwnerCompatibilityViewV1Schema.shape.voiceConversationBindingV1)
        .safeParse(latest.metadata.voiceConversationBindingV1);
      if (!isVoiceConversationSystemSessionMetadata(latest.metadata) || !binding.success
        || JSON.stringify(binding.data) !== bindingIdentity) throw new PromptStackPreparationError('unavailable');
    }
  } };
}

async function resolveBlocks(input?: CliVoicePromptStackInput): Promise<string[]> {
  let preparedInput = input;
  if (input?.sessionMetadata && isVoiceConversationSystemSessionMetadata(input.sessionMetadata)) {
    const binding = createStoredReadSchema(SessionOwnerCompatibilityViewV1Schema.shape.voiceConversationBindingV1)
      .safeParse(Reflect.get(input.sessionMetadata, 'voiceConversationBindingV1'));
    if (!binding.success || !binding.data) throw new PromptStackPreparationError('unavailable');
    // A hidden Session is a control carrier, never an ordinary target.
    if (binding.data.targetSessionId !== null) throw new PromptStackPreparationError('unavailable');
    preparedInput = { ...input, sessionMetadata: undefined, profileEntries: input.profileEntries === undefined ? undefined : [],
      sessionEntries: undefined, projectEntries: undefined, disabledInheritedEntryIds: undefined, memoryEnabled: true,
      roleContext: null, profileId: null,
      scope: input.scope ? { serverId: input.scope.serverId, accountId: input.scope.accountId } : null };
  }
  if (preparedInput?.sessionMetadata !== undefined) {
    const input = preparedInput;
    const metadata = input.sessionMetadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new PromptStackPreparationError('unavailable');
    const work = migrateRetainedSessionWorkContextV1(Reflect.get(metadata, 'work'));
    const projectEntries = input.projectEntries ?? (Reflect.get(metadata, 'workspaceId') === undefined
      && Reflect.get(metadata, 'projectId') === undefined ? [] : input.credentials && input.machineId
        ? await resolveSessionProjectPromptStack({ credentials: input.credentials, metadata,
            signal: input.signal, machineId: input.machineId, directory: input.directory,
            serverId: input.serverId ?? undefined })
        : (() => { throw new PromptStackPreparationError('unavailable'); })());
    const profileId: unknown = Reflect.get(metadata, 'profileId');
    const projectKey: unknown = Reflect.get(metadata, 'projectId');
    preparedInput = { ...input, profileId: typeof profileId === 'string' ? profileId : null, projectEntries,
      scope: input.scope && input.projectEntries === undefined && typeof projectKey === 'string'
        ? { ...input.scope, projectKey } : input.scope,
      sessionEntries: createStoredReadSchema(SessionPromptStackV1Schema).parse(work.promptStack ?? []),
      disabledInheritedEntryIds: createStoredReadSchema(SessionDisabledInheritedEntryIdsV1Schema).parse(work.disabledInheritedEntryIds ?? []),
      memoryEnabled: readSessionMemoryEnabledV1(metadata) };
  }
  const args = preparedInput;
  const withRole = (blocks: string[]) => {
    const role = args?.roleContext ? renderSessionRoleBlockV1({ ...args.roleContext, modality: 'voice' }) : '';
    return role ? [...blocks, role] : blocks;
  };
  const explicitSources = args?.accountEntries !== undefined || args?.profileEntries !== undefined
    || args?.promptStacksV1 !== undefined;
  // An unbound global Voice call has no Account authority to demand.
  if (explicitSources || !args?.credentials) return withRole((await resolveCliPromptStackSystemAppendBlocks({
    ...args, settings: undefined, surface: 'voice', profileId: args?.profileId ?? null,
  })).blocks);
  const credentials = args.credentials;
  const activeServerId = configuration.activeServerId;
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const assertCurrent = () => {
    args.signal?.throwIfAborted();
    if (getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey
      || getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken)
      throw new PromptStackPreparationError('unavailable');
  };
  try {
    assertCurrent();
    if (args.serverId && args.serverId !== activeServerId) {
      const target = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: args.serverId });
      if (target.profileId !== activeServerId) throw new PromptStackPreparationError('unavailable');
    }
    assertCurrent();
    const snapshot = getActiveAccountSettingsSnapshot();
    const [voice] = await Promise.all([
      prepareActivePromptLibraryRecord({ credentials, scopeKey, lifetimeToken, key: 'voice', signal: args.signal }),
      args.profileId && (!snapshot?.profileCatalog || snapshot.profileCatalog.status === 'loading')
        ? refreshActiveProfileCatalog({ credentials, signal: args.signal }) : undefined,
    ]);
    assertCurrent();
    if (voice.status !== 'ready') throw new PromptStackPreparationError('unavailable');
    const current = getActiveAccountSettingsSnapshot();
    const catalog = current?.profileCatalog;
    // A ready private catalog can legitimately omit a selected builtin or
    // granted Profile. Open that selection through the existing Profile owner;
    // absence itself and retained Settings attachments confer no authority.
    const profilesSnapshot = args.profileId && current && catalog?.status === 'ready'
      && (catalog.authority === 'active' || catalog.source === 'destination')
      && !catalog.records.some(({ record }) => record.id === args.profileId)
      ? await readAccountLaunchProfiles(current.settings, credentials, args.signal, catalog) : undefined;
    assertCurrent();
    if (profilesSnapshot && (getActiveAccountSettingsSnapshot()?.settingsVersion !== current?.settingsVersion
      || getActiveAccountSettingsSnapshot()?.profileCatalog !== catalog)) {
      throw new PromptStackPreparationError('unavailable');
    }
    const source = readActiveAccountPromptStackSources({ scopeKey, lifetimeToken, surface: 'voice', profileId: args.profileId,
      ...(profilesSnapshot ? { profilesSnapshot } : {}) });
    if (source.status !== 'ready') throw new PromptStackPreparationError('unavailable');
    const result = await resolveCliPromptStackSystemAppendBlocks({ ...args, settings: undefined,
      surface: 'voice', accountEntries: source.accountEntries, profileEntries: source.profileEntries });
    assertCurrent();
    return withRole(result.blocks);
  } catch (error) {
    assertCurrent();
    if (error instanceof PromptStackPreparationError) throw error;
    throw new PromptStackPreparationError('unavailable');
  }
}

export async function resolveCliVoicePromptStackBlocks(input?: CliVoicePromptStackInput): Promise<string[]> {
  const target = await prepareTarget(input);
  const run = async () => {
    const blocks = await resolveBlocks(target.input);
    await target.assertCurrent();
    return blocks;
  };
  return target.input?.serverUrl ? await runWithServerHttpBaseUrl(target.input.serverUrl, run) : await run();
}

/** Stack and tool policy are admitted from the same exact target preparation. */
export async function resolveCliVoicePromptPreparation(args?: CliVoicePromptStackInput): Promise<VoicePromptPreparation> {
  const target = await prepareTarget(args);
  const input = target.input;
  const run = async () => {
    const systemAppendBlocks = await resolveBlocks(input);
    const hasSession = input?.sessionMetadata !== undefined && !isVoiceConversationSystemSessionMetadata(input.sessionMetadata);
    const memoryEnabled = !hasSession || readSessionMemoryEnabledV1(input?.sessionMetadata);
    const memoryRecallGuidanceEnabled = memoryEnabled && await resolveCliMemoryRecallGuidanceEnabled({ surfaces: ['voice'] });
    await target.assertCurrent();
    return { systemAppendBlocks, memoryRecallGuidanceEnabled,
      disabledActionIds: hasSession ? MEMORY_WRITE_ACTION_IDS_V1.filter(id => !isActionEnabledWithSessionMemory(id, memoryEnabled)) : [] };
  };
  return input?.serverUrl ? await runWithServerHttpBaseUrl(input.serverUrl, run) : await run();
}
