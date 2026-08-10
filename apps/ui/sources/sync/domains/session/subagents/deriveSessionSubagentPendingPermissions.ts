import type { Message } from '@/sync/domains/messages/messageTypes';

import type { SessionSubagent } from './types';

/**
 * Which subagents are blocked on a person right now, for a whole roster in one pass.
 *
 * The per-subagent predicate this replaces was correct and quadratic: for every subagent whose
 * sidechain had not been hydrated yet it walked the **entire** transcript tree looking for that
 * subagent's tool call, so a session with N such subagents paid N full tree walks on every
 * transcript tick. The work is shared — one pre-order walk finds every wanted tool call at once —
 * so the roster costs one traversal plus a scan of each subagent's own (disjoint) subtree.
 *
 * The sidechain path is unchanged and still comes first: once a sidechain is loaded it is both the
 * cheaper and the more accurate source, because it is scoped to the subagent by construction.
 */

type SidechainToolPermissionLike = Readonly<{
    id?: string | null;
    status?: string | null;
    kind?: string | null;
}> | null;

type SidechainMessageLike = Readonly<{
    tool?: Readonly<{
        permission?: SidechainToolPermissionLike;
    }> | null;
}> | null;

type PermissionStateLike = Readonly<{
    status?: string | null;
}> | null;

type SidechainStateLike = Readonly<{
    sidechains?: ReadonlyMap<string, readonly SidechainMessageLike[]> | null;
    permissions?: ReadonlyMap<string, PermissionStateLike> | null;
}> | null;

const EMPTY_PENDING_PERMISSION_IDS: ReadonlySet<string> = Object.freeze(new Set<string>());

export function deriveSessionSubagentPendingPermissionIds(params: Readonly<{
    subagents: readonly SessionSubagent[];
    reducerState: SidechainStateLike;
    messages?: readonly Message[];
}>): ReadonlySet<string> {
    if (params.subagents.length === 0) return EMPTY_PENDING_PERMISSION_IDS;

    const pending = new Set<string>();
    const transcriptFallbackByToolId = new Map<string, SessionSubagent[]>();

    for (const subagent of params.subagents) {
        const sidechainId = subagent.transcript.sidechainId?.trim();
        const sidechainMessages = sidechainId ? params.reducerState?.sidechains?.get(sidechainId) : null;

        if (Array.isArray(sidechainMessages) && sidechainMessages.length > 0) {
            if (hasPendingSidechainPermission(sidechainMessages, params.reducerState)) {
                pending.add(subagent.id);
            }
            continue;
        }

        const toolId = subagent.transcript.toolId?.trim();
        if (!toolId) continue;
        const waiting = transcriptFallbackByToolId.get(toolId);
        if (waiting) waiting.push(subagent);
        else transcriptFallbackByToolId.set(toolId, [subagent]);
    }

    const messages = params.messages;
    if (transcriptFallbackByToolId.size === 0 || !Array.isArray(messages) || messages.length === 0) {
        return pending.size > 0 ? pending : EMPTY_PENDING_PERMISSION_IDS;
    }

    const childrenByToolId = new Map<string, readonly Message[]>();
    collectToolChildren(messages, new Set(transcriptFallbackByToolId.keys()), childrenByToolId);

    for (const [toolId, subagents] of transcriptFallbackByToolId) {
        const children = childrenByToolId.get(toolId);
        if (!children || children.length === 0) continue;
        if (!hasPendingPermissionInMessages(children, params.reducerState)) continue;
        for (const subagent of subagents) pending.add(subagent.id);
    }

    return pending.size > 0 ? pending : EMPTY_PENDING_PERMISSION_IDS;
}

function hasPendingSidechainPermission(
    sidechainMessages: readonly SidechainMessageLike[],
    reducerState: SidechainStateLike,
): boolean {
    for (let index = sidechainMessages.length - 1; index >= 0; index -= 1) {
        const permission = sidechainMessages[index]?.tool?.permission;
        if (!permission) continue;
        if (permission.kind === 'user_action') continue;
        if (readCurrentPermissionStatus({ permission, reducerState }) === 'pending') return true;
    }
    return false;
}

/**
 * Pre-order, first match wins — the same node any single-subagent search would have found, so the
 * shared walk cannot change which tool call a subagent is matched to. Returns as soon as every
 * wanted id is resolved, which on a hydrated session is usually before the first nested level.
 */
function collectToolChildren(
    messages: readonly Message[],
    wantedToolIds: ReadonlySet<string>,
    found: Map<string, readonly Message[]>,
): void {
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;

        const toolId = typeof message.tool.id === 'string' ? message.tool.id.trim() : '';
        if (toolId && wantedToolIds.has(toolId) && !found.has(toolId)) {
            found.set(toolId, message.children);
        }
        if (found.size === wantedToolIds.size) return;

        collectToolChildren(message.children, wantedToolIds, found);
        if (found.size === wantedToolIds.size) return;
    }
}

function hasPendingPermissionInMessages(
    messages: readonly Message[],
    reducerState: SidechainStateLike,
): boolean {
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;

        const permission = message.tool.permission;
        if (
            permission
            && permission.kind !== 'user_action'
            && readCurrentPermissionStatus({ permission, reducerState }) === 'pending'
        ) {
            return true;
        }

        if (hasPendingPermissionInMessages(message.children, reducerState)) return true;
    }

    return false;
}

/**
 * The reducer's permission table is authoritative when it knows the id: a message carries the
 * status it was written with, and an approval that arrived later only exists in the table.
 */
function readCurrentPermissionStatus(params: Readonly<{
    permission: NonNullable<SidechainToolPermissionLike>;
    reducerState: SidechainStateLike;
}>): string | null {
    const permissionId = typeof params.permission.id === 'string' ? params.permission.id.trim() : '';
    if (permissionId.length > 0) {
        const currentStatus = params.reducerState?.permissions?.get(permissionId)?.status;
        if (typeof currentStatus === 'string' && currentStatus.trim().length > 0) {
            return currentStatus.trim();
        }
    }

    return typeof params.permission.status === 'string' && params.permission.status.trim().length > 0
        ? params.permission.status.trim()
        : null;
}
