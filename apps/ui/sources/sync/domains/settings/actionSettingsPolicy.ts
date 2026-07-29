import { ACTION_ID_FAMILIES_V1, listVoiceToolActionSpecs, type ActionId } from '@happier-dev/protocol';

/**
 * Canonical "is this a device-inventory tool" classification, gated by the voice
 * `shareDeviceInventory` privacy toggle. Derived directly from the protocol-owned
 * inventory action family so the set is a single source of truth: every tool that
 * enumerates device inventory — recent paths, machines, servers, AND the agent
 * backend/model and review-engine inventory tools — is classified here. Hand-maintaining
 * a divergent subset previously let `agents.backends.list` / `agents.models.list` /
 * `review.engines.list` leak inventory when `shareDeviceInventory` was off (FIND-018).
 */
const INVENTORY_PRIVACY_ACTION_IDS: ReadonlySet<ActionId> = new Set<ActionId>(
    ACTION_ID_FAMILIES_V1.inventory as readonly ActionId[],
);

const RECENT_MESSAGES_PRIVACY_ACTION_IDS: ReadonlySet<ActionId> = new Set<ActionId>([
    'session.transcript.get',
    'session.messages.recent.get',
]);

const VOICE_TOOL_ACTION_ID_BY_NAME: ReadonlyMap<string, ActionId> = (() => {
    const entries: Array<readonly [string, ActionId]> = [];
    for (const spec of listVoiceToolActionSpecs()) {
        entries.push([spec.id, spec.id as ActionId]);
        const toolName = String(spec.bindings?.voiceClientToolName ?? '').trim();
        if (toolName) entries.push([toolName, spec.id as ActionId]);
    }
    return new Map(entries);
})();

export function isInventoryPrivacyAction(actionId: ActionId): boolean {
    return INVENTORY_PRIVACY_ACTION_IDS.has(actionId);
}

export function isInventoryPrivacyVoiceToolName(toolName: string): boolean {
    const normalized = String(toolName ?? '').trim();
    if (!normalized) return false;
    const actionId = VOICE_TOOL_ACTION_ID_BY_NAME.get(normalized);
    return actionId ? isInventoryPrivacyAction(actionId) : false;
}

export function isRecentMessagesPrivacyVoiceToolName(toolName: string): boolean {
    const normalized = String(toolName ?? '').trim();
    if (!normalized) return false;
    const actionId = VOICE_TOOL_ACTION_ID_BY_NAME.get(normalized);
    return actionId ? RECENT_MESSAGES_PRIVACY_ACTION_IDS.has(actionId) : false;
}
