import * as React from 'react';

import type { VoiceProviderSettingsActionDeclaration } from '@happier-dev/protocol';
import { createHostPluginSettingsActionInvoker, VoiceRealtimeJsonValueSchema } from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import { Item } from '@/components/ui/lists/Item';
import { createAppShellTransientInteractions } from '@/components/appShell/plugins/appShellQuestionInteractions';
import { Modal } from '@/modal';
import { log } from '@/log';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { storage } from '@/sync/domains/state/storage';
import {
  readVoiceProviderSettingsConfig,
  voiceSettingsParse,
  writeVoiceProviderSettingsConfig,
} from '@/sync/domains/settings/voiceSettings';
import { t, tLoose } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import {
  getExternalVoiceProviderRegistration,
  type ExternalVoiceProviderRegistration,
} from '@/voice/registry/externalVoiceProviderRegistrations';
import { resolveVoiceProviderIdForSettingsAction } from '@/voice/settings/resolveVoiceProviderId';

export type VoiceProviderSettingsActionOwner = Readonly<{
  defaultConfig: Readonly<Record<string, unknown>>;
  parseConfig(value: unknown): Readonly<Record<string, unknown>> | null;
}>;

type ActionContext = Readonly<{
  actionId: string;
  providerId: string;
  owner: VoiceProviderSettingsActionOwner;
  registration: ExternalVoiceProviderRegistration;
}>;

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

const SAFE_RESPONSE_FAILURE_KINDS = new Set([
  'redirect',
  'http_status',
  'content_type',
  'body_too_large',
  'body_read_failed',
  'json_projection_failed',
]);

/**
 * Provider-declared failure stage. Admitted as a short opaque token so the
 * failing step is nameable without the host branching on plugin ids.
 */
const SAFE_STAGE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/iu;

/**
 * Host projection of a settings-action failure.
 *
 * It is an allowlist of structural facts and deliberately has no channel for
 * the provider's own response text. A provider error body is arbitrary prose:
 * it can legitimately echo user or startup instructions, tool definitions,
 * account/workspace/agent identifiers, and transcript fragments, none of which
 * are byte-identical to a registered credential and none of which a credential
 * scrubber can therefore remove. Anything the plugin attaches beyond these
 * fields is dropped rather than bounded, so no provider sentence can reach a
 * Happier log or a synchronized diagnostic.
 */
type SafeSettingsActionFailureDiagnostic = Readonly<{
  code?: string;
  stage?: string;
  responseFailure?: Readonly<{
    kind: string;
    status: number;
    statusClass: string;
  }>;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function projectSafeSettingsActionFailure(error: unknown): SafeSettingsActionFailureDiagnostic {
  const record = readRecord(error);
  if (!record) return Object.freeze({});
  const code = typeof record.code === 'string' && SAFE_SETTINGS_ACTION_ERROR_CODES.has(record.code)
    ? record.code
    : null;
  const stage = typeof record.stage === 'string' && SAFE_STAGE_PATTERN.test(record.stage)
    ? record.stage
    : null;
  const rawResponseFailure = readRecord(record.responseFailure);
  let responseFailure: SafeSettingsActionFailureDiagnostic['responseFailure'];
  if (
    rawResponseFailure
    && typeof rawResponseFailure.kind === 'string'
    && SAFE_RESPONSE_FAILURE_KINDS.has(rawResponseFailure.kind)
    && typeof rawResponseFailure.status === 'number'
    && Number.isInteger(rawResponseFailure.status)
    && rawResponseFailure.status >= 100
    && rawResponseFailure.status <= 599
  ) {
    const statusClass = `${Math.floor(rawResponseFailure.status / 100)}xx`;
    if (rawResponseFailure.statusClass === statusClass) {
      responseFailure = Object.freeze({
        kind: rawResponseFailure.kind,
        status: rawResponseFailure.status,
        statusClass,
      });
    }
  }
  return Object.freeze({
    ...(code ? { code } : {}),
    ...(stage ? { stage } : {}),
    ...(responseFailure ? { responseFailure } : {}),
  });
}

/**
 * Localized remedies for the projected codes that name a setting the user can
 * actually correct. Composed from the code alone, so the sentence is Happier's
 * own copy rather than a rephrasing of the provider's response.
 */
const ACTIONABLE_FAILURE_COPY_KEYS: Readonly<Record<string, string>> = Object.freeze({
  voice_not_found: 'settingsVoice.realtimeProviders.operationFailedVoiceNotFound',
  voice_provider_settings_action_outcome_unknown:
    'settingsProviders.errors.mutationOutcomeUnknownDescription',
});

/**
 * Composes the alert from the projected structural facts only. Naming the
 * failing step and the provider status keeps a failed press actionable —
 * reportable and distinguishable from a rejected request — without repeating a
 * single character of the provider's own response.
 */
function settingsActionFailureBody(
  diagnostic: SafeSettingsActionFailureDiagnostic,
): string {
  const remedyKey = diagnostic.code ? ACTIONABLE_FAILURE_COPY_KEYS[diagnostic.code] : undefined;
  const facts = [
    ...(diagnostic.stage
      ? [t('settingsVoice.realtimeProviders.operationFailedStage', { stage: diagnostic.stage })]
      : []),
    ...(diagnostic.responseFailure
      ? [t(
        'settingsVoice.realtimeProviders.operationFailedStatus',
        { status: diagnostic.responseFailure.status },
      )]
      : []),
  ];
  if (!remedyKey && facts.length === 0) {
    return tLoose('settingsVoice.realtimeProviders.operationFailed');
  }
  const headline = tLoose(
    remedyKey ?? 'settingsVoice.realtimeProviders.operationFailedUnsaved',
  );
  return facts.length === 0 ? headline : `${headline}\n\n${facts.join('\n')}`;
}

const registrationGenerations = new WeakMap<object, number>();
let nextRegistrationGeneration = 1;

function registrationGeneration(token: object): number {
  const existing = registrationGenerations.get(token);
  if (existing) return existing;
  const generation = nextRegistrationGeneration++;
  registrationGenerations.set(token, generation);
  return generation;
}

function localized(value: string | Readonly<{ key: string; fallback: string }>): string {
  return typeof value === 'string' ? value : value.fallback;
}

function actionError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** The user moved to another Voice provider: the press was superseded by them. */
function isPressedProviderSelected(context: ActionContext): boolean {
  return resolveVoiceProviderIdForSettingsAction(
    storage.getState().settings.voice,
    context.providerId,
  ) === context.providerId;
}

function isContextCurrent(context: ActionContext): boolean {
  return getExternalVoiceProviderRegistration(context.providerId) === context.registration
    && isPressedProviderSelected(context);
}

const settingsActionInvoker = createHostPluginSettingsActionInvoker<ActionContext, void>({
  createError: actionError,
  async confirm({ declaration, signal, context }) {
    if (declaration.confirmation.kind !== 'required') return true;
    if (!context) throw actionError('voice_provider_settings_action_context_missing');
    const interactions = createAppShellTransientInteractions({
      requester: {
        pluginId: context.registration.pluginId,
        contributionId: context.registration.localId,
        generationId: String(registrationGeneration(context.registration.token)),
        invocationId: context.actionId,
      },
      signal,
      isCurrent: () => isContextCurrent(context),
    });
    const outcome = await interactions.confirm({
      kind: 'confirmation',
      title: localized(declaration.confirmation.title),
      message: localized(declaration.confirmation.description),
    }, {
      presentationContext: {
        confirmLabel: localized(declaration.confirmation.confirmLabel),
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
    const prepared = await getSyncSingleton().prepareAccountSettingsForDaemonSpawn();
    throwIfAborted(signal);
    if (!isContextCurrent(context)) throw actionError('voice_provider_settings_action_retired');
    const version = prepared.accountSettingsVersionHint;
    if (typeof version !== 'number') throw actionError('voice_provider_settings_version_unavailable');
    const voice = voiceSettingsParse(storage.getState().settings.voice);
    const config = context.owner.parseConfig(
      readVoiceProviderSettingsConfig(voice, context.providerId),
    ) ?? context.owner.parseConfig(context.owner.defaultConfig);
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
    return await actions.execute({ ...input, signal });
  },
  async applyPatch({ snapshot, patch, signal, context }) {
    if (!context) throw actionError('voice_provider_settings_action_context_missing');
    throwIfAborted(signal);
    const expectedSettingsVersion = Number(snapshot.revision);
    if (!Number.isInteger(expectedSettingsVersion) || expectedSettingsVersion < 0) {
      throw actionError('voice_provider_settings_version_unavailable');
    }
    const result = await getSyncSingleton().mutateAccountSettingsOnce({
      expectedSettingsVersion,
      mutate(raw) {
        if (!isContextCurrent(context) || signal.aborted) {
          throw actionError('voice_provider_settings_action_retired');
        }
        const voice = voiceSettingsParse(raw.voiceSettingsV1);
        const currentConfig = context.owner.parseConfig(
          readVoiceProviderSettingsConfig(voice, context.providerId),
        ) ?? context.owner.parseConfig(context.owner.defaultConfig);
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
    throwIfAborted(signal);
    if (result.status === 'conflict') {
      throw actionError('voice_provider_settings_action_conflict');
    }
    if (result.status === 'outcomeUnknown') {
      // The Account Settings owner already performed its only safe readback.
      // A settings action must not report its provider patch as applied.
      throw actionError('voice_provider_settings_action_outcome_unknown');
    }
  },
});

export function VoiceProviderSettingsActions(props: Readonly<{
  providerId: string;
  owner: VoiceProviderSettingsActionOwner;
  actions: readonly VoiceProviderSettingsActionDeclaration[];
  config?: Readonly<Record<string, unknown>>;
  placement: Readonly<{ kind: 'afterField'; fieldId: string }> | Readonly<{ kind: 'contributionFooter' }>;
}>) {
  const registration = getExternalVoiceProviderRegistration(props.providerId);
  const [busyActionIds, setBusyActionIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const lifecycleRef = React.useRef(new AbortController());
  // Whether this panel is still on screen. `signal.aborted` cannot answer that:
  // it is also raised when the activation scope re-commits the registration
  // under a mounted panel, which is exactly when the user must be told.
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  React.useEffect(() => {
    const previous = lifecycleRef.current;
    lifecycleRef.current = new AbortController();
    previous.abort();
    setBusyActionIds(new Set());
    return () => lifecycleRef.current.abort();
  }, [props.providerId, registration?.token]);

  const actions = props.actions.filter((action) => (
    props.placement.kind === 'contributionFooter'
      ? action.placement.kind === 'contributionFooter'
      : action.placement.kind === 'afterField' && action.placement.fieldId === props.placement.fieldId
  ));
  if (!registration?.settingsActions || actions.length === 0) return null;

  return <>
    {actions.map((action) => {
      const enablingValue = action.enabledWhen
        ? props.config?.[action.enabledWhen.settingId]
        : undefined;
      const enabled = !action.enabledWhen
        || (typeof enablingValue === 'string' && enablingValue.trim().length > 0);
      return (
        <Item
          key={action.id}
          testID={`voice-settings-action-${action.id}`}
          title={localized(action.title)}
          loading={busyActionIds.has(action.id)}
          disabled={busyActionIds.has(action.id) || !enabled}
          onPress={() => {
            if (busyActionIds.has(action.id) || !enabled) return;
            const signal = lifecycleRef.current.signal;
            const context = Object.freeze({
              actionId: action.id,
              providerId: props.providerId,
              owner: props.owner,
              registration,
            });
            setBusyActionIds((current) => new Set(current).add(action.id));
            fireAndForget((async () => {
              try {
                await settingsActionInvoker.invoke({
                  key: `${props.providerId}/${registrationGeneration(registration.token)}/${action.id}`,
                  declaration: action,
                  userGesture: true,
                  signal,
                  isCurrent: () => isContextCurrent(context),
                  context,
                });
              } catch (error) {
                const code = (error as Readonly<{ code?: unknown }>)?.code;
                // Every press that applies nothing is nameable, including the
                // ones the user is not alerted about. Only an outcome the user
                // caused (declining, leaving, switching provider) stays quiet;
                // anything else would make the row a placebo.
                const outcome = code === 'plugin_settings_action_confirmation_declined'
                  || code === 'plugin_settings_action_cancelled'
                  ? 'declined'
                  : !mountedRef.current
                    ? 'unmounted'
                    : isPressedProviderSelected(context)
                      ? 'failed'
                      : 'deselected';
                const diagnostic = projectSafeSettingsActionFailure(error);
                log.log(
                  `[VoiceProviderSettingsActions] settings action ${outcome} ${JSON.stringify({
                    actionId: action.id,
                    ...(signal.aborted ? { aborted: true } : {}),
                    ...(isContextCurrent(context) ? {} : { retired: true }),
                    ...diagnostic,
                  })}`,
                );
                if (outcome !== 'failed') return;
                await Modal.alertAsync(
                  t('common.error'),
                  settingsActionFailureBody(diagnostic),
                );
              } finally {
                if (mountedRef.current) {
                  setBusyActionIds((current) => {
                    const next = new Set(current);
                    next.delete(action.id);
                    return next;
                  });
                }
              }
            })(), { tag: `VoiceProviderSettingsActions.${action.id}` });
          }}
        />
      );
    })}
  </>;
}
