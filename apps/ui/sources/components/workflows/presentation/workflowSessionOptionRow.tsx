import * as React from 'react';

import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
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
    // The Sessions list's own mark, read on the Session's Machine (it also knows Agents a Machine contributes).
    icon: <SessionAgentCatalogIdentityIcon agentId={option.agentId ?? ''} machineId={option.machineId} serverId={null} size={ICON_SIZE.md} />,
  };
}
