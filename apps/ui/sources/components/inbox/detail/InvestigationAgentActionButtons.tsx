import * as React from 'react';
import { View } from 'react-native';
import { AgentActionButton } from '@happier-dev/plugin-ui/components';

import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import type { FailureAgentCatalogOutcome } from '@/hooks/inbox/useInvestigateFailure';
import type { InvestigationAgentAction } from './healthNoticeInvestigation';
import { useOpenFailureActionEditor } from './useOpenFailureActionEditor';

/** A record to draw; the default record before the catalog answers has no id yet. */
export type InvestigationAgentActionButtonModel = Readonly<Omit<InvestigationAgentAction, 'actionId'> & { actionId?: string }>;

function describeCatalogOutcome(outcome: FailureAgentCatalogOutcome) {
  if (outcome.kind === 'loading') return t('inbox.work.healthNotice.agentActionsLoading');
  switch (outcome.code) {
    case 'machine_unreachable': return t('inbox.work.healthNotice.agentActionsNeedMachine');
    case 'agent_unavailable': return t('inbox.work.healthNotice.agentActionsNeedAgent');
    case 'no_agent_actions': return t('inbox.work.healthNotice.agentActionsNotConfigured');
    case 'plugin_action_execution_failed': return t('inbox.work.healthNotice.agentActionsDispatchFailed');
    default: return t('inbox.work.healthNotice.agentActionsUnavailable');
  }
}

/**
 * A failure page's configured agent actions as the shared split control (owner ruling 2026-11-07, "Agent actions:
 * one shared flow"): the face launches the first record in its own mode; the chevron offers the other launch, then
 * every other configured record.
 * Edit action… opens the one actions editor, Triage's page, on that record through the host's destination navigation,
 * the same open every Triage surface uses.
 */
export function InvestigationAgentActionButtons(props: Readonly<{
  actions: readonly InvestigationAgentActionButtonModel[];
  pending: boolean;
  compact: boolean;
  /**
   * Whether the first record leads (filled, the default: a failure page's one next step) or the surrounding view's own
   * primary does. Every record after the first is a row in its menu, so a page never shows two agent controls.
   */
  emphasis?: 'primary' | 'secondary';
  onLaunch: (mode: 'start' | 'review', actionId: string | undefined) => void;
  /** The Account owner's catalog state, shown in the controls' place. */
  catalogOutcome?: FailureAgentCatalogOutcome | null;
  /** Reads the catalog again (the line's Retry). */
  onRetry?: () => void;
}>): React.ReactElement | null {
  const openEditor = useOpenFailureActionEditor();
  if (props.catalogOutcome) {
    // The line spans the controls' row, so its Retry stays on the sentence's line instead of wrapping under it.
    return <View style={UNAVAILABLE_LINE_STYLE}>
      <SurfaceStateCard testID={`investigation.agentActions.${props.catalogOutcome.kind}`} size="line" kind={props.catalogOutcome.kind}
        title={describeCatalogOutcome(props.catalogOutcome)}
        {...(props.onRetry ? { action: { label: t('common.retry'), onPress: props.onRetry } } : {})} />
    </View>;
  }
  const [first, ...others] = props.actions;
  if (!first) return null;
  // One control per failure (R15-D7): the first record is the split; every other configured action is a row in its
  // menu, launched in that record's own mode, so a card never stacks a split per action.
  const otherGroups = others.length === 0 ? undefined : [{
    id: 'other-agent-actions',
    accessibilityLabel: t('common.more'),
    items: others.map((action, index) => ({ id: `${OTHER_ACTION_PREFIX}${index}`, label: action.label })),
  }];
  // Core draws the public presenter inside the core Happier UI scope, as every other core consumer does.
  return (
    <CorePluginUiPresentationScope>
      <AgentActionButton
        key={first.actionId ?? 'default'}
        title={first.label}
        {...(first.titleKey === undefined ? {} : { titleKey: first.titleKey })}
        launchMode={first.launchMode}
        {...(first.startable ? {} : { startUnavailableReason: t('ui.pluginUi.agentActionStartNeedsTask') })}
        onLaunch={(mode) => { props.onLaunch(mode, first.actionId); }}
        {...(openEditor === null ? {} : { onEdit: () => { openEditor(first.actionId); } })}
        {...(otherGroups ? {
          groups: otherGroups,
          showGroupLabels: false,
          onSelectDestination: (id: string) => {
            const other = others[Number(id.slice(OTHER_ACTION_PREFIX.length))];
            if (other) props.onLaunch(other.launchMode, other.actionId);
          },
        } : {})}
        pending={props.pending}
        compact={props.compact}
        emphasis={props.emphasis}
      />
    </CorePluginUiPresentationScope>
  );
}

const OTHER_ACTION_PREFIX = 'other-agent-action:';
const UNAVAILABLE_LINE_STYLE = { alignSelf: 'stretch' } as const;
