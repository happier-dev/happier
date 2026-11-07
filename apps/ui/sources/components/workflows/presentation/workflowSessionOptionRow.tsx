import * as React from 'react';

import { SessionAgentMark } from '@/agents/registry/SessionAgentMark';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import type { WorkflowExistingSessionOption } from '@/sync/domains/workflows/workflowAuthoring';

/**
 * How a Session choice reads in every Session chooser (built-ins, examples, trigger popover, editor
 * Conversation): its Agent's mark and "Agent · Machine" under the title, the identity the
 * participant picker gives the same Session, so two Sessions with one title can be told apart.
 */
export function workflowSessionOptionRow(option: WorkflowExistingSessionOption): Readonly<{
  subtitle?: string;
  icon: React.ReactElement;
}> {
  return {
    ...(option.contextLabel ? { subtitle: option.contextLabel } : {}),
    icon: <SessionAgentMark agentId={option.agentId} size={ICON_SIZE.md} />,
  };
}
