import * as React from 'react';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';

import type { WorkflowEventPresentation } from './useWorkflowEventPresentation';

/**
 * An event's mark: the Agent's own mark for a Session event whose Agent is known ("Claude started a turn"), else the
 * event's glyph. The row and the page header draw the same mark at their own size.
 */
export function WorkflowEventMark(
  props: Readonly<{
    presentation: Pick<WorkflowEventPresentation, 'agentId' | 'glyph'>;
    size?: number;
  }>,
) {
  const size = props.size ?? ICON_SIZE.md;
  return props.presentation.agentId !== null ? (
    // The Agent's mark in its own colours, as the Sessions list draws it (lab events:A).
    <AgentIcon agentId={props.presentation.agentId} size={size} />
  ) : (
    <Icon name={props.presentation.glyph} size={size} />
  );
}
