import { accountSettingsParse, type AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import { BUILT_IN_SETTINGS_DECLARATIONS_V1, readBuiltInSettingDeclarationV1, readPortableDomainSettingBindingV1,
  parseBuiltInAccountSettingValueV1, readBuiltInAccountSettingValueV1, buildBuiltInAccountSettingMutationV1,
  hasBuiltInAccountSettingBindingV1,
} from '@happier-dev/protocol/actions/settings/settingsDeclarations';
import { AccountSettingMutationV1Schema } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import { SettingsDeclarationActionInputSchemasV1, SettingsDeclarationValueV1Schema,
  type SettingsDeclarationDescriptorV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { executeHomeSettingDeclaration, readHomeSettingsDeclarationOwner, executeTeamSettingDeclaration,
  executeSessionAutoFollowSetting } from '@happier-dev/protocol/actions';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { clientActionUnavailable } from '@happier-dev/protocol/actions/clientDispatchV1';
import { readPortableCatalogAccountSettingBindingV1, PORTABLE_SETTING_VALUE_UNAVAILABLE,
  type PortableVoiceSettingsBindingContextV1 } from '@happier-dev/protocol/actions/settings/catalogAccountSettingBindings';

import type { StoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { readAccountSettingsV2Raw, updateAccountSettingsV2Once, updateAccountSettingsV2WithRetry } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { executeCliScalarSettingReversal } from './scalarSettingReversal';
import { createCliSettingsCatalogServices, createCliVoiceSettingsBindingContext } from './settingsCatalogServices';
import { createVoiceSettingsPersistenceOwner } from '@happier-dev/protocol/voice/settings/voiceSettingsPersistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { createCliAutomationSettingsDeclarationAction } from './automationSettingsAction';
import { readPortableAccountSettingBindingV1 } from '@happier-dev/protocol/actions/settings/accountSettingBindings';

const refuse = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
class RejectedSettingMutation extends Error {
  constructor(readonly errorCode: 'invalid_setting_value' | 'credential_scope_retired' | 'setting_value_unavailable' = 'invalid_setting_value') {
    super(errorCode);
  }
}

/** Shared declarations; Account CAS and nested domain Actions retain mutation ownership. */
export function createCliSettingsDeclarationAction(params: Readonly<{
  credentials?: StoredCredentials;
  serverId?: string;
  serverHttpBaseUrl?: string;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  voiceBindingContext?: PortableVoiceSettingsBindingContextV1;
  readMachineAgentProjection?: (machineId: string, context: ActionExecutorContext) => Promise<PluginProjectionV2 | null>;
}>): NonNullable<ActionExecutorDeps['settingsDeclarationAction']> {
  const readMachineAgentProjection = params.readMachineAgentProjection;
  const execute: NonNullable<ActionExecutorDeps['settingsDeclarationAction']> = async ({ actionId, input, context, executeOwnerAction }) => {
    context.signal?.throwIfAborted();
    if (actionId === 'settings.list') {
      const requested = SettingsDeclarationActionInputSchemasV1[actionId].parse(input);
      const items: SettingsDeclarationDescriptorV1[] = BUILT_IN_SETTINGS_DECLARATIONS_V1
        .filter(item => !requested.pageId || item.pageId === requested.pageId).map(item => {
          const sensitive = item.sensitive || item.storage?.access === 'sensitive';
          const readable = Boolean(item.storage) && !sensitive;
          return { anchor: item.anchor, pageId: item.pageId, title: item.title,
            ...(item.description ? { description: item.description } : {}), sensitive, readable,
            writable: readable && item.storage?.access === 'read_write'
              && !(context.surface === 'agent' && item.surfaces?.agent === false || context.surface === 'mcp' && item.surfaces?.mcp === false),
            ...(item.storage?.scope === 'account' || item.storage?.scope === 'local' ? { storageScope: item.storage.scope } : {}),
            ...(item.targetKinds.length ? { targetKinds: [...item.targetKinds], targetRequired: item.storage?.scope === 'team' } : {}),
            ...(item.storage?.allowedValues ? { allowedValues: [...item.storage.allowedValues] } : {}),
            ...(sensitive ? { unavailableReason: 'sensitive' as const } : !item.storage ? { unavailableReason: 'not_bound' as const }
              : item.storage.access === 'read_only' ? { unavailableReason: 'read_only' as const } : {}),
            ...(item.operation ? { operation: { actionId: 'settings.invoke' as const,
              requiresHumanInteraction: item.operation.requiresHumanInteraction,
              ...(item.operation.kind === 'invoke' ? { requiresApproval: item.operation.requiresApproval !== false } : {}) } } : {}),
          };
        });
      return { items };
    }
    const parsed = SettingsDeclarationActionInputSchemasV1[actionId].parse(input);
    const declaration = readBuiltInSettingDeclarationV1(parsed.anchor);
    if (!declaration) return refuse('setting_not_found');
    if (actionId === 'settings.invoke' || declaration.storage?.scope === 'local') return clientActionUnavailable(actionId);
    const storage = declaration.storage;
    if (!storage) return refuse('setting_not_bound');
    const target = 'target' in parsed ? parsed.target : undefined;
    if (target && (!declaration.targetKinds.includes(target.kind) || target.serverId !== (params.serverId ?? context.serverId))) {
      return { ...refuse('setting_target_mismatch'), details: { targetKinds: [...declaration.targetKinds] } };
    }
    if (storage.scope === 'team' && !target) return { ...refuse('setting_target_required'), details: { targetKinds: [...declaration.targetKinds] } };
    if (declaration.sensitive || storage.access === 'sensitive') return refuse('setting_sensitive');
    if (actionId === 'settings.set' && storage.access === 'read_only') return refuse('setting_read_only');
    if (storage.prerequisite === 'ui_platform') return { ...refuse('setting_value_unavailable'), details: { prerequisite: storage.prerequisite } };
    const resetValue = actionId === 'settings.reset'
      ? readBuiltInAccountSettingValueV1(declaration, accountSettingsParse({}))
      : undefined;
    if (actionId === 'settings.reset' && resetValue === undefined) return refuse('setting_reset_unsupported');
    const requested = actionId === 'settings.set' ? SettingsDeclarationActionInputSchemasV1[actionId].parse(input)
      : actionId === 'settings.reset' ? { ...SettingsDeclarationActionInputSchemasV1[actionId].parse(input), value: resetValue! }
      : undefined;
    if (storage.scope === 'home' || storage.scope === 'team') {
      if (requested?.expectedSettingsVersion !== undefined || requested?.reversal || 'includeVersion' in parsed && parsed.includeVersion) return refuse('setting_conditional_mutation_unsupported');
      const binding = readPortableDomainSettingBindingV1(declaration);
      if (!binding) return refuse('setting_not_bound');
      const isCurrent = () => !context.signal?.aborted;
      const executeScopedOwner: typeof executeOwnerAction = async request => {
        context.signal?.throwIfAborted();
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) return refuse('credential_scope_retired');
        return executeOwnerAction(request);
      };
      const request = { actionId, anchor: declaration.anchor, value: requested?.value, execute: executeScopedOwner, context, isCurrent };
      if (binding.scope === 'team') {
        if (!target || target.kind === 'home') return refuse('setting_target_mismatch');
        return await executeTeamSettingDeclaration({ ...request, binding, target });
      }
      if (binding.kind === 'sessionAutoFollowPreferences') return await executeSessionAutoFollowSetting({ ...request, field: binding.field });
      const read = await readHomeSettingsDeclarationOwner(executeScopedOwner, context, isCurrent);
      return await executeHomeSettingDeclaration({ ...request, key: binding.key, read });
    }
    // Remote admission is not permission to borrow this host's Account bearer.
    if (context.externalActionCredential || context.externalActionExecutionAuthorization) return refuse('requester_account_material_unavailable');
    if (!params.credentials) return refuse('not_authenticated');
    const credentials = params.credentials;
    if (params.isCredentialCurrent && !await params.isCredentialCurrent()) return refuse('credential_scope_retired');
    if (storage.kind === 'automationSettings') {
      if (requested?.expectedSettingsVersion !== undefined || requested?.reversal || 'includeVersion' in parsed && parsed.includeVersion) return refuse('setting_conditional_mutation_unsupported');
      if (storage.field !== 'maxActiveRunsPerMachine' && storage.field !== 'runRetention') return refuse('setting_not_bound');
      return await createCliAutomationSettingsDeclarationAction({ credentials, serverId: params.serverId,
        serverHttpBaseUrl: params.serverHttpBaseUrl, isCredentialCurrent: params.isCredentialCurrent })({
        actionId, anchor: declaration.anchor, field: storage.field, value: requested?.value, signal: context.signal,
      });
    }
    const ordinaryBinding = hasBuiltInAccountSettingBindingV1(declaration);
    const portableBinding = readPortableAccountSettingBindingV1(declaration);
    const preparedBinding = portableBinding && 'prepare' in portableBinding ? portableBinding : undefined;
    const scalarCatalogBinding = readPortableCatalogAccountSettingBindingV1<AccountSettings>(declaration);
    const voiceContext = !ordinaryBinding && !scalarCatalogBinding
      ? params.voiceBindingContext ?? createCliVoiceSettingsBindingContext() : undefined;
    const voicePersistence = voiceContext ? createVoiceSettingsPersistenceOwner({ voiceOwner: voiceContext.owner }) : undefined;
    const catalogBinding = scalarCatalogBinding ?? (voiceContext
      ? readPortableCatalogAccountSettingBindingV1<AccountSettings>(declaration, voiceContext) : null);
    if (!catalogBinding && !ordinaryBinding) return refuse('setting_not_bound');
    const isCatalogCurrent = () => !context.signal?.aborted && voiceContext?.isCurrent?.() !== false;
    const projectAccount = (raw: Readonly<Record<string, unknown>>): AccountSettings => {
      const parsed = accountSettingsParse(raw);
      return voicePersistence ? { ...parsed, ...voicePersistence.projectVoiceSettingsIntoRuntimeSettings({ parsed, raw }) } : parsed;
    };
    const readValue = (raw: Readonly<Record<string, unknown>>) => {
      const settings = projectAccount(raw);
      return catalogBinding ? catalogBinding.read(settings) : readBuiltInAccountSettingValueV1(declaration, settings);
    };
    if (requested) {
      if (requested.reversal) return await executeCliScalarSettingReversal({ declaration, requested,
        credentials, serverId: params.serverId, signal: context.signal, isCredentialCurrent: params.isCredentialCurrent });
      const value = catalogBinding ? catalogBinding.parse(requested.value) : parseBuiltInAccountSettingValueV1(declaration, requested.value);
      if (!value.success) return refuse('invalid_setting_value');
      const initial = catalogBinding?.prepare || preparedBinding ? await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' }) : undefined;
      if (initial && !initial.rawSettings) return refuse('account_settings_content_unavailable');
      const catalogServices = createCliSettingsCatalogServices({ credentials, signal: context.signal, serverId: params.serverId,
        expectedAccountId: readAccountIdFromToken(credentials.token) ?? undefined, voiceOwner: voiceContext?.owner,
        ...(readMachineAgentProjection ? { readMachineAgentProjection: (machineId, signal) =>
          readMachineAgentProjection(machineId, { ...context, ...(signal ? { signal } : {}) }) } : {}),
      });
      const preparedCatalogMutation = catalogBinding?.prepare && initial?.rawSettings
        ? await catalogBinding.prepare(projectAccount(initial.rawSettings), value.value,
          catalogServices,
          { signal: context.signal, isCurrent: isCatalogCurrent }) : undefined;
      if (catalogBinding?.prepare && !preparedCatalogMutation) return refuse('setting_value_unavailable');
      const preparedAccount = preparedBinding && initial?.rawSettings
        ? await preparedBinding.prepare(projectAccount(initial.rawSettings), value.value, catalogServices,
          { signal: context.signal, isCurrent: isCatalogCurrent }) : undefined;
      if (preparedAccount && preparedAccount.status !== 'prepared') {
        if (preparedAccount.status === 'confirmation_required') return { ...refuse('provider_state_sharing_confirmation_required'),
          details: { agentIds: [...preparedAccount.agentIds] } };
        return refuse(preparedAccount.status === 'invalid_value' ? 'invalid_setting_value'
          : preparedAccount.status === 'cancelled' ? 'cancelled' : 'setting_value_unavailable');
      }
      const prepareMutation = async (raw: Readonly<Record<string, unknown>>) => {
        context.signal?.throwIfAborted();
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw new RejectedSettingMutation('credential_scope_retired');
        if (!isCatalogCurrent() || !await catalogServices.isCurrent()) throw new RejectedSettingMutation('setting_value_unavailable');
        context.signal?.throwIfAborted();
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw new RejectedSettingMutation('credential_scope_retired');
        const settings = projectAccount(raw);
        const delta = preparedAccount?.status === 'prepared' ? preparedAccount.mutate(settings)
          : catalogBinding ? preparedCatalogMutation ? preparedCatalogMutation(settings)
          : catalogBinding.mutate(settings, value.value) : buildBuiltInAccountSettingMutationV1(declaration, settings, value.value);
        if (!delta) throw new RejectedSettingMutation('setting_value_unavailable');
        const snapshot = getActiveAccountSettingsSnapshot();
        const providerSettings = voicePersistence && snapshot?.scopeKey === resolveAccountSettingsScopeKey(credentials)
          && snapshot.providerConnectionsCatalog?.status === 'ready' ? readProviderSettingsForCli(snapshot).settings : null;
        const persisted = voicePersistence && Object.hasOwn(delta, 'voice')
          ? voicePersistence.normalizeVoiceSettingsServerDelta(voicePersistence.normalizeVoiceSettingsLocalDelta(delta, settings), raw, providerSettings) : delta;
        return AccountSettingMutationV1Schema.parse({ operations: Object.entries(persisted).map(([key, value]) => ({ op: 'set', key, value })) });
      };
      try {
        const result = requested.expectedSettingsVersion === undefined
          ? await updateAccountSettingsV2WithRetry({ credentials, prepareMutation, signal: context.signal })
          : await updateAccountSettingsV2Once({ credentials, expectedVersion: requested.expectedSettingsVersion,
            prepareMutation, signal: context.signal });
        if (result.status !== 'applied' && result.status !== 'unchanged' && result.status !== 'satisfied') return { ...refuse(`account_settings_${result.status}`), details: result };
        return { anchor: declaration.anchor, value: value.value,
          ...(requested.expectedSettingsVersion === undefined ? {} : { settingsVersion: result.version }) };
      } catch (error) {
        if (error instanceof RejectedSettingMutation) return refuse(error.errorCode);
        if (error instanceof Error && 'code' in error && error.code === 'voice_provider_catalog_unavailable') return refuse('voice_provider_catalog_unavailable');
        throw error;
      }
    }
    const versioned = 'includeVersion' in parsed && parsed.includeVersion;
    const current = versioned ? await readAccountSettingsV2Raw({ credentials, signal: context.signal })
      : await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
    context.signal?.throwIfAborted();
    if (params.isCredentialCurrent && !await params.isCredentialCurrent()) return refuse('credential_scope_retired');
    if (!isCatalogCurrent()) return refuse('setting_value_unavailable');
    const raw = 'raw' in current ? current.raw : current.rawSettings;
    if (!raw) return refuse('account_settings_content_unavailable');
    const value = readValue(raw);
    if (value === PORTABLE_SETTING_VALUE_UNAVAILABLE) return refuse('setting_value_unavailable');
    return { anchor: declaration.anchor, ...(value === undefined ? { unset: true as const } : { value: SettingsDeclarationValueV1Schema.parse(value) }),
      ...('version' in current ? { settingsVersion: current.version } : {}) };
  };
  return args => params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => execute(args)) : execute(args);
}
