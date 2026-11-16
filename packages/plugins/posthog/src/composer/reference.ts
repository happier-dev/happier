/**
 * The daemon-side PostHog Composer-reference provider for selected Tier-B evidence.
 *
 * The UI-safe candidate codec is separate so a mounted detail can disclose an opaque
 * candidate without importing the account/HTTP runtime. This resolver never reads a
 * Composer, sees its origin ref, or mutates a draft; Triage retains all of that custody.
 */

import { isPosthogEnvironmentIncluded } from '../source/instance.js';
import {
    PluginError,
    type ComposerReferenceCandidatePageV1,
    type ComposerReferenceResolutionV1,
    type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import {
    fitComposerReferenceResolutionPrefixV1,
    readCurrentTriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-sources/runtime';

import { encodePosthogSampledEventsContinuation, PosthogSampledEventsResultV1Schema } from '../source/detail/issueEventsContract.js';
import { buildPosthogCollisionScope } from '../source/identity.js';
import { resolvePosthogInvocationScope } from '../source/invocationScope.js';
import { POSTHOG_ACTION_IDS, POSTHOG_PLUGIN_ID } from '../posthogContracts.js';
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

function unavailableEvidence(reason: string, retryable = false): PluginError {
    return new PluginError({
        code: 'posthog/evidence-unavailable',
        message: `The selected PostHog evidence is unavailable (${reason}).`,
        retryable,
        failureCause: { phase: 'composer_reference.resolve', errorClass: 'Error', errorCode: reason, httpStatus: null },
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

    const current = await readCurrentTriageConfiguredSourceInstanceV1({
        context,
        sourceInstanceId: candidate.sourceInstanceId,
        instanceDigest: candidate.instanceDigest,
    });
    if (current.kind === 'unavailable') throw unavailableEvidence('configured-source-unavailable');
    if (current.kind === 'changed') throw unavailableEvidence('configured-source-changed');
    const scope = resolvePosthogInvocationScope(current.instance);
    if (!scope.ok) throw unavailableEvidence('configured-source-invalid');
    if (!isPosthogEnvironmentIncluded(scope.configuration, candidate.teamUuid)) throw unavailableEvidence('configured-source-invalid');
    const collisionScope = buildPosthogCollisionScope(scope.origin, candidate.teamUuid);
    if (!collisionScope.ok) throw unavailableEvidence('configured-source-invalid');
    const continuation = encodePosthogSampledEventsContinuation({
        v: 1,
        from: candidate.from,
        to: candidate.to,
        offset: candidate.selectedOffset,
        limit: 1,
    });
    if (continuation === null) throw unavailableEvidence('evidence-contract-exceeded');
    const read = PosthogSampledEventsResultV1Schema.parse(await context.services.actions.execute({
        pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_ACTION_IDS.issueEvents,
    }, {
        v: 1,
        instance: current.instance,
        localRef: {
            kindId: 'error-issue',
            collisionScope: collisionScope.value,
            entryId: candidate.entryId,
        },
        limit: 1,
        continuation,
    }, { signal: context.signal }));
    if (read.kind !== 'sampled') throw unavailableEvidence(read.failure.code, read.failure.class === 'transient');
    if (read.omittedRowCount !== 0 || read.events.length !== 1) {
        throw unavailableEvidence('event-count-mismatch');
    }
    const event = read.events[0];
    if (event === undefined || event.uuid !== candidate.selectedUuid) {
        throw unavailableEvidence('event-changed');
    }
    return selectedEvidenceResolution(
        candidateId,
        posthogEvidenceCandidateLabel(candidate.selectedUuid),
        event,
    );
}
