import * as React from 'react';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { useBundledConversationProviderSettings } from './useBundledConversationProviderSettings';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';

import type { VoiceProviderSettingsActionDeclaration } from '@happier-dev/protocol/plugins/contributions/voice';

import { Item } from '@/components/ui/lists/Item';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { VoiceProviderPresentation } from '@/voice/registry/voiceProviderPresentation';
import { Modal } from '@/modal';
import { log } from '@/log';
import { t, tLoose } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { getExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { useVoiceContributedSettingRefs } from '@/voice/settings/useVoiceContributedSettingRefs';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

import { isPressedProviderSelected, projectSafeSettingsActionFailure, type SafeSettingsActionFailureDiagnostic, type VoiceProviderSettingsActionOwner } from '@/voice/settings/voiceProviderSettingsActionInvoker';
export type { VoiceProviderSettingsActionOwner } from '@/voice/settings/voiceProviderSettingsActionInvoker';

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
    ...(diagnostic.failureCause
      ? presentActionExecutionFailure({ ok: false, errorCode: diagnostic.code ?? 'internal_error',
        failureCause: diagnostic.failureCause }).technicalDetails.map(detail => `${detail.label}: ${detail.value}`)
      : []),
    ...(diagnostic.responseFailure?.validation?.map(issue => `${issue.path}: ${issue.code}`) ?? []),
    ...(!diagnostic.failureCause && diagnostic.stage
      ? [t('settingsVoice.realtimeProviders.operationFailedStage', { stage: diagnostic.stage })]
      : []),
    ...(!diagnostic.failureCause && diagnostic.responseFailure
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

/** Shared mounted ingress for the contributed control and Finish setup. */
function useVoiceProviderSettingsAction(props: Readonly<{
  providerId: string;
  owner: VoiceProviderSettingsActionOwner | null;
}>) {
  const settingRef = useVoiceContributedSettingRefs(props.providerId);
  const registrationToken = getExternalVoiceProviderRegistration(props.providerId)?.token;
  const settingsScope = useAccountSettingsScope();
  const { execute } = useMountedActionExecution(settingsScope);
  const [busyActionIds, setBusyActionIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const lifecycleRef = React.useRef(new AbortController());
  const lifecycleIdentity = React.useRef({ providerId: props.providerId, registrationToken });
  // Whether this panel is still on screen. `signal.aborted` cannot answer that:
  // it is also raised when the user switches provider under a mounted panel.
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; lifecycleRef.current.abort(); };
  }, []);
  React.useEffect(() => {
    const previousIdentity = lifecycleIdentity.current;
    lifecycleIdentity.current = { providerId: props.providerId, registrationToken };
    // The admitted operation creates its first registration. Replacing an
    // existing occurrence still retires its pending mounted confirmation.
    if (previousIdentity.providerId === props.providerId && !previousIdentity.registrationToken && registrationToken) return;
    const previous = lifecycleRef.current;
    lifecycleRef.current = new AbortController();
    previous.abort();
    setBusyActionIds(new Set());
  }, [props.providerId, registrationToken]);

  const invoke = React.useCallback((action: VoiceProviderSettingsActionDeclaration, enabled: boolean) => {
    if (!props.owner || busyActionIds.has(action.id) || !enabled) return false;
    const signal = lifecycleRef.current.signal;
    setBusyActionIds((current) => new Set(current).add(action.id));
    fireAndForget((async () => {
      try {
        const setting = settingRef(`action.${action.id}`);
        if (!setting) throw Object.assign(new Error('voice_provider_settings_action_unavailable'), { code: 'voice_provider_settings_action_unavailable' });
        const outcome = await execute('settings.invoke', { anchor: setting.anchor }, { signal });
        if (!outcome.ok && presentActionTurnedOffNoticeIfOff(outcome, 'settings.invoke')) return;
        requireActionSuccess(outcome);
        const result = SettingsDeclarationActionOutputSchemasV1['settings.invoke'].parse(outcome.result);
        if (result.status === 'cancelled') return;
        if (result.status !== 'completed') {
          const diagnostic = projectSafeSettingsActionFailure(result.value);
          throw Object.assign(new Error(result.reason ?? 'voice_provider_settings_action_unavailable'), diagnostic,
            { code: result.reason ?? 'voice_provider_settings_action_unavailable' });
        }
      } catch (error) {
        const code = (error as Readonly<{ code?: unknown }>)?.code;
        // Every press that applies nothing is nameable, including the
        // ones the user is not alerted about. Only an outcome the user
        // caused (declining, leaving, switching provider) stays quiet;
        // anything else would make the row a placebo.
        const outcome = code === 'plugin_settings_action_confirmation_declined'
          || code === 'plugin_settings_action_cancelled'
          || isActionApprovalDeclinedErrorCode(code)
          ? 'declined'
          : !mountedRef.current
            ? 'unmounted'
            : isPressedProviderSelected({ providerId: props.providerId })
              ? 'failed'
              : 'deselected';
        const diagnostic = projectSafeSettingsActionFailure(error);
        log.log(
          `[VoiceProviderSettingsActions] settings action ${outcome} ${JSON.stringify({
            actionId: action.id,
            ...(signal.aborted ? { aborted: true } : {}),
            ...(signal.aborted || outcome === 'deselected' ? { retired: true } : {}),
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
    return true;
  }, [props.owner, props.providerId, busyActionIds, settingRef, execute]);
  return { busyActionIds, invoke };
}

function isSettingsActionEnabled(action: VoiceProviderSettingsActionDeclaration, config?: Readonly<Record<string, unknown>> | null): boolean {
  const value = action.enabledWhen ? config?.[action.enabledWhen.settingId] : undefined;
  return !action.enabledWhen || typeof value === 'string' && value.trim().length > 0;
}

function isAgentConfigured(agentAction: VoiceProviderPresentation['agentAction'], config?: Readonly<Record<string, unknown>> | null): boolean {
  return Boolean(agentAction && typeof config?.[agentAction.settingId] === 'string'
    && String(config[agentAction.settingId]).trim().length > 0);
}

const registry = createDefaultVoiceProviderRegistry();

/** Finish setup enters the same confirmed Action as the provider's Create/Update control. */
export function useVoiceProviderSettingsRecovery(voice: VoiceSettings) {
  const { providerId, owner, config } = useBundledConversationProviderSettings(voice);
  const { invoke } = useVoiceProviderSettingsAction({ providerId: providerId ?? '', owner });
  const entry = providerId ? registry.get(providerId) : null;
  const agentAction = entry?.presentation?.agentAction;
  const actionId = agentAction ? isAgentConfigured(agentAction, config) ? agentAction.updateActionId : agentAction.createActionId : null;
  const action = entry?.kind === 'voice.conversation-provider.v1'
    ? entry.declaration?.settings?.actions?.find(candidate => candidate.id === actionId) : null;
  return React.useCallback((recovery: VoiceRoleReadiness['recoveryAction']): boolean => {
    if (recovery !== 'open_provider_settings' || !action || !owner) return false;
    return invoke(action, isSettingsActionEnabled(action, config));
  }, [action, config, invoke, owner]);
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
  const { busyActionIds, invoke: invokeAction } = useVoiceProviderSettingsAction(props);
  const agentAction = props.agentAction;
  const agentConfigured = isAgentConfigured(agentAction, props.config);
  const actions = props.actions.filter((action) => (
    props.placement.kind === 'contributionFooter'
      ? action.placement.kind === 'contributionFooter'
      : action.placement.kind === 'afterField' && action.placement.fieldId === props.placement.fieldId
  )).filter((action) => !agentAction || (action.id !== agentAction.createActionId && action.id !== agentAction.updateActionId)
    || action.id === (agentConfigured ? agentAction.updateActionId : agentAction.createActionId));
  if (actions.length === 0) return null;

  return <>
    {actions.map((action) => {
      const enabled = isSettingsActionEnabled(action, props.config);
      const invoke = () => invokeAction(action, enabled);
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
