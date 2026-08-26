/**
 * The UI-safe opaque identity codec for one selected PostHog occurrence.
 *
 * This is intentionally separate from the daemon resolver: mounted React Native
 * surfaces need to mint a candidate, but they must not import an account materializer,
 * HTTP client, or Composer resolver. Both runtimes consume this one codec so the
 * selected absolute offset cannot drift between disclosure and dispatch.
 */

import { ComposerReferenceCandidateIdV1Schema } from '@happier-dev/plugin-sdk';
import type {
    TriageConfiguredSourceInstanceV1,
    TriageSourceEntryLocalRefV1,
} from '@happier-dev/triage-protocol/v1';
import type { TriageEvidenceCandidateV1 } from '@happier-dev/triage-sources/ui';

import {
    isPosthogIssueEventsInclude,
    POSTHOG_ISSUE_EVENTS_INCLUDE,
    POSTHOG_ISSUE_EVENTS_MAX_LIMIT,
} from '../api/types/events.js';
import { normalizePosthogApiOrigin } from '../connect/origin.js';
import {
    POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
    POSTHOG_EVIDENCE_REFERENCE_ID,
    POSTHOG_PLUGIN_ID,
} from '../posthogContracts.js';
import { parsePosthogCollisionScope } from '../source/identity.js';
import { resolvePosthogInvocationScope } from '../source/invocationScope.js';
import type { PosthogFrozenIssueEventsRequestV1 } from '../source/detail/issueEventsContract.js';
import type { PosthogProjectedIssueEvent } from '../ui/detail/issueEventProjection.js';

const UUID_PATTERN
    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CANDIDATE_PREFIX = 'ph1';
const CANDIDATE_SEPARATOR = '|';
/** Compact name for the fixed filters the canonical issue-events builder applies. */
const FROZEN_QUERY_PROFILE = 'q1';

export const POSTHOG_EVIDENCE_REFERENCE = Object.freeze({
    pluginId: POSTHOG_PLUGIN_ID,
    localId: POSTHOG_EVIDENCE_REFERENCE_ID,
});

export type DecodedPosthogEvidenceCandidate = Readonly<{
    sourceInstanceId: string;
    accountId: string;
    origin: string;
    teamPathId: number;
    teamUuid: string;
    entryId: string;
    from: string;
    to: string | null;
    filterTestAccounts: false;
    onlyAppFrames: false;
    include: typeof POSTHOG_ISSUE_EVENTS_INCLUDE;
    originalLimit: number;
    frozenOffset: number;
    selectedOffset: number;
    selectedUuid: string;
}>;

export type PosthogEvidenceCandidateInput = Readonly<{
    instance: TriageConfiguredSourceInstanceV1;
    localRef: TriageSourceEntryLocalRefV1;
    selected: PosthogProjectedIssueEvent;
    frozenRequest: PosthogFrozenIssueEventsRequestV1;
    /** The selected row's absolute provider offset within its frozen sample page. */
    selectedAbsoluteOffset: number;
}>;

function isUuid(value: string): boolean {
    return UUID_PATTERN.test(value);
}

function isPositiveInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

/** Escapes only the separator and escape marker, preserving the tight public ID budget. */
function encodePart(value: string): string {
    return value.replaceAll('%', '%25').replaceAll(CANDIDATE_SEPARATOR, '%7C');
}

function decodePart(value: string): string | null {
    let decoded = '';
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char !== '%') {
            decoded += char;
            continue;
        }
        const escaped = value.slice(index, index + 3);
        if (escaped === '%25') {
            decoded += '%';
            index += 2;
            continue;
        }
        if (escaped === '%7C') {
            decoded += CANDIDATE_SEPARATOR;
            index += 2;
            continue;
        }
        return null;
    }
    return decoded;
}

/** A candidate contains no response bytes; the UUID is revalidated at dispatch. */
export function posthogEvidenceCandidateLabel(uuid: string): string {
    return `PostHog occurrence ${uuid}`;
}

function encodeCandidate(value: DecodedPosthogEvidenceCandidate): string | null {
    if (!isPosthogIssueEventsInclude(value.include)
        || value.filterTestAccounts !== false
        || value.onlyAppFrames !== false) {
        return null;
    }
    const id = [
        CANDIDATE_PREFIX,
        value.sourceInstanceId,
        value.accountId,
        value.origin,
        String(value.teamPathId),
        value.teamUuid,
        value.entryId,
        value.from,
        value.to ?? '',
        FROZEN_QUERY_PROFILE,
        String(value.originalLimit),
        String(value.frozenOffset),
        String(value.selectedOffset),
        value.selectedUuid,
    ].map(encodePart).join(CANDIDATE_SEPARATOR);
    return ComposerReferenceCandidateIdV1Schema.safeParse(id).success ? id : null;
}

export function decodePosthogEvidenceCandidate(
    candidateId: string,
): DecodedPosthogEvidenceCandidate | null {
    if (!ComposerReferenceCandidateIdV1Schema.safeParse(candidateId).success) return null;
    const parts: string[] = [];
    for (const encoded of candidateId.split(CANDIDATE_SEPARATOR)) {
        const part = decodePart(encoded);
        if (part === null) return null;
        parts.push(part);
    }
    if (parts.length !== 14) return null;
    const [
        prefix = '',
        sourceInstanceId = '',
        accountId = '',
        originRaw = '',
        teamPathIdRaw = '',
        teamUuid = '',
        entryId = '',
        from = '',
        toRaw = '',
        frozenQueryProfile = '',
        originalLimitRaw = '',
        frozenOffsetRaw = '',
        selectedOffsetRaw = '',
        selectedUuid = '',
    ] = parts;
    if (prefix !== CANDIDATE_PREFIX) return null;
    const teamPathId = Number(teamPathIdRaw);
    const originalLimit = Number(originalLimitRaw);
    const frozenOffset = Number(frozenOffsetRaw);
    const selectedOffset = Number(selectedOffsetRaw);
    const origin = normalizePosthogApiOrigin(originRaw);
    if (
        !isUuid(sourceInstanceId)
        || accountId.length === 0
        || !origin.ok
        || origin.origin !== originRaw
        || !isPositiveInteger(teamPathId)
        || !isUuid(teamUuid)
        || !isUuid(entryId)
        || from.length === 0
        || frozenQueryProfile !== FROZEN_QUERY_PROFILE
        || !isPositiveInteger(originalLimit)
        || originalLimit > POSTHOG_ISSUE_EVENTS_MAX_LIMIT
        || !isNonNegativeInteger(frozenOffset)
        || !isNonNegativeInteger(selectedOffset)
        || selectedOffset < frozenOffset
        || selectedOffset - frozenOffset >= originalLimit
        || !isUuid(selectedUuid)
    ) return null;
    return Object.freeze({
        sourceInstanceId,
        accountId,
        origin: origin.origin,
        teamPathId,
        teamUuid,
        entryId,
        from,
        to: toRaw.length === 0 ? null : toRaw,
        filterTestAccounts: false,
        onlyAppFrames: false,
        include: POSTHOG_ISSUE_EVENTS_INCLUDE,
        originalLimit,
        frozenOffset,
        selectedOffset,
        selectedUuid,
    });
}

/**
 * Mints the one opaque candidate a mounted source detail may disclose to Triage.
 * It carries no draft, response bytes, configuration token, or Composer authority.
 */
export function createPosthogEvidenceCandidate(
    input: PosthogEvidenceCandidateInput,
): TriageEvidenceCandidateV1 | null {
    const scope = resolvePosthogInvocationScope(input.instance);
    if (!scope.ok
        || input.instance.binding.purpose !== POSTHOG_CONNECTED_ACCOUNT_PURPOSE
        || input.instance.binding.account.service.pluginId !== POSTHOG_PLUGIN_ID
        || input.instance.binding.account.service.localId !== POSTHOG_CONNECTED_ACCOUNT_PURPOSE
        || !isUuid(input.instance.instance.sourceInstanceId)
        || input.localRef.kindId !== 'error-issue'
        || !isUuid(input.localRef.entryId)
        || !isUuid(input.selected.uuid)
        || input.frozenRequest.v !== 1
        || input.frozenRequest.issueId !== input.localRef.entryId
        || input.frozenRequest.from.length === 0
        || (input.frozenRequest.to !== null && input.frozenRequest.to.length === 0)
        || input.frozenRequest.filterTestAccounts !== false
        || input.frozenRequest.onlyAppFrames !== false
        || !isPosthogIssueEventsInclude(input.frozenRequest.include)
        || !isPositiveInteger(input.frozenRequest.limit)
        || input.frozenRequest.limit > POSTHOG_ISSUE_EVENTS_MAX_LIMIT
        || !isNonNegativeInteger(input.frozenRequest.offset)
        || !isNonNegativeInteger(input.selectedAbsoluteOffset)
        || input.selectedAbsoluteOffset < input.frozenRequest.offset
        || input.selectedAbsoluteOffset - input.frozenRequest.offset >= input.frozenRequest.limit) {
        return null;
    }
    const localScope = parsePosthogCollisionScope(input.localRef.collisionScope);
    if (localScope === null || localScope.origin !== (scope.origin as string)) return null;
    const environment = scope.configuration.environments.find((candidate) => (
        candidate.teamUuid === localScope.teamUuid
    ));
    if (environment === undefined) return null;

    const id = encodeCandidate({
        sourceInstanceId: input.instance.instance.sourceInstanceId,
        accountId: input.instance.binding.account.accountId,
        origin: scope.origin as string,
        teamPathId: environment.teamPathId,
        teamUuid: environment.teamUuid,
        entryId: input.localRef.entryId,
        from: input.frozenRequest.from,
        to: input.frozenRequest.to,
        filterTestAccounts: input.frozenRequest.filterTestAccounts,
        onlyAppFrames: input.frozenRequest.onlyAppFrames,
        include: POSTHOG_ISSUE_EVENTS_INCLUDE,
        originalLimit: input.frozenRequest.limit,
        frozenOffset: input.frozenRequest.offset,
        selectedOffset: input.selectedAbsoluteOffset,
        selectedUuid: input.selected.uuid,
    });
    if (id === null) return null;
    return Object.freeze({
        reference: POSTHOG_EVIDENCE_REFERENCE,
        candidate: Object.freeze({ id, label: posthogEvidenceCandidateLabel(input.selected.uuid) }),
    });
}
