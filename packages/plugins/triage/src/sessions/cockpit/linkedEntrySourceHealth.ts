import type { TriageSourceSessionLinksLaneV1 } from '../../actions/sessionLinksProtocol.js';
import type { TriageListInvocationErrorV1 } from '../../actions/listEntriesProtocol.js';
import { readTriageSourceFailureCopyV1, TRIAGE_SOURCE_UNAVAILABLE_COPY_V1 } from '../../ui/shell/windowState.js';

/** One translated sentence: its key and the English fallback `text(key, fallback)` takes. */
export type TriageLinkSourceReasonV1 = Readonly<{ key: string; fallback: string }>;

/** A configured source whose Session links could not be read, in the reader's words. */
export type TriageUnavailableLinkSourceV1 = Readonly<{
    /** The user's own name for the connection, never an instance id. */
    label: string;
    reason: TriageLinkSourceReasonV1;
    diagnostic?: TriageListInvocationErrorV1;
}>;

const NO_SESSION_LINKS: TriageLinkSourceReasonV1 = Object.freeze({
    key: 'plugins.triage.sessionLinks.sourceNoLinks',
    fallback: 'This source doesn’t support session links.',
});

/**
 * Why a lane could not be read. A source that is not admitted, or never settled, reuses the shell's one sentence
 * for an unavailable source; a source whose descriptor cannot link Sessions says so; every other typed failure
 * reuses the shell's sentence for its class. Technical codes stay in the Details disclosure.
 */
function readLaneReason(health: TriageSourceSessionLinksLaneV1['health']): TriageLinkSourceReasonV1 {
    if (health.kind !== 'failed') return TRIAGE_SOURCE_UNAVAILABLE_COPY_V1;
    switch (health.failure.code) {
        case 'sessionLinksSourceNotAdmitted': return TRIAGE_SOURCE_UNAVAILABLE_COPY_V1;
        case 'sessionLinksKindUnsupported':
        case 'sessionLinksRolesUnsupported': return NO_SESSION_LINKS;
        default: return readTriageSourceFailureCopyV1(health.failure.class);
    }
}

/**
 * The sources a Session's relation read could not cover, one entry per source and reason. Several kind lanes of
 * one source that fail the same way are one cause and read as one line.
 */
export function projectTriageUnavailableLinkSources(
    lanes: readonly TriageSourceSessionLinksLaneV1[] | undefined,
): readonly TriageUnavailableLinkSourceV1[] {
    const sources = new Map<string, TriageUnavailableLinkSourceV1>();
    for (const lane of lanes ?? []) {
        if (lane.health.kind === 'complete') continue;
        const reason = readLaneReason(lane.health);
        const diagnostic = lane.health.kind === 'failed'
            ? lane.health.invocationError ?? { code: lane.health.failure.code } : undefined;
        const key = `${lane.displayLabel}\u0000${reason.key}\u0000${diagnostic?.code ?? ''}\u0000${diagnostic?.requestId ?? ''}`;
        if (!sources.has(key)) sources.set(key, Object.freeze({ label: lane.displayLabel, reason, diagnostic }));
    }
    return Object.freeze([...sources.values()]);
}
