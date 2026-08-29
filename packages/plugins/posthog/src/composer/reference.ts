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
import { fitComposerReferenceResolutionPrefixV1 } from '@happier-dev/triage-sources/runtime';

import { createPosthogInvocationClient } from '../api/invocationClient.js';
import { normalizePosthogApiOrigin } from '../connect/origin.js';
import {
    POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
    POSTHOG_PLUGIN_ID,
} from '../posthogContracts.js';
import { readPosthogSampledIssueEvents } from '../source/detail/issueEvents.js';
import { runPosthogBoundedInvocation } from '../source/invocationDeadline.js';
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

type EvidenceChunkKind = 'field' | 'exception' | 'frame';

type EvidenceChunk = Readonly<{
    kind: EvidenceChunkKind;
    text: string;
}>;

function evidenceChunks(event: PosthogProjectedIssueEvent): readonly EvidenceChunk[] {
    const chunks: EvidenceChunk[] = [];
    if (event.timestampMs !== undefined) {
        const occurredAt = new Date(event.timestampMs);
        if (!Number.isNaN(occurredAt.getTime())) {
            chunks.push({ kind: 'field', text: `Occurred: ${occurredAt.toISOString()}` });
        }
    }
    if (event.url !== undefined) chunks.push({ kind: 'field', text: `URL: ${event.url}` });
    for (const exception of event.exceptions) {
        const identity = exception.type === undefined
            ? 'Exception'
            : `Exception ${exception.type}`;
        chunks.push({
            kind: 'exception',
            text: exception.value === undefined ? identity : `${identity}: ${exception.value}`,
        });
        for (const frame of exception.frames) {
            const location = frameLocation(frame);
            const label = frame.function ?? location ?? 'Unnamed frame';
            chunks.push({
                kind: 'frame',
                text: location === null || location === label
                    ? `  at ${label}`
                    : `  at ${label} (${location})`,
            });
        }
    }
    return chunks;
}

function selectedEvidenceContext(
    event: PosthogProjectedIssueEvent,
    selected: readonly EvidenceChunk[],
    all: readonly EvidenceChunk[],
): string {
    const lines = [posthogEvidenceCandidateLabel(event.uuid), ...selected.map((chunk) => chunk.text)];
    const selectedSet = new Set(selected);
    const omitted = (kind: EvidenceChunkKind): number => all.filter(
        (chunk) => chunk.kind === kind && !selectedSet.has(chunk),
    ).length;
    const counted = (count: number, noun: string): string => (
        `${String(count)} ${noun}${count === 1 ? '' : 's'}`
    );
    const omissions = [
        omitted('field') === 0 ? null : counted(omitted('field'), 'field'),
        omitted('exception') === 0 ? null : counted(omitted('exception'), 'exception'),
        omitted('frame') === 0 ? null : counted(omitted('frame'), 'frame'),
    ].filter((value): value is string => value !== null);
    if (omissions.length > 0) {
        lines.push(`Agent evidence omitted to fit Composer context: ${omissions.join(', ')}.`);
    }
    return lines.join('\n');
}

function selectedEvidenceResolution(
    candidateId: string,
    label: string,
    event: PosthogProjectedIssueEvent,
): ComposerReferenceResolutionV1 {
    const all = evidenceChunks(event);
    const fitted = fitComposerReferenceResolutionPrefixV1({
        identity: { id: candidateId, label },
        itemCount: all.length,
        contextForPrefix: (includedCount) => selectedEvidenceContext(
            event,
            all.slice(0, includedCount),
            all,
        ),
    });
    if (fitted === null) throw unavailableEvidence('evidence-contract-exceeded');
    return fitted;
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
        undefined,
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
    return selectedEvidenceResolution(
        candidateId,
        posthogEvidenceCandidateLabel(candidate.selectedUuid),
        event,
    );
}
