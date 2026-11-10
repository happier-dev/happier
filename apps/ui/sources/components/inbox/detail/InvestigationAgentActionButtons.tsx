import * as React from 'react';
import { AgentActionButton, Row } from '@happier-dev/plugin-ui/components';
import { buildTriageActionEditorLaunchInputV1, TRIAGE_APP_PAGE_DESTINATION_V1 } from '@happier-dev/triage-protocol/v1';

import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { t } from '@/text';
import type { InvestigationAgentAction } from './healthNoticeInvestigation';

/** A record to draw; the default record before the catalog answers has no id yet. */
export type InvestigationAgentActionButtonModel = Readonly<Omit<InvestigationAgentAction, 'actionId'> & { actionId?: string }>;

/**
 * A failure page's configured agent actions as the shared split control (owner ruling 2026-11-07, "Agent actions:
 * one shared flow"): each face launches its record in the record's own mode, the chevron offers the other launch.
 * Edit action… opens the one actions editor, Triage's page, on that record through the host's destination navigation,
 * the same open every Triage surface uses.
 */
export function InvestigationAgentActionButtons(props: Readonly<{
  actions: readonly InvestigationAgentActionButtonModel[];
  pending: boolean;
  compact: boolean;
  /**
   * Whether the first record leads (filled, the default: a failure page's one next step) or the surrounding view's own
   * primary does. Every record after the first stays secondary, so a page never shows two filled agent actions.
   */
  emphasis?: 'primary' | 'secondary';
  onLaunch: (mode: 'start' | 'review', actionId: string | undefined) => void;
}>): React.ReactElement | null {
  const navigation = usePluginSurfaceDestinationNavigationBinding();
  if (props.actions.length === 0) return null;
  const buttons = props.actions.map((action, index) => (
    <AgentActionButton
      key={action.actionId ?? 'default'}
      title={action.label}
      {...(action.titleKey === undefined ? {} : { titleKey: action.titleKey })}
      launchMode={action.launchMode}
      {...(action.startable ? {} : { startUnavailableReason: t('ui.pluginUi.agentActionStartNeedsTask') })}
      onLaunch={(mode) => { props.onLaunch(mode, action.actionId); }}
      {...(navigation === null ? {} : { onEdit: () => {
        void navigation.openSurface({ destination: TRIAGE_APP_PAGE_DESTINATION_V1,
          input: buildTriageActionEditorLaunchInputV1(action.actionId), subPath: '' });
      } })}
      disabled={props.pending}
      compact={props.compact}
      emphasis={index === 0 ? props.emphasis : 'secondary'}
    />
  ));
  // Core draws the public presenter inside the core Happier UI scope, as every other core consumer does.
  return (
    <CorePluginUiPresentationScope>
      {buttons.length === 1 ? buttons[0] : <Row gap="small" align="center" wrap>{buttons}</Row>}
    </CorePluginUiPresentationScope>
  );
}
