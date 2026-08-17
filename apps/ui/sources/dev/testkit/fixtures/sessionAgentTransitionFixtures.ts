import type { Message } from '@/sync/domains/messages/messageTypes';

/**
 * Shared fixtures for same-Session cross-Agent continuation.
 *
 * These builders are the single source of truth for the transition divider
 * payload and for the multi-Agent transcript corpus used by attention, unread,
 * and historical-attribution tests. When the ratified protocol shape changes,
 * change it here rather than in each consuming test.
 */

export const AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX = 'agent-transition:';

export function buildAgentTransitionDividerLocalId(submittedLocalId: string): string {
    return `${AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX}${submittedLocalId}`;
}

/**
 * The transition divider agent-event payload: an existing passthrough
 * `type: 'message'` event carrying a nested `sessionAgentTransitionV1` sidecar.
 */
export function createAgentTransitionDividerEventFixture(overrides: Readonly<{
    fromAgentId?: string;
    toAgentId?: string;
    message?: string;
    sidecar?: unknown;
}> = {}): Record<string, unknown> {
    return {
        type: 'message',
        message: overrides.message ?? 'Continued with another Agent.',
        sessionAgentTransitionV1: overrides.sidecar ?? {
            v: 1,
            fromAgentId: overrides.fromAgentId ?? 'claude',
            toAgentId: overrides.toAgentId ?? 'codex',
        },
    };
}

/** The stored (plaintext Account) content envelope for any agent event. */
export function createStoredAgentEventContentFixture(
    event: Record<string, unknown>,
    overrides: Readonly<{ id?: string }> = {},
): unknown {
    return {
        t: 'plain',
        v: {
            role: 'agent',
            content: { type: 'event', id: overrides.id ?? 'divider-1', data: event },
        },
    };
}

/**
 * The encrypted-Account variant of the same stored row. Content-derived
 * attention resolution must stay undecidable (`null`) here rather than
 * defaulting to attention-bearing.
 */
export function createStoredEncryptedContentFixture(ciphertext = 'ciphertext-1'): unknown {
    return { t: 'encrypted', c: ciphertext };
}

export function createAgentEventMessageFixture(
    event: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
): Message {
    return {
        id: 'divider-1',
        kind: 'agent-event',
        localId: buildAgentTransitionDividerLocalId('local-1'),
        createdAt: 5_000,
        seq: 50,
        event,
        ...overrides,
    } as unknown as Message;
}

export function createAgentTransitionDividerMessageFixture(overrides: Readonly<{
    fromAgentId?: string;
    toAgentId?: string;
    seq?: number;
    createdAt?: number;
    id?: string;
    submittedLocalId?: string;
}> = {}): Message {
    return createAgentEventMessageFixture(
        createAgentTransitionDividerEventFixture({
            ...(overrides.fromAgentId ? { fromAgentId: overrides.fromAgentId } : {}),
            ...(overrides.toAgentId ? { toAgentId: overrides.toAgentId } : {}),
        }),
        {
            ...(overrides.id ? { id: overrides.id } : {}),
            ...(overrides.seq === undefined ? {} : { seq: overrides.seq }),
            ...(overrides.createdAt === undefined ? {} : { createdAt: overrides.createdAt }),
            localId: buildAgentTransitionDividerLocalId(overrides.submittedLocalId ?? 'local-1'),
        },
    );
}

export type MixedAgentTranscriptFixture = Readonly<{
    /** Newest-last transcript rows, including the divider row when present. */
    messages: readonly Message[];
    sourceAgentId: string;
    targetAgentId: string;
    /** Sequence of the divider row, or `null` for the never-switched variant. */
    dividerSeq: number | null;
    /** Rows whose historical Agent must resolve to the source Agent. */
    sourceAgentSeqs: readonly number[];
    /** Rows whose historical Agent must resolve to the target Agent. */
    targetAgentSeqs: readonly number[];
    /** Rows with no usable evidence; must resolve neutral rather than guess. */
    neutralSeqs: readonly number[];
    /**
     * A committed row that never received a sequence (an optimistic local row).
     * It carries no position, so it must resolve neutral.
     */
    unsequencedMessage: Message;
}>;

/**
 * One Session viewed through the ratified divider-boundary attribution model
 * (`AM-17`): rows after a transition divider belong to its `toAgentId`, rows
 * before the earliest divider to its `fromAgentId`, everything else neutral.
 *
 * The divider row marks the end of the source's span, so the boundary sequence
 * itself stays with the source; only rows strictly after it are the target's.
 *
 * `withDivider: false` returns the same corpus with no divider at all — the
 * never-switched Session, whose every row must resolve neutral so that
 * attribution leaves the live-metadata answer untouched. That variant is the
 * regression oracle for the overwhelming majority of Sessions.
 *
 * Seq 20 is deliberately a source-produced row that landed *after* the divider
 * (the stop/cutover race). Divider boundaries are the only evidence this tier
 * has, so it is attributed to the target: an accepted, documented bound of the
 * model rather than a silent surprise.
 */
export function createMixedAgentTranscriptFixture(overrides: Readonly<{
    sourceAgentId?: string;
    targetAgentId?: string;
    withDivider?: boolean;
}> = {}): MixedAgentTranscriptFixture {
    const sourceAgentId = overrides.sourceAgentId ?? 'claude';
    const targetAgentId = overrides.targetAgentId ?? 'codex';
    const withDivider = overrides.withDivider ?? true;

    const text = (seq: number, kind: 'user-text' | 'agent-text'): Message => ({
        id: `msg-${seq}`,
        kind,
        localId: null,
        createdAt: seq * 100,
        seq,
        text: `row ${seq}`,
    } as unknown as Message);

    const unsequencedMessage: Message = {
        id: 'msg-local',
        kind: 'agent-text',
        localId: 'local-pending',
        createdAt: 5_000,
        text: 'row without a sequence',
    } as unknown as Message;

    const beforeDivider = [text(1, 'agent-text'), text(5, 'user-text'), text(10, 'agent-text')];
    const afterDivider = [
        text(20, 'agent-text'),
        text(25, 'user-text'),
        text(30, 'agent-text'),
        text(40, 'agent-text'),
        text(41, 'agent-text'),
    ];

    if (!withDivider) {
        return {
            messages: [...beforeDivider, ...afterDivider, unsequencedMessage],
            sourceAgentId,
            targetAgentId,
            dividerSeq: null,
            sourceAgentSeqs: [],
            targetAgentSeqs: [],
            neutralSeqs: [1, 5, 10, 20, 25, 30, 40, 41],
            unsequencedMessage,
        };
    }

    return {
        messages: [
            ...beforeDivider,
            createAgentTransitionDividerMessageFixture({
                fromAgentId: sourceAgentId,
                toAgentId: targetAgentId,
                id: 'msg-15',
                seq: 15,
                createdAt: 1_500,
            }),
            ...afterDivider,
            unsequencedMessage,
        ],
        sourceAgentId,
        targetAgentId,
        dividerSeq: 15,
        sourceAgentSeqs: [1, 5, 10, 15],
        targetAgentSeqs: [20, 25, 30, 40, 41],
        neutralSeqs: [],
        unsequencedMessage,
    };
}
