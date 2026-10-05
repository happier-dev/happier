import * as React from 'react';

import type { VoiceProviderSettingsActionDeclaration } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { VoiceProviderPresentation } from '@/voice/registry/voiceProviderPresentation';
import { Modal } from '@/modal';
import { log } from '@/log';
import { t, tLoose } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
  getExternalVoiceProviderRegistration,
} from '@/voice/registry/externalVoiceProviderRegistrations';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { useVoiceContributedSettingRefs } from '@/voice/settings/useVoiceContributedSettingRefs';

import { settingsActionInvoker, isContextCurrent, isPressedProviderSelected, readSafeSettingsActionErrorCode, type VoiceProviderSettingsActionOwner } from '@/voice/settings/voiceProviderSettingsActionInvoker';
export type { VoiceProviderSettingsActionOwner } from '@/voice/settings/voiceProviderSettingsActionInvoker';

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
  const code = readSafeSettingsActionErrorCode(error);
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

function localized(value: string | Readonly<{ key: string; fallback: string }>): string {
  return typeof value === 'string' ? value : value.fallback;
}

export function VoiceProviderSettingsActions(props: Readonly<{
  providerId: string;
  owner: VoiceProviderSettingsActionOwner;
  actions: readonly VoiceProviderSettingsActionDeclaration[];
  config?: Readonly<Record<string, unknown>>;
  agentAction?: VoiceProviderPresentation['agentAction'];
  placement: Readonly<{ kind: 'afterField'; fieldId: string }> | Readonly<{ kind: 'contributionFooter' }>;
}>) {
  const settingRef = useVoiceContributedSettingRefs(props.providerId);
  const registration = getExternalVoiceProviderRegistration(props.providerId);
  const settingsScope = useAccountSettingsScope();
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

  const agentAction = props.agentAction;
  const agentConfigured = agentAction && typeof props.config?.[agentAction.settingId] === 'string'
    && String(props.config[agentAction.settingId]).trim().length > 0;
  const actions = props.actions.filter((action) => (
    props.placement.kind === 'contributionFooter'
      ? action.placement.kind === 'contributionFooter'
      : action.placement.kind === 'afterField' && action.placement.fieldId === props.placement.fieldId
  )).filter((action) => !agentAction || (action.id !== agentAction.createActionId && action.id !== agentAction.updateActionId)
    || action.id === (agentConfigured ? agentAction.updateActionId : agentAction.createActionId));
  if (!registration?.settingsActions || !registration.occurrenceId || actions.length === 0) return null;
  const occurrenceId = registration.occurrenceId;

  return <>
    {actions.map((action) => {
      const enablingValue = action.enabledWhen
        ? props.config?.[action.enabledWhen.settingId]
        : undefined;
      const enabled = !action.enabledWhen
        || (typeof enablingValue === 'string' && enablingValue.trim().length > 0);
      const invoke = () => {
            if (busyActionIds.has(action.id) || !enabled) return;
            const signal = lifecycleRef.current.signal;
            const context = Object.freeze({
              actionId: action.id,
              providerId: props.providerId,
              occurrenceId,
              owner: props.owner,
              registration,
              settingsScope,
            });
            setBusyActionIds((current) => new Set(current).add(action.id));
            fireAndForget((async () => {
              try {
                await settingsActionInvoker.invoke({
                  key: `${props.providerId}/${occurrenceId}/${action.id}`,
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
      };
      const row = agentAction ? (
        <Item key={action.id} title={tLoose(agentAction.titleKey)} subtitleLines={0} showChevron={false}
          subtitle={busyActionIds.has(action.id) ? t('common.loading')
            : tLoose(agentConfigured ? agentAction.configuredStateKey : agentAction.missingStateKey)}
          rightElementOutsidePressable rightElement={<RoundButton testID={`voice-settings-action-${action.id}`}
            title={t(agentConfigured ? 'common.update' : 'common.create')} display="secondary" size="small"
            loading={busyActionIds.has(action.id)} disabled={busyActionIds.has(action.id) || !enabled} onPress={invoke} />} />
      ) : (
        <Item
          key={action.id}
          testID={`voice-settings-action-${action.id}`}
          title={localized(action.title)}
          loading={busyActionIds.has(action.id)}
          disabled={busyActionIds.has(action.id) || !enabled}
          onPress={invoke}
        />
      );
      const settings = (agentAction ? [agentAction.createActionId, agentAction.updateActionId] : [action.id])
        .flatMap((id) => { const setting = settingRef(`action.${id}`); return setting ? [setting] : []; });
      return settings.length ? <SettingAnchor key={action.id} settings={settings}>{row}</SettingAnchor> : row;
    })}
  </>;
}
