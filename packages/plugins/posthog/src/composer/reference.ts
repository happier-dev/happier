/**
 * The daemon-side PostHog Composer-reference provider for selected Tier-B evidence.
 *
 * The UI-safe candidate codec is separate so a mounted detail can disclose an opaque
 * candidate without importing the account/HTTP runtime. This resolver never reads a
 * Composer, sees its origin ref, or mutates a draft; Triage retains all of that custody.
 */

import {
    PluginError,
    type ComposerReferenceCandidatePageV1,
    type ComposerReferenceResolutionV1,
    type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';

import { createPosthogInvocationClient } from '../api/invocationClient.js';
import { normalizePosthogApiOrigin } from '../connect/origin.js';
import {
    POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
    POSTHOG_PLUGIN_ID,
} from '../posthogContracts.js';
import { readPosthogSampledIssueEvents } from '../source/detail/issueEvents.js';
import { runPosthogBoundedInvocation } from '../source/invocationDeadline.js';
import { POSTHOG_MOUNTED_DETAIL_DEADLINE_MS } from '../source/operations.js';
import type { PosthogProjectedIssueEvent } from '../ui/detail/issueEventProjection.js';

import {
    decodePosthogEvidenceCandidate,
    posthogEvidenceCandidateLabel,
} from './candidate.js';

export {
    POSTHOG_EVIDENCE_REFERENCE,
    createPosthogEvidenceCandidate,
} from './candidate.js';
export type { PosthogEvidenceCandidateInput } from './candidate.js';

/**
 * The event projection's maximum is deliberately much larger than one Composer
 * reference context. Eight frames per exception keeps a selected stack excerpt under
 * the public reference-result ceiling while preserving both app and non-app evidence.
 */
const MAX_EVIDENCE_FRAMES_PER_EXCEPTION = 8;

function unavailableEvidence(reason: string): PluginError {
    return new PluginError({
        code: 'posthog/evidence-unavailable',
        message: `The selected PostHog evidence is unavailable (${reason}).`,
    });
}

function frameLocation(
    frame: PosthogProjectedIssueEvent['exceptions'][number]['frames'][number],
): string | null {
    if (frame.source === undefined) return null;
    if (frame.line === undefined) return frame.source;
    return frame.column === undefined
        ? `${frame.source}:${String(frame.line)}`
        : `${frame.source}:${String(frame.line)}:${String(frame.column)}`;
}

function selectedEvidenceContext(event: PosthogProjectedIssueEvent): string {
    const lines = [posthogEvidenceCandidateLabel(event.uuid)];
    if (event.timestampMs !== undefined) {
        const occurredAt = new Date(event.timestampMs);
        if (!Number.isNaN(occurredAt.getTime())) lines.push(`Occurred: ${occurredAt.toISOString()}`);
    }
    if (event.url !== undefined) lines.push(`URL: ${event.url}`);
    for (const exception of event.exceptions) {
        const identity = exception.type === undefined
            ? 'Exception'
            : `Exception ${exception.type}`;
        lines.push(exception.value === undefined ? identity : `${identity}: ${exception.value}`);
        for (const frame of exception.frames.slice(0, MAX_EVIDENCE_FRAMES_PER_EXCEPTION)) {
            const location = frameLocation(frame);
            const label = frame.function ?? location ?? 'Unnamed frame';
            lines.push(location === null || location === label
                ? `  at ${label}`
                : `  at ${label} (${location})`);
        }
    }
    return lines.join('\n');
}

/** This provider is direct-disclosure-only; generic Composer search returns no rows. */
export async function searchPosthogEvidenceReferences(
    _query: string,
    _context: PluginInvocationContext,
): Promise<ComposerReferenceCandidatePageV1> {
    return [];
}

/**
 * Revalidates the selected event at dispatch through one exact, one-row provider read.
 * The candidate's selected absolute offset and UUID must both still agree: selection
 * bytes are never published into the message context.
 */
export async function resolvePosthogEvidenceReference(
    candidateId: string,
    context: PluginInvocationContext,
): Promise<ComposerReferenceResolutionV1> {
    const candidate = decodePosthogEvidenceCandidate(candidateId);
    if (candidate === null) throw unavailableEvidence('candidate-invalid');

    const origin = normalizePosthogApiOrigin(candidate.origin);
    if (!origin.ok) throw unavailableEvidence('origin-invalid');
    const client = createPosthogInvocationClient(context, {
        service: { pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_CONNECTED_ACCOUNT_PURPOSE },
        accountId: candidate.accountId,
    }, origin.origin);
    const read = await runPosthogBoundedInvocation(
        context,
        POSTHOG_MOUNTED_DETAIL_DEADLINE_MS,
        async (signal) => await readPosthogSampledIssueEvents(client, {
            teamRouteId: candidate.teamPathId,
            issueId: candidate.entryId,
            detailWindow: { from: candidate.from, to: candidate.to },
            limit: 1,
            offset: candidate.selectedOffset,
        }, { signal }),
    );
    if (!read.ok) throw unavailableEvidence(read.failure.kind);
    if (read.value.omittedRowCount !== 0 || read.value.events.length !== 1) {
        throw unavailableEvidence('event-count-mismatch');
    }
    const event = read.value.events[0];
    if (event === undefined || event.uuid !== candidate.selectedUuid) {
        throw unavailableEvidence('event-changed');
    }
    return Object.freeze({
        id: candidateId,
        label: posthogEvidenceCandidateLabel(candidate.selectedUuid),
        context: selectedEvidenceContext(event),
    });
}
