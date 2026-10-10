import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import {
    NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    SESSION_AGENT_ACTIVITY_ATTENTION_KINDS,
    type SessionAgentActivityAttentionKind,
} from '@/sync/domains/session/agentActivity/types';
import type { Message } from "@happier-dev/session-core/messages";

import type { SessionSubagent } from './types';

/**
 * What this subagent is currently waiting on a PERSON for.
 *
 * The predecessor of this module answered a boolean and reached it by skipping
 * `permission.kind === 'user_action'` entirely, so an agent that had asked the user a question was
 * indistinguishable from an agent that had asked nothing. That made "Needs your answer" unsayable
 * anywhere in the app, however many surfaces wanted to say it. The scan is otherwise unchanged: the
 * same sidechain-first / parent-transcript-fallback lookup, and the same current-status resolution
 * through the reducer's permission table.
 *
 * The result is deduplicated and in `SESSION_AGENT_ACTIVITY_ATTENTION_KINDS` order, and the empty
 * case is the one shared frozen array — a row that gained no attention keeps its previous array
 * identity, which is what keeps the memoized roster memoized.
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

/**
 * The attention kind a still-pending permission record represents, or `null`.
 *
 * A record whose `kind` the client does not recognise contributes nothing rather than defaulting to
 * `permission`: announcing "needs approval" for a prompt whose shape we could not read is the
 * failure mode this vocabulary exists to prevent.
 */
function readPendingAttentionKind(params: Readonly<{
    permission: SidechainToolPermissionLike;
    reducerState: SidechainStateLike;
}>): SessionAgentActivityAttentionKind | null {
    const { permission } = params;
    if (!permission) return null;
    if (readCurrentPermissionStatus({ permission, reducerState: params.reducerState }) !== 'pending') return null;
    // A record with no `kind` at all is the historical permission shape, which predates the
    // user-action arm; reading it as `permission` preserves its meaning rather than inventing one.
    const kind = typeof permission.kind === 'string' ? permission.kind.trim() : '';
    if (kind === 'user_action') return 'user_action';
    if (kind === 'permission' || kind.length === 0) return 'permission';
    return null;
}

/** Pending prompts by permission id, in first-seen order. */
type PendingPromptMap = Map<string, SessionAgentActivityAttentionKind>;

function recordPending(
    found: PendingPromptMap,
    permission: SidechainToolPermissionLike,
    kind: SessionAgentActivityAttentionKind,
): void {
    const id = typeof permission?.id === 'string' ? permission.id.trim() : '';
    // A pending record without an id still counts toward attention; it just cannot be answered in
    // place, so it gets a key that can never match a Session request.
    found.set(id.length > 0 ? id : `anonymous:${found.size}`, kind);
}

function collectFromMessages(params: Readonly<{
    messages: readonly Message[];
    reducerState: SidechainStateLike;
    found: PendingPromptMap;
}>): void {
    for (const message of params.messages) {
        if (message.kind !== 'tool-call') continue;

        const permission = message.tool.permission;
        if (!permission) continue;

        const kind = readPendingAttentionKind({
            permission,
            reducerState: params.reducerState,
        });
        if (kind) recordPending(params.found, permission, kind);

        collectFromMessages({
            messages: message.children,
            reducerState: params.reducerState,
            found: params.found,
        });
    }
}

function findSubagentToolChildren(params: Readonly<{
    messages: readonly Message[];
    toolId: string | null;
}>): readonly Message[] {
    for (const message of params.messages) {
        if (message.kind !== 'tool-call') continue;

        if (params.toolId && message.tool.id === params.toolId) {
            return message.children;
        }

        const nested = findSubagentToolChildren({
            messages: message.children,
            toolId: params.toolId,
        });
        if (nested.length > 0) return nested;
    }

    return [];
}

function toCanonicalOrder(
    found: ReadonlyMap<string, SessionAgentActivityAttentionKind>,
): readonly SessionAgentActivityAttentionKind[] {
    if (found.size === 0) return NO_SESSION_AGENT_ACTIVITY_ATTENTION;
    const kinds = new Set(found.values());
    return SESSION_AGENT_ACTIVITY_ATTENTION_KINDS.filter((kind) => kinds.has(kind));
}

type PendingPromptScanParams = Readonly<{
    subagent: SessionSubagent;
    reducerState: SidechainStateLike;
    messages?: readonly Message[];
}>;

function scanPendingPrompts(params: PendingPromptScanParams): PendingPromptMap {
    const found: PendingPromptMap = new Map();

    const sidechainId = readNonBlankOpaqueIdentifier(params.subagent.transcript.sidechainId);
    const sidechainMessages = sidechainId ? params.reducerState?.sidechains?.get(sidechainId) : null;

    if (Array.isArray(sidechainMessages) && sidechainMessages.length > 0) {
        // The loaded sidechain is the complete record for this subagent, so it answers on its own —
        // walking the parent transcript as well would double-count a prompt already seen here.
        for (const sidechainMessage of sidechainMessages) {
            const permission = sidechainMessage?.tool?.permission ?? null;
            const kind = readPendingAttentionKind({
                permission,
                reducerState: params.reducerState,
            });
            if (kind) recordPending(found, permission, kind);
        }
        return found;
    }

    const toolId = params.subagent.transcript.toolId?.trim() || null;
    if (Array.isArray(params.messages) && params.messages.length > 0) {
        const focusedMessages = findSubagentToolChildren({
            messages: params.messages,
            toolId,
        });
        if (focusedMessages.length > 0) {
            collectFromMessages({
                messages: focusedMessages,
                reducerState: params.reducerState,
                found,
            });
        }
    }

    return found;
}

export function deriveSessionSubagentPendingAttentionKinds(
    params: PendingPromptScanParams,
): readonly SessionAgentActivityAttentionKind[] {
    return toCanonicalOrder(scanPendingPrompts(params));
}

export type SessionSubagentPendingPrompt = Readonly<{
    /** The permission id, which is also the Session request id that answers it. */
    id: string;
    kind: SessionAgentActivityAttentionKind;
}>;

/**
 * The prompts this subagent is waiting on, by the ids a Session request carries — the same scan the
 * attention kinds come from, so a row that says "Needs approval" can always name what it waits on.
 */
export function listSessionSubagentPendingPrompts(
    params: PendingPromptScanParams,
): readonly SessionSubagentPendingPrompt[] {
    return [...scanPendingPrompts(params)].map(([id, kind]) => ({ id, kind }));
}
