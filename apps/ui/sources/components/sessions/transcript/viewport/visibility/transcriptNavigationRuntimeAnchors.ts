import type { TranscriptNavigationAnchorCandidate } from './deriveCurrentTranscriptAnchor';
import type {
    TranscriptNavigationEntry,
    TranscriptNavigationRole,
} from '../../navigation/transcriptNavigationTypes';
import type { TranscriptJumpTarget } from '../jump/transcriptJumpTargetTypes';

export type TranscriptNavigationRuntimeAnchorMessage = Readonly<{
    messageId: string;
    routeMessageId: string | null;
    seq: number | null;
    transcriptBlockIndex: number | null;
    role: TranscriptNavigationRole;
}>;

export type TranscriptNavigationRenderedAnchorSource = Readonly<{
    sourceIndex: number;
    messageIds: readonly string[];
    messages: readonly TranscriptNavigationRuntimeAnchorMessage[];
}>;

/**
 * A resolved anchor keeps the entry identity it was matched from, so a jump
 * target (built from those same fields by the navigation jump plan) can be
 * mapped back to its anchor without a second identity vocabulary.
 */
export type TranscriptNavigationRuntimeAnchor = TranscriptNavigationAnchorCandidate & Readonly<{
    messageIds: readonly string[];
    role: TranscriptNavigationRole;
    routeMessageId: string | null;
    seq: number | null;
    transcriptBlockIndex: number | null;
}>;

function normalizeString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.trunc(value);
}

function normalizeRole(role: TranscriptNavigationRole | null | undefined): TranscriptNavigationRole {
    if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') return role;
    return 'unknown';
}

function dedupeStrings(values: readonly unknown[]): readonly string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const normalized = normalizeString(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

type RenderedAnchorCandidate = Readonly<{
    source: TranscriptNavigationRenderedAnchorSource;
    message: TranscriptNavigationRuntimeAnchorMessage;
}>;

/**
 * Rendered rows indexed by the identities an entry can name: route/message id, and seq for
 * entries without a route id. One pass over the rendered rows, then each entry reads only its
 * own candidates, so deriving anchors stays linear in the loaded transcript instead of
 * entries x rows. Candidates keep rendered order.
 */
function indexRenderedSources(renderedSources: readonly TranscriptNavigationRenderedAnchorSource[]) {
    const byId = new Map<string, RenderedAnchorCandidate[]>();
    const bySeq = new Map<number, RenderedAnchorCandidate[]>();
    const add = <K,>(map: Map<K, RenderedAnchorCandidate[]>, key: K, candidate: RenderedAnchorCandidate) => {
        const list = map.get(key);
        if (list) list.push(candidate); else map.set(key, [candidate]);
    };
    for (const source of renderedSources) {
        if (normalizeInteger(source.sourceIndex) === null) continue;
        for (const message of source.messages) {
            const candidate = { source, message };
            const routeMessageId = normalizeString(message.routeMessageId);
            const messageId = normalizeString(message.messageId);
            if (routeMessageId) add(byId, routeMessageId, candidate);
            if (messageId && messageId !== routeMessageId) add(byId, messageId, candidate);
            const seq = normalizeInteger(message.seq);
            if (seq !== null) add(bySeq, seq, candidate);
        }
    }
    return { byId, bySeq };
}

/**
 * Resolves the MOST SPECIFIC rendered row for an entry. A group header row
 * carries every message id in the group, so a first-match scan hands a pinned
 * tool the group's source index — and a second pinned tool in the same group
 * then resolves to the identical anchor. Fewer message ids means a narrower row,
 * so the tool's own item wins over its group header; ties keep the earliest
 * rendered row.
 */
function resolveMostSpecificSourceForEntry(
    index: ReturnType<typeof indexRenderedSources>,
    entry: TranscriptNavigationEntry,
): TranscriptNavigationRenderedAnchorSource | null {
    const entryRouteMessageId = normalizeString(entry.routeMessageId);
    const entrySeq = normalizeInteger(entry.seq);
    const entryBlockIndex = normalizeInteger(entry.transcriptBlockIndex);
    const entryRole = normalizeRole(entry.role);
    const candidates = entryRouteMessageId
        ? index.byId.get(entryRouteMessageId)
        : entrySeq === null ? undefined : index.bySeq.get(entrySeq);
    let best: TranscriptNavigationRenderedAnchorSource | null = null;
    let bestSpecificity = Number.POSITIVE_INFINITY;
    for (const { source, message } of candidates ?? []) {
        if (entrySeq !== null && normalizeInteger(message.seq) !== entrySeq) continue;
        if (entryRole !== 'unknown' && normalizeRole(message.role) !== entryRole) continue;
        if (entryBlockIndex !== null && normalizeInteger(message.transcriptBlockIndex) !== entryBlockIndex) continue;
        const specificity = source.messages.length;
        if (specificity < bestSpecificity) {
            best = source;
            bestSpecificity = specificity;
        }
    }
    return best;
}

export function deriveTranscriptNavigationRuntimeAnchors(params: Readonly<{
    entries: readonly TranscriptNavigationEntry[];
    renderedSources: readonly TranscriptNavigationRenderedAnchorSource[];
}>): TranscriptNavigationRuntimeAnchor[] {
    const anchors: TranscriptNavigationRuntimeAnchor[] = [];
    const seen = new Set<string>();
    const index = indexRenderedSources(params.renderedSources);
    for (const entry of params.entries) {
        const id = normalizeString(entry.id);
        if (!id || seen.has(id)) continue;
        const source = resolveMostSpecificSourceForEntry(index, entry);
        if (!source) continue;
        anchors.push({
            id,
            kind: entry.kind,
            sourceIndex: normalizeInteger(source.sourceIndex) ?? 0,
            messageIds: dedupeStrings(source.messageIds),
            role: normalizeRole(entry.role),
            routeMessageId: normalizeString(entry.routeMessageId),
            seq: normalizeInteger(entry.seq),
            transcriptBlockIndex: normalizeInteger(entry.transcriptBlockIndex),
        });
        seen.add(id);
    }
    return anchors;
}

/**
 * Inverse of the navigation jump plan: a rail/pane press builds its target from
 * the entry's route id, seq, block index, and role, so an anchor carrying those
 * same fields identifies the jump's destination. A bare-seq target (deep link,
 * route jump) can match several anchors sharing that seq; the earliest rendered
 * row wins, which is exactly the row the seq jump command itself lands on.
 */
export function resolveTranscriptNavigationAnchorIdForJumpTarget(params: Readonly<{
    anchors: readonly TranscriptNavigationRuntimeAnchor[];
    target: TranscriptJumpTarget;
}>): string | null {
    const target = params.target;
    const routeMessageId = target.kind === 'route-message-id' ? normalizeString(target.routeMessageId) : null;
    const seq = normalizeInteger(target.kind === 'seq' ? target.seq : target.seqHint);
    const transcriptBlockIndex = target.kind === 'route-message-id'
        ? normalizeInteger(target.transcriptBlockIndex)
        : null;
    const role = target.kind === 'route-message-id' ? normalizeRole(target.role) : 'unknown';
    if (!routeMessageId && seq === null) return null;

    let best: TranscriptNavigationRuntimeAnchor | null = null;
    for (const anchor of params.anchors) {
        if (routeMessageId !== null) {
            if (anchor.routeMessageId !== routeMessageId) continue;
            // `seqHint` is a hint: it only discriminates when both sides know one.
            if (seq !== null && anchor.seq !== null && anchor.seq !== seq) continue;
        } else if (anchor.seq !== seq) {
            continue;
        }
        if (transcriptBlockIndex !== null && anchor.transcriptBlockIndex !== transcriptBlockIndex) continue;
        if (role !== 'unknown' && anchor.role !== role) continue;
        if (best === null || anchor.sourceIndex < best.sourceIndex) best = anchor;
    }
    return best?.id ?? null;
}
