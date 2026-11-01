import { accountSettingsParse, type AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import { ActionPolicyInputSchemas, isActionPolicyActionId, type ActionPolicySetResult } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { readActionAudiencePolicy, applyActionPolicyMutation } from '@happier-dev/protocol/actions/actionAudiencePolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { BUILT_IN_SETTINGS_DECLARATIONS_V1, readBuiltInSettingDeclarationV1, readPortableDomainSettingBindingV1,
  parseBuiltInAccountSettingValueV1, readBuiltInAccountSettingValueV1, buildBuiltInAccountSettingMutationV1,
  hasBuiltInAccountSettingBindingV1, resolveBuiltInAccountSettingResetValueV1,
} from '@happier-dev/protocol/actions/settings/settingsDeclarations';
import { AccountSettingMutationV1Schema } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import { SettingsDeclarationActionInputSchemasV1, SettingsDeclarationValueV1Schema,
  type SettingsDeclarationDescriptorV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { executeHomeSettingDeclaration, readHomeSettingsDeclarationOwner } from '@happier-dev/protocol/actions/settings/homeSettingsDeclarationAction';
import { executeTeamSettingDeclaration } from '@happier-dev/protocol/actions/settings/teamSettingsDeclarationAction';
import { executeSessionAutoFollowSetting } from '@happier-dev/protocol/actions/settings/sessionAutoFollowSettingsAction';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { clientActionUnavailable } from '@happier-dev/protocol/actions/clientDispatchV1';
import { readPortableCatalogAccountSettingBindingV1, PORTABLE_SETTING_VALUE_UNAVAILABLE,
  type PortableVoiceSettingsBindingContextV1 } from '@happier-dev/protocol/actions/settings/catalogAccountSettingBindings';

import type { StoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { readAccountSettingsV2Raw, updateAccountSettingsV2Once, updateAccountSettingsV2WithRetry } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import type { executeCliSettingMutationReversal } from './settingMutationReversal';
import type { createCliSettingsCatalogServices, createCliVoiceSettingsBindingContext } from './settingsCatalogServices';
import { createVoiceSettingsPersistenceOwner } from '@happier-dev/protocol/voice/settings/voiceSettingsPersistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { readProviderSettingsForCli } from '@/providers/settings/read';
import type { createCliAutomationSettingsDeclarationAction } from './automationSettingsAction';
import { readPortableAccountSettingBindingV1, machineDirectConnectionStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';
import { MachineTerminalHostSettingKeySchema, MachineTerminalHostSettingChangeSchema,
  readMachineTerminalHostSetting, buildMachineTerminalHostSettingMutation } from '@happier-dev/protocol/actions/settings/machineTerminalHostSetting';
import { MachineOfflineAlertSettingKeySchema, MachineOfflineAlertSettingChangeSchema,
  readMachineOfflineAlertSetting, buildMachineOfflineAlertSettingMutation } from '@happier-dev/protocol/actions/settings/machineOfflineAlertSetting';

const refuse = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
class RejectedSettingMutation extends Error {
  constructor(readonly errorCode: 'invalid_setting_value' | 'credential_scope_retired' | 'setting_value_unavailable' = 'invalid_setting_value') {
    super(errorCode);
  }
}

function lacksCurrentAccountMaterial(
  context: ActionExecutorContext,
  credentials: StoredCredentials | undefined,
): boolean {
  if (context.externalActionCredential) return true;
  const authorization = context.externalActionExecutionAuthorization;
  if (!authorization) return false;
  const currentAccountId = credentials ? readAccountIdFromToken(credentials.token) : null;
  return !currentAccountId || authorization.binding.accountId !== currentAccountId;
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
    if (isActionPolicyActionId(actionId)) {
      if (lacksCurrentAccountMaterial(context, params.credentials)) return refuse('requester_account_material_unavailable');
      if (!params.credentials) return refuse('not_authenticated');
      if (params.isCredentialCurrent && !await params.isCredentialCurrent()) return refuse('credential_scope_retired');
      if (actionId === 'actions.policy.get') {
        const requested = ActionPolicyInputSchemas[actionId].parse(input);
        const { bootstrapAccountSettingsContext } = await import("@/settings/accountSettings/bootstrapAccountSettingsContext");
        const current = await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking', refresh: 'force', signal: context.signal });
        if (current.source === 'none' || !current.rawSettings) return refuse('account_settings_content_unavailable');
        return readActionAudiencePolicy(accountSettingsParse(current.rawSettings).actionsSettingsV1, requested.actionId, requested.audience);
      }
      const requested = actionId === 'actions.policy.set' ? ActionPolicyInputSchemas[actionId].parse(input)
        : { ...ActionPolicyInputSchemas[actionId].parse(input), mode: 'default' as const };
      let applied: ActionPolicySetResult | undefined;
      try {
        const { updateAccountSettingsV2WithRetry } = await import("@/settings/accountSettings/updateAccountSettingsV2WithRetry");
        const result = await updateAccountSettingsV2WithRetry({ credentials: params.credentials, signal: context.signal,
          prepareMutation: async raw => {
            context.signal?.throwIfAborted();
            if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw new RejectedSettingMutation('credential_scope_retired');
            const mutation = applyActionPolicyMutation(normalizeActionsSettingsV1(raw.actionsSettingsV1), requested);
            applied = mutation.result;
            return AccountSettingMutationV1Schema.parse({ operations: [{ op: 'set', key: 'actionsSettingsV1', value: mutation.settings }] });
          },
        });
        if (result.status !== 'applied' && result.status !== 'unchanged' && result.status !== 'satisfied') return refuse(`account_settings_${result.status}`);
        return applied ?? refuse('account_settings_content_unavailable');
      } catch (error) {
        if (error instanceof RejectedSettingMutation) return refuse(error.errorCode);
        throw error;
      }
    }
    if (actionId === 'settings.list') {
      const requested = SettingsDeclarationActionInputSchemasV1[actionId].parse(input);
      const items: SettingsDeclarationDescriptorV1[] = BUILT_IN_SETTINGS_DECLARATIONS_V1
        .filter(item => !requested.pageId || item.pageId === requested.pageId).map(item => {
          const sensitive = item.sensitive || item.storage?.access === 'sensitive';
          const unsupportedHost = item.storage?.kind === 'atmospherePictureLibrary';
          const readable = Boolean(item.storage) && !sensitive && !unsupportedHost;
          return { anchor: item.anchor, pageId: item.pageId, title: item.title,
            ...(item.description ? { description: item.description } : {}), sensitive, readable,
            writable: readable && item.storage?.access === 'read_write',
            ...(item.storage?.scope === 'account' || item.storage?.scope === 'local' ? { storageScope: item.storage.scope } : {}),
            ...(item.targetKinds.length ? { targetKinds: [...item.targetKinds], targetRequired: item.storage?.scope === 'team' || item.storage?.scope === 'project' } : {}),
            ...(item.storage?.allowedValues ? { allowedValues: [...item.storage.allowedValues] } : {}),
            ...(unsupportedHost ? { unavailableReason: 'unsupported_host' as const } : sensitive ? { unavailableReason: 'sensitive' as const } : !item.storage ? { unavailableReason: 'not_bound' as const }
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
    // A UI draft is the answering client's captured controller, never an Account preference.
    if ('target' in parsed && parsed.target?.kind === 'public_profile_draft') {
      return declaration.targetKinds.includes('public_profile_draft') ? clientActionUnavailable(actionId) : refuse('setting_target_mismatch');
    }
    const keyedOwner = parsed.anchor === 'machines.terminal.host' ? {
      key: MachineTerminalHostSettingKeySchema, value: MachineTerminalHostSettingChangeSchema,
      read: readMachineTerminalHostSetting,
      mutate: (settings: AccountSettings, key: string, value: unknown) => buildMachineTerminalHostSettingMutation(
        settings, key, MachineTerminalHostSettingChangeSchema.parse(value)),
    } : parsed.anchor === 'machines.connection.direct' ? machineDirectConnectionStorage : parsed.anchor === 'notifications.machineOffline' ? {
      key: MachineOfflineAlertSettingKeySchema, value: MachineOfflineAlertSettingChangeSchema,
      read: readMachineOfflineAlertSetting, mutate: buildMachineOfflineAlertSettingMutation,
    } : null;
    if (keyedOwner) {
      if (actionId !== 'settings.get' && actionId !== 'settings.set') return refuse('setting_reset_unsupported');
      if ((parsed.anchor === 'notifications.machineOffline' || parsed.anchor === 'machines.connection.direct') && 'target' in parsed && parsed.target) return refuse('setting_target_mismatch');
      const key = keyedOwner.key.safeParse('key' in parsed ? parsed.key : undefined);
      if (!key.success) return refuse('setting_key_required');
      if (lacksCurrentAccountMaterial(context, params.credentials)) return refuse('requester_account_material_unavailable');
      if (!params.credentials) return refuse('not_authenticated');
      if (params.isCredentialCurrent && !await params.isCredentialCurrent()) return refuse('credential_scope_retired');
      if (actionId === 'settings.get') {
        const { bootstrapAccountSettingsContext } = await import("@/settings/accountSettings/bootstrapAccountSettingsContext");
        const current = await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking', refresh: 'force', signal: context.signal });
        if (current.source === 'none' || !current.rawSettings) return refuse('account_settings_content_unavailable');
        return { anchor: parsed.anchor, value: keyedOwner.read(accountSettingsParse(current.rawSettings), key.data) };
      }
      const requested = SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input);
      if (requested.reversal || requested.expectedSettingsVersion !== undefined) return refuse('setting_conditional_mutation_unsupported');
      const change = keyedOwner.value.safeParse(requested.value);
      if (!change.success) return refuse('invalid_setting_value');
      try {
        const { updateAccountSettingsV2WithRetry } = await import("@/settings/accountSettings/updateAccountSettingsV2WithRetry");
        const result = await updateAccountSettingsV2WithRetry({ credentials: params.credentials, signal: context.signal,
          prepareMutation: async raw => {
            context.signal?.throwIfAborted();
            if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw new RejectedSettingMutation('credential_scope_retired');
            const patch = keyedOwner.mutate(accountSettingsParse(raw), key.data, change.data);
            if (!patch) throw new RejectedSettingMutation();
            return AccountSettingMutationV1Schema.parse({ operations: Object.entries(patch).map(([key, value]) => ({ op: 'set', key, value })) });
          },
        });
        if (result.status !== 'applied' && result.status !== 'unchanged' && result.status !== 'satisfied') return refuse(`account_settings_${result.status}`);
        return { anchor: parsed.anchor, value: change.data };
      } catch (error) {
        if (error instanceof RejectedSettingMutation) return refuse(error.errorCode);
        throw error;
      }
    }
    // Device preference keys belong to the answering App's declared owner, including on recovery.
    if (declaration.storage?.scope === 'local') return clientActionUnavailable(actionId);
    if ('key' in parsed && parsed.key !== undefined && !(actionId === 'settings.reset'
      && readPortableAccountSettingBindingV1(declaration)?.reset)) return refuse('setting_key_unsupported');
    if (actionId === 'settings.invoke'
      || declaration.storage?.scope === 'project' || declaration.storage?.prerequisite === 'ui_picture_catalog'
      || declaration.storage?.prerequisite === 'ui_account_encryption_requirement') return clientActionUnavailable(actionId);
    const storage = declaration.storage;
    if (!storage) return refuse('setting_not_bound');
    const target = 'target' in parsed ? parsed.target : undefined;
    if (target && (!declaration.targetKinds.includes(target.kind) || target.serverId !== (params.serverId ?? context.serverId))) {
      return { ...refuse('setting_target_mismatch'), details: { targetKinds: [...declaration.targetKinds] } };
    }
    if (storage.scope === 'team' && !target) return { ...refuse('setting_target_required'), details: { targetKinds: [...declaration.targetKinds] } };
    if (declaration.sensitive || storage.access === 'sensitive') return refuse('setting_sensitive');
    if ((actionId === 'settings.set' || actionId === 'settings.reset') && storage.access === 'read_only') return refuse('setting_read_only');
    if (storage.prerequisite === 'ui_platform') return { ...refuse('setting_value_unavailable'), details: { prerequisite: storage.prerequisite } };
    const resetValue = actionId === 'settings.reset'
      ? resolveBuiltInAccountSettingResetValueV1(declaration, 'key' in parsed ? parsed.key : undefined)
      : undefined;
    if (resetValue && !resetValue.success) return refuse('setting_reset_unsupported');
    const resetRequest = actionId === 'settings.reset' ? SettingsDeclarationActionInputSchemasV1[actionId].parse(input) : undefined;
    const { expected: resetExpected, key: _resetKey, ...resetInput } = resetRequest ?? {};
    const requested = actionId === 'settings.set' ? SettingsDeclarationActionInputSchemasV1[actionId].parse(input)
      : actionId === 'settings.reset' && resetValue?.success ? SettingsDeclarationActionInputSchemasV1['settings.set'].parse({
        ...resetInput, value: resetValue.value,
      })
      : undefined;
    const ownerActionId = actionId === 'settings.reset' ? 'settings.set' : actionId;
    if (resetExpected !== undefined && storage.scope !== 'account') return refuse('setting_conditional_mutation_unsupported');
    if (storage.scope === 'home' || storage.scope === 'team') {
      if (resetExpected !== undefined || requested?.expectedSettingsVersion !== undefined || requested?.reversal || 'includeVersion' in parsed && parsed.includeVersion) return refuse('setting_conditional_mutation_unsupported');
      const binding = readPortableDomainSettingBindingV1(declaration);
      if (!binding) return refuse('setting_not_bound');
      const isCurrent = () => !context.signal?.aborted;
      const executeScopedOwner: typeof executeOwnerAction = async request => {
        context.signal?.throwIfAborted();
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) return refuse('credential_scope_retired');
        return executeOwnerAction(request);
      };
      const request = { actionId: ownerActionId, anchor: declaration.anchor, value: requested?.value, execute: executeScopedOwner, context, isCurrent };
      if (binding.scope === 'team') {
        if (!target || target.kind === 'home' || target.kind === 'project') return refuse('setting_target_mismatch');
        return await executeTeamSettingDeclaration({ ...request, binding, target });
      }
      if (binding.kind === 'sessionAutoFollowPreferences') return await executeSessionAutoFollowSetting({ ...request, field: binding.field });
      const read = await readHomeSettingsDeclarationOwner(executeScopedOwner, context, isCurrent);
      return await executeHomeSettingDeclaration({ ...request, key: binding.key, read });
    }
    // Session admission may use only material already bound to this exact
    // Account; it never authorizes borrowing a custodian's bearer.
    if (lacksCurrentAccountMaterial(context, params.credentials)) return refuse('requester_account_material_unavailable');
    if (!params.credentials) return refuse('not_authenticated');
    const credentials = params.credentials;
    if (params.isCredentialCurrent && !await params.isCredentialCurrent()) return refuse('credential_scope_retired');
    if (storage.kind === 'automationSettings') {
      if (resetExpected !== undefined || requested?.expectedSettingsVersion !== undefined || requested?.reversal || 'includeVersion' in parsed && parsed.includeVersion) return refuse('setting_conditional_mutation_unsupported');
      if (storage.field !== 'maxActiveRunsPerMachine' && storage.field !== 'runRetention') return refuse('setting_not_bound');
      const { createCliAutomationSettingsDeclarationAction } = await import("./automationSettingsAction");
      return await createCliAutomationSettingsDeclarationAction({ credentials, serverId: params.serverId,
        serverHttpBaseUrl: params.serverHttpBaseUrl, isCredentialCurrent: params.isCredentialCurrent })({
        actionId: ownerActionId, anchor: declaration.anchor, field: storage.field, value: requested?.value, signal: context.signal,
      });
    }
    const ordinaryBinding = hasBuiltInAccountSettingBindingV1(declaration);
    const portableBinding = readPortableAccountSettingBindingV1(declaration);
    const preparedBinding = portableBinding && 'prepare' in portableBinding ? portableBinding : undefined;
    const scalarCatalogBinding = readPortableCatalogAccountSettingBindingV1<AccountSettings>(declaration);
    const [{ bootstrapAccountSettingsContext }, { readAccountSettingsV2Raw }, { createCliVoiceSettingsBindingContext }] = await Promise.all([import("@/settings/accountSettings/bootstrapAccountSettingsContext"), import("@/settings/accountSettings/updateAccountSettingsV2WithRetry"), import("./settingsCatalogServices")]);
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
      const value = catalogBinding ? catalogBinding.parse(requested.value) : parseBuiltInAccountSettingValueV1(declaration, requested.value);
      if (!value.success) return refuse('invalid_setting_value');
      const [{ bootstrapAccountSettingsContext }, { createCliSettingsCatalogServices }] = await Promise.all([import("@/settings/accountSettings/bootstrapAccountSettingsContext"), import("./settingsCatalogServices")]);
      const initial = catalogBinding?.prepare || preparedBinding ? await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force', signal: context.signal }) : undefined;
      if (initial && (initial.source === 'none' || !initial.rawSettings)) return refuse('account_settings_content_unavailable');
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
        ? await preparedBinding.prepare(projectAccount(initial.rawSettings), value.value, {
          ...catalogServices,
          // The executor admitted this Settings Action before dispatch, including
          // a waiver. Transport acknowledgements must not add another approval floor.
          confirmProviderStateSharingRiskAgents: async () => true,
        },
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
        const [{ getActiveAccountSettingsSnapshot }, { resolveAccountSettingsScopeKey }, { readProviderSettingsForCli }] = await Promise.all([import("@/settings/accountSettings/activeAccountSettingsSnapshot"), import("@/settings/accountSettings/accountSettingsScopeKey"), import("@/providers/settings/read")]);
        const snapshot = getActiveAccountSettingsSnapshot();
        const providerSettings = voicePersistence && snapshot?.scopeKey === resolveAccountSettingsScopeKey(credentials)
          && snapshot.providerConnectionsCatalog?.status === 'ready' ? readProviderSettingsForCli(snapshot).settings : null;
        const persisted = voicePersistence && Object.hasOwn(delta, 'voice')
          ? voicePersistence.normalizeVoiceSettingsServerDelta(voicePersistence.normalizeVoiceSettingsLocalDelta(delta, settings), raw, providerSettings) : delta;
        return AccountSettingMutationV1Schema.parse({ operations: Object.entries(persisted).map(([key, value]) =>
          resetExpected !== undefined && storage.key === key && !storage.path?.length
            ? { op: 'reset', key } : { op: 'set', key, value }) });
      };
      try {
        if (requested.reversal || resetExpected !== undefined) {
          const { executeCliSettingMutationReversal } = await import("./settingMutationReversal");
          const reversed = await executeCliSettingMutationReversal({ declaration, requested, resetExpected,
            credentials, serverId: params.serverId, signal: context.signal, isCredentialCurrent: params.isCredentialCurrent,
            prepareMutation, readValue });
          if (actionId !== 'settings.reset' || 'ok' in reversed) return reversed;
          const { settingsVersion: _settingsVersion, ...response } = reversed;
          return response;
        }
        const { updateAccountSettingsV2WithRetry, updateAccountSettingsV2Once } = await import("@/settings/accountSettings/updateAccountSettingsV2WithRetry");
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
      : await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force', signal: context.signal });
    context.signal?.throwIfAborted();
    if (params.isCredentialCurrent && !await params.isCredentialCurrent()) return refuse('credential_scope_retired');
    if (!isCatalogCurrent()) return refuse('setting_value_unavailable');
    const raw = 'raw' in current ? current.raw : current.rawSettings;
    if (('source' in current && current.source === 'none') || !raw) return refuse('account_settings_content_unavailable');
    const value = readValue(raw);
    if (value === PORTABLE_SETTING_VALUE_UNAVAILABLE) return refuse('setting_value_unavailable');
    return { anchor: declaration.anchor, ...(value === undefined ? { unset: true as const } : { value: SettingsDeclarationValueV1Schema.parse(value) }),
      ...('version' in current ? { settingsVersion: current.version } : {}) };
  };
  return args => params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => execute(args)) : execute(args);
}
