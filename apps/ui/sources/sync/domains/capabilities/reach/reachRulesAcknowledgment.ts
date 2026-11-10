import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { McpRulesSetOutputV1Schema, SkillsRulesSetOutputV1Schema } from '@happier-dev/protocol/actions/specs/capabilityRules';

/** A successful execution is not a rules write until the typed receipt acknowledges this item. */
export function readReachRulesAcknowledgment(kind: 'skill' | 'mcp_server', itemId: string, receipt: ActionExecuteResult) {
    if (!receipt.ok) return { ok: false as const, code: receipt.errorCode ?? 'internal_error', message: receipt.error };
    const parsed = (kind === 'skill' ? SkillsRulesSetOutputV1Schema : McpRulesSetOutputV1Schema).safeParse(receipt.result);
    if (!parsed.success) return { ok: false as const, code: 'invalid_action_output', message: 'invalid_action_output' };
    if (!parsed.data.ok) return { ok: false as const, code: parsed.data.code, message: parsed.data.code };
    const item = parsed.data.items.find(item => ('skillId' in item ? item.skillId : item.serverId) === itemId);
    return item ? { ok: true as const, revision: parsed.data.revision, item }
        : { ok: false as const, code: 'invalid_action_output', message: 'invalid_action_output' };
}
