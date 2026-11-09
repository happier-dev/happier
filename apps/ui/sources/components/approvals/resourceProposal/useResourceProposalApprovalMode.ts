import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { getActionTargetApprovalRequired } from '@/components/settings/actions/actionSettingsTargetApproval';
import type { ActionSettingsActionId } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionSettingsTargetId } from '@/components/settings/actions/actionSettingsTargetDefinitions';
import { normalizeActionsSettings } from '@/components/settings/actions/normalizeActionsSettings';
import { useSetting } from '@/sync/domains/state/storage';

const CALLER_TARGETS: ReadonlySet<string> = new Set(['agent', 'mcp', 'voice', 'cli', 'api', 'plugin']);

/**
 * The card header's mode chip (lab `ra` A2): what this Action's own approval setting says for the caller
 * that asked — Ask first or Allowed. It only reflects the setting (R41); it decides nothing.
 */
export function useResourceProposalApprovalMode(approval: Pick<ApprovalRequest, 'actionId' | 'requestedSurface'>): 'ask_first' | 'allowed' | null {
    const raw = useSetting('actionsSettingsV1');
    const surface = approval.requestedSurface ?? 'agent';
    const targetId = (CALLER_TARGETS.has(surface) ? surface : 'agent') as ActionSettingsTargetId;
    const required = getActionTargetApprovalRequired({
        settings: normalizeActionsSettings(raw),
        actionId: approval.actionId as ActionSettingsActionId,
        targetId,
    });
    return required ? 'ask_first' : 'allowed';
}
