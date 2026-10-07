import { createHostPluginSettingsActionInvoker } from '@happier-dev/protocol/plugins/settingsActionInvoker';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { VoiceRealtimeJsonValueSchema } from '@happier-dev/protocol/voice/realtime/events';
import type { VoiceProviderSettingsActionDeclaration } from '@happier-dev/protocol/plugins/contributions/voice';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { storage } from '@/sync/domains/state/storage';
import { readVoiceProviderSettingsConfig, voiceSettingsParse, writeVoiceProviderSettingsConfig, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { getExternalVoiceProviderRegistration, type ExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { resolveVoiceProviderIdForSettingsAction } from '@/voice/settings/resolveVoiceProviderId';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

export type VoiceProviderSettingsActionOwner = Readonly<{
  schemaVersion: number;
  defaultConfig: Readonly<Record<string, unknown>>;
  parseConfig(value: unknown): Readonly<Record<string, unknown>> | null;
}>;
export type ActionContext = Readonly<{
  actionId: string;
  providerId: string;
  occurrenceId: string;
  owner: VoiceProviderSettingsActionOwner;
  registration: ExternalVoiceProviderRegistration;
  settingsScope: AccountSettingsScope | null;
  callerIsCurrent?: () => boolean;
}>;
function localized(value: string | Readonly<{ key: string; fallback: string }>): string {
  return typeof value === 'string' ? value : value.fallback;
}
function actionError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const SAFE_SETTINGS_ACTION_ERROR_CODES = new Set([
  'invalid_parameters',
  'credential_unavailable',
  'credential_access_review_required',
  'provider_unavailable',
  'operation_unsupported',
  'rate_limited',
  'request_timeout',
  'provider_response_invalid',
  'internal_error',
  // The provider refused a setting the user can change. An enum value is a
  // structural fact, not provider prose, so it is admitted while the response
  // text that carried it stays out of the projection.
  'voice_not_found',
  'voice_account_operation_unauthorized',
  'voice_provider_settings_action_context_missing',
  'voice_provider_settings_action_retired',
  'voice_provider_settings_action_unavailable',
  'voice_provider_settings_version_unavailable',
  'voice_provider_settings_invalid',
  'voice_provider_settings_action_patch_invalid',
  'voice_provider_settings_action_conflict',
  'voice_provider_settings_action_outcome_unknown',
  'voice_provider_settings_action_confirmation_unavailable',
  'voice_account_operation_cancelled',
  // Host/protocol lifecycle constants. Allowlisted so a press that ends
  // without applying anything can still name why in one bounded record.
  'plugin_settings_action_generation_retired',
  'plugin_settings_action_confirmation_declined',
  'plugin_settings_action_cancelled',
  'plugin_settings_action_busy',
]);


export function readSafeSettingsActionErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" && SAFE_SETTINGS_ACTION_ERROR_CODES.has(error.code) ? error.code : null;
}

/** The user moved to another Voice provider: the press was superseded by them. */
export function isPressedProviderSelected(context: ActionContext): boolean {
  return resolveVoiceProviderIdForSettingsAction(
    storage.getState().settings.voice,
    context.providerId,
  ) === context.providerId;
}

export function isContextCurrent(context: ActionContext): boolean {
  return context.callerIsCurrent?.() !== false
    && getExternalVoiceProviderRegistration(context.providerId) === context.registration
    && areAccountSettingsScopesEqual(storage.getState().settingsScope, context.settingsScope)
    && isPressedProviderSelected(context);
}

/** Absence uses the declared default; opaque or invalid existing envelopes never do. */
function readActionConfig(context: ActionContext, voice: VoiceSettings) {
  const envelope = voice.providers[context.providerId];
  if (!envelope) return context.owner.parseConfig(context.owner.defaultConfig);
  if (envelope.schemaVersion !== context.owner.schemaVersion) return null;
  return context.owner.parseConfig(readVoiceProviderSettingsConfig(voice, context.providerId));
}

export const settingsActionInvoker = createHostPluginSettingsActionInvoker<ActionContext, void>({
  createError: actionError,
  async confirm({ declaration, signal, context }) {
    if (!context) throw actionError('voice_provider_settings_action_context_missing');
    const { createAppShellTransientInteractions } = await import('@/components/appShell/plugins/appShellQuestionInteractions');
    const confirmation = declaration.confirmation.kind === 'required' ? declaration.confirmation : {
      title: declaration.title,
      description: declaration.title,
      confirmLabel: t('common.ok'),
    };
    const interactions = createAppShellTransientInteractions({
      requester: {
        pluginId: context.registration.pluginId,
        contributionId: context.registration.localId,
        occurrenceId: context.occurrenceId,
        invocationId: context.actionId,
      },
      signal,
      isCurrent: () => isContextCurrent(context),
    });
    const outcome = await interactions.confirm({
      kind: 'confirmation',
      title: localized(confirmation.title),
      message: localized(confirmation.description),
    }, {
      presentationContext: {
        confirmLabel: localized(confirmation.confirmLabel),
      },
    });
    // A confirmation that could not be presented is a failure, not a decline:
    // the user never saw the question, so the action must not end in silence.
    if (outcome.status !== 'approved' && outcome.status !== 'declined' && outcome.status !== 'userCancelled') {
      // The generic invoker owns the post-confirmation currentness check. Let
      // it classify a retired invocation instead of relabeling that lifecycle
      // fact as an unavailable dialog.
      if (!isContextCurrent(context) || signal.aborted) return false;
      throw actionError('voice_provider_settings_action_confirmation_unavailable');
    }
    return outcome.status === 'approved';
  },
  async snapshot({ signal, context }) {
    if (!context) throw actionError('voice_provider_settings_action_context_missing');
    throwIfAborted(signal);
    await getSyncSingleton().prepareAccountSettingsForDaemonSpawn();
    throwIfAborted(signal);
    if (!isContextCurrent(context)) throw actionError('voice_provider_settings_action_retired');
    // Read revision and values from one canonical storage projection after the
    // Account Settings owner has flushed. A server update may settle while the
    // preparation promise is pending, so its earlier hint must not be paired
    // with settings from a later projection.
    const accountSettingsSnapshot = storage.getState();
    const version = accountSettingsSnapshot.settingsVersion;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
      throw actionError('voice_provider_settings_version_unavailable');
    }
    const voice = voiceSettingsParse(accountSettingsSnapshot.settings.voice);
    const config = readActionConfig(context, voice);
    const parsed = VoiceRealtimeJsonValueSchema.safeParse(config);
    if (!parsed.success || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
      throw actionError('voice_provider_settings_invalid');
    }
    return Object.freeze({
      values: Object.freeze(parsed.data as Readonly<Record<string, JsonValue>>),
      revision: String(version),
    });
  },
  async execute(input, context, { signal }) {
    if (!context) throw actionError('voice_provider_settings_action_context_missing');
    if (!isContextCurrent(context)) throw actionError('voice_provider_settings_action_retired');
    const actions = context.registration.settingsActions;
    if (!actions) throw actionError('voice_provider_settings_action_unavailable');
    const settingsVersion = Number(input.settingsRevision);
    if (!Number.isInteger(settingsVersion) || settingsVersion < 0) {
      throw actionError('voice_provider_settings_version_unavailable');
    }
    return await actions.execute({ ...input, signal });
  },
  async applyPatch({ snapshot, patch, signal, context }) {
    if (!context) throw actionError('voice_provider_settings_action_context_missing');
    throwIfAborted(signal);
    const expectedSettingsVersion = Number(snapshot.revision);
    if (!Number.isInteger(expectedSettingsVersion) || expectedSettingsVersion < 0) {
      throw actionError('voice_provider_settings_version_unavailable');
    }
    const mutateAtVersion = async (version: number) => await getSyncSingleton().mutateAccountSettingsOnce({
      expectedSettingsScope: context.settingsScope,
      expectedSettingsVersion: version,
      mutate(raw) {
        if (!isContextCurrent(context) || signal.aborted) {
          throw actionError('voice_provider_settings_action_retired');
        }
        const voice = voiceSettingsParse(raw.voiceSettingsV1);
        const currentConfig = readActionConfig(context, voice);
        const nextConfig = currentConfig
          ? context.owner.parseConfig({ ...currentConfig, ...patch })
          : null;
        if (!nextConfig) throw actionError('voice_provider_settings_action_patch_invalid');
        const nextVoice = writeVoiceProviderSettingsConfig(voice, context.providerId, nextConfig);
        return Object.freeze({
          settings: { ...raw, voiceSettingsV1: nextVoice },
          value: undefined,
        });
      },
    });
    let result = await mutateAtVersion(expectedSettingsVersion);
    throwIfAborted(signal);
    if (result.status === 'conflict') {
      if (!isContextCurrent(context)) {
        throw actionError('voice_provider_settings_action_retired');
      }
      const refreshedVoice = voiceSettingsParse(storage.getState().settings.voice);
      const refreshedConfig = readActionConfig(context, refreshedVoice);
      const actionReadFieldsAreUnchanged = refreshedConfig !== null
        && Object.entries(snapshot.values).every(([fieldId, value]) => (
          Object.hasOwn(refreshedConfig, fieldId)
          && pluginJsonValuesEqual(value, refreshedConfig[fieldId] as JsonValue)
        ));
      if (!actionReadFieldsAreUnchanged) {
        throw actionError('voice_provider_settings_action_outcome_unknown');
      }
      result = await mutateAtVersion(result.currentSettingsVersion);
      throwIfAborted(signal);
      if (result.status === 'conflict') {
        throw actionError('voice_provider_settings_action_outcome_unknown');
      }
    }
    if (result.status === 'outcomeUnknown') {
      // The Account Settings owner already performed its only safe readback.
      // A settings action must not report its provider patch as applied.
      throw actionError('voice_provider_settings_action_outcome_unknown');
    }
  },
});

/** Agent requests enter the same action lifecycle, with actual human admission rather than a gesture claim. */
export async function invokeVoiceProviderSettingsAction(input: Readonly<{
  providerId: string;
  owner: VoiceProviderSettingsActionOwner;
  declaration: VoiceProviderSettingsActionDeclaration;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}>) {
  const registration = getExternalVoiceProviderRegistration(input.providerId);
  if (!registration?.settingsActions || !registration.occurrenceId) return { status: 'unavailable' as const, reason: 'provider_unavailable' };
  const context: ActionContext = Object.freeze({
    actionId: input.declaration.id, providerId: input.providerId,
    occurrenceId: registration.occurrenceId, owner: input.owner, registration,
    settingsScope: storage.getState().settingsScope,
    callerIsCurrent: input.isCurrent,
  });
  if (!isContextCurrent(context)) return { status: 'unavailable' as const, reason: 'provider_not_selected' };
  const config = readActionConfig(context, voiceSettingsParse(storage.getState().settings.voice));
  const enabledWhen = input.declaration.enabledWhen;
  if (enabledWhen && (typeof config?.[enabledWhen.settingId] !== 'string' || !(config[enabledWhen.settingId] as string).trim())) {
    return { status: 'unavailable' as const, reason: 'setting_prerequisite_missing' };
  }
  try {
    await settingsActionInvoker.invoke({
      key: `${input.providerId}/${registration.occurrenceId}/${input.declaration.id}`,
      declaration: input.declaration, userGesture: false, requestHumanInteraction: true,
      signal: input.signal ?? new AbortController().signal,
      isCurrent: () => isContextCurrent(context), context,
    });
    return { status: 'completed' as const };
  } catch (error) {
    const code = readSafeSettingsActionErrorCode(error) ?? 'internal_error';
    return { status: code === 'plugin_settings_action_confirmation_declined' ? 'cancelled' as const : 'unavailable' as const, reason: code };
  }
}
