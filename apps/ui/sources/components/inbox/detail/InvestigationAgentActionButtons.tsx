import * as React from 'react';
import { useWindowDimensions, View } from 'react-native';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { AgentActionButton, Row, Stack } from '@happier-dev/plugin-ui/components';

import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { readFailureActionsBinding } from '@/hooks/inbox/failureActionsBinding';
import type { InvestigationAgentAction } from './healthNoticeInvestigation';
import { useOpenFailureActionEditor } from './useOpenFailureActionEditor';

/** A record to draw; the default record before the catalog answers has no id yet. */
export type InvestigationAgentActionButtonModel = Readonly<Omit<InvestigationAgentAction, 'actionId'> & { actionId?: string }>;

/**
 * A subject's statically declared records, drawn waiting until the person's catalog answers, so the row they settle
 * into is the row at first paint and nothing arrives later to push the page (VISUAL-136 D1, DEPLOY-ACCEPT-143 A6).
 */
export function declaredSubjectAgentActions(subject: string): readonly InvestigationAgentActionButtonModel[] {
  return readFailureActionsBinding(getActiveServerAccountScope())?.declaredActions
    ?.filter(action => action.subjects.includes(subject)) ?? [];
}

/**
 * A failure page's configured agent actions as the shared split control (owner ruling 2026-11-07, "Agent actions:
 * one shared flow"): each face launches its record in the record's own mode, the chevron offers the other launch.
 * Edit action… opens the one actions editor, Triage's page, on that record through the host's destination navigation,
 * the same open every Triage surface uses.
 */
export function InvestigationAgentActionButtons(props: Readonly<{
  actions: readonly InvestigationAgentActionButtonModel[];
  pending: boolean;
  /**
   * The subject's catalog hasn't answered yet: its declared records stand with their names, not pressable, instead of
   * as nameless spinners (a catalog that never answers, its Machine offline, would spin forever; PAGE-ACCEPT-176 R2-D14).
   */
  waiting?: boolean;
  compact: boolean;
  /**
   * Whether the first record leads (filled, the default: a failure page's one next step) or the surrounding view's own
   * primary does. Every record after the first stays secondary, so a page never shows two filled agent actions.
   */
  emphasis?: 'primary' | 'secondary';
  onLaunch: (mode: 'start' | 'review', actionId: string | undefined) => void;
  /**
   * The catalog read was refused (its Machine offline, Triage not answering) and the page has no record of its own to
   * press: nothing was pressed, so this is the controls' availability, said once and quietly with what it needs, in
   * the controls' place (PAGE-ACCEPT-176 R3-D1). A failure page that keeps its default Investigate passes nothing:
   * that press stays the next step and its own outcome says what happened.
   */
  unavailable?: Readonly<{ code: string }> | null;
  /** Reads the catalog again (the line's Retry). */
  onRetry?: () => void;
}>): React.ReactElement | null {
  const openEditor = useOpenFailureActionEditor();
  // A phone-width window recomposes a banner's actions (rowStackBelowWidthPx), whatever device class the page passed.
  const narrowWindow = useWindowDimensions().width < PAGE_LIST_METRICS.rowStackBelowWidthPx;
  if (props.unavailable) {
    // The line spans the controls' row, so its Retry stays on the sentence's line instead of wrapping under it.
    return <View style={UNAVAILABLE_LINE_STYLE}>
      <SurfaceStateCard testID="investigation.agentActions.unavailable" size="line" kind="unavailable"
        title={t(props.unavailable.code === 'machine_unreachable'
          ? 'inbox.work.healthNotice.agentActionsNeedMachine' : 'inbox.work.healthNotice.agentActionsUnavailable')}
        {...(props.onRetry ? { action: { label: t('common.retry'), onPress: props.onRetry } } : {})} />
    </View>;
  }
  if (props.actions.length === 0) return null;
  const buttons = props.actions.map((action, index) => (
    <AgentActionButton
      key={action.actionId ?? 'default'}
      title={action.label}
      {...(action.titleKey === undefined ? {} : { titleKey: action.titleKey })}
      launchMode={action.launchMode}
      {...(action.startable ? {} : { startUnavailableReason: t('ui.pluginUi.agentActionStartNeedsTask') })}
      onLaunch={(mode) => { props.onLaunch(mode, action.actionId); }}
      {...(openEditor === null ? {} : { onEdit: () => { openEditor(action.actionId); } })}
      pending={props.pending}
      {...(props.waiting === true ? { disabled: true } : {})}
      compact={props.compact}
      emphasis={index === 0 ? props.emphasis : 'secondary'}
    />
  ));
  // Core draws the public presenter inside the core Happier UI scope, as every other core consumer does.
  return (
    <CorePluginUiPresentationScope>
      {buttons.length === 1 ? buttons[0]
        // A phone stacks the split controls at one width (wider controls move beneath) instead of wrapping them ragged.
        : props.compact || narrowWindow ? <Stack gap="small" align="stretch">{buttons}</Stack>
        : <Row gap="small" align="center" wrap>{buttons}</Row>}
    </CorePluginUiPresentationScope>
  );
}

const UNAVAILABLE_LINE_STYLE = { alignSelf: 'stretch' } as const;
