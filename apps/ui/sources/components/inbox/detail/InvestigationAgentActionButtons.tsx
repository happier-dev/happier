import * as React from 'react';
import { AgentActionButton, Row } from '@happier-dev/plugin-ui/components';

import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { t } from '@/text';
import type { InvestigationAgentAction } from './healthNoticeInvestigation';

/** A record to draw; the default record before the catalog answers has no id yet. */
export type InvestigationAgentActionButtonModel = Readonly<Omit<InvestigationAgentAction, 'actionId'> & { actionId?: string }>;

/**
 * A failure page's configured agent actions as the shared split control (owner ruling 2026-11-07, "Agent actions:
 * one shared flow"): each face launches its record in the record's own mode, the chevron offers the other launch.
 * Edit action… is omitted: the catalog editor lives in Triage and is not reachable from a core page.
 */
export function InvestigationAgentActionButtons(props: Readonly<{
  actions: readonly InvestigationAgentActionButtonModel[];
  pending: boolean;
  compact: boolean;
  onLaunch: (mode: 'start' | 'review', actionId: string | undefined) => void;
}>): React.ReactElement | null {
  if (props.actions.length === 0) return null;
  const buttons = props.actions.map((action) => (
    <AgentActionButton
      key={action.actionId ?? 'default'}
      title={action.label}
      {...(action.titleKey === undefined ? {} : { titleKey: action.titleKey })}
      launchMode={action.launchMode}
      {...(action.startable ? {} : { startUnavailableReason: t('ui.pluginUi.agentActionStartNeedsTask') })}
      onLaunch={(mode) => { props.onLaunch(mode, action.actionId); }}
      disabled={props.pending}
      compact={props.compact}
    />
  ));
  // Core draws the public presenter inside the core Happier UI scope, as every other core consumer does.
  return (
    <CorePluginUiPresentationScope>
      {buttons.length === 1 ? buttons[0] : <Row gap="small" align="center" wrap>{buttons}</Row>}
    </CorePluginUiPresentationScope>
  );
}
