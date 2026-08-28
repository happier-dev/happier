import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import {
    TriageSourceEntryLocalRefV1Schema,
    type TriageEntryRefV1,
    type TriageSourceEntryLocalRefV1,
    type TriageSourceObservationV1,
} from '@happier-dev/triage-protocol/v1';

import type { ProjectedObservationV1 } from './projectedObservation.js';

/**
 * Qualification — turning one source-local observation into a canonical
 * projected observation.
 *
 * The aggregate validates only the public local-ref grammar and the declared
 * kind. The source owns the native configuration and has already validated the
 * native scope against the exact invoked configuration, so the aggregate never
 * reimplements provider-scope authorization.
 *
 * The local ref is then **discarded**. A record carrying both a qualified ref
 * and an inner local ref carries two identities that can disagree, which is
 * exactly the state the published contract exists to make unrepresentable.
 */

export type CorpusQualifiedObservationV1 = ProjectedObservationV1 & Readonly<{
    /** The one canonical identity, stamped by the aggregate. */
    entryRef: TriageEntryRefV1;
}>;

export type CorpusQualificationRejectionV1 =
    /** The local ref does not satisfy the published grammar. */
    | 'invalidLocalRef'
    /** The invoked source descriptor does not declare this kind. */
    | 'undeclaredKind'
    /**
     * An authoritative get returned a different entry than the one requested.
     * Treating that as a redirect would let a source result change the
     * aggregate's canonical identity after qualification.
     */
    | 'refMismatch';

export type CorpusQualificationResultV1 =
    | Readonly<{ status: 'qualified'; observation: CorpusQualifiedObservationV1 }>
    | Readonly<{ status: 'rejected'; reason: CorpusQualificationRejectionV1 }>;

/**
 * Qualifying one local ref on its own.
 *
 * The `merged` arm names a successor that is a whole second entry, and the one
 * durable effect of that observation addresses it by canonical ref. So the
 * caller that accepts a merge qualifies that successor through this exact
 * derivation rather than assembling a ref beside it — a second assembly would
 * be a second identity owner for the concept `CONTRACT.md` §4 keeps singular.
 */
export type CorpusQualifiedEntryRefResultV1 =
    | Readonly<{ status: 'qualified'; entryRef: TriageEntryRefV1 }>
    | Readonly<{ status: 'rejected'; reason: CorpusQualificationRejectionV1 }>;

export function qualifyEntryLocalRef(input: Readonly<{
    /** The invoked source contribution identity. A source never supplies it. */
    source: PluginContributionIdentity;
    /** The kinds the invoked source descriptor declares. */
    declaredKindIds: readonly string[];
    localRef: TriageSourceEntryLocalRefV1;
}>): CorpusQualifiedEntryRefResultV1 {
    const entryRef = qualifyLocalRef(input.source, new Set(input.declaredKindIds), input.localRef);
    return typeof entryRef === 'string'
        ? { status: 'rejected', reason: entryRef }
        : { status: 'qualified', entryRef };
}

function qualifyLocalRef(
    source: PluginContributionIdentity,
    declaredKindIds: ReadonlySet<string>,
    localRef: TriageSourceEntryLocalRefV1,
): TriageEntryRefV1 | CorpusQualificationRejectionV1 {
    const parsed = TriageSourceEntryLocalRefV1Schema.safeParse(localRef);
    if (!parsed.success) return 'invalidLocalRef';
    if (!declaredKindIds.has(parsed.data.kindId)) return 'undeclaredKind';
    return {
        source,
        // Consumed verbatim as the source returned them: not lowercased, not
        // trimmed, not zero-stripped, not reconstructed.
        kindId: parsed.data.kindId,
        collisionScope: parsed.data.collisionScope,
        entryId: parsed.data.entryId,
    };
}

function sameEntry(left: TriageEntryRefV1, right: TriageEntryRefV1): boolean {
    return left.source.pluginId === right.source.pluginId
        && left.source.localId === right.source.localId
        && left.kindId === right.kindId
        && left.collisionScope === right.collisionScope
        && left.entryId === right.entryId;
}

export function qualifySourceObservation(input: Readonly<{
    /** The invoked source contribution identity. A source never supplies it. */
    source: PluginContributionIdentity;
    /** The kinds the invoked source descriptor declares. */
    declaredKindIds: readonly string[];
    /** The stable configured-instance id this observation was made through. */
    sourceInstanceId: string;
    /** Our clock, stamped once for the whole observation. */
    observedAtMs: number;
    observation: TriageSourceObservationV1;
    /** Set only for an authoritative get: the exact ref that was requested. */
    requestedEntryRef?: TriageEntryRefV1;
}>): CorpusQualificationResultV1 {
    const declaredKindIds = new Set(input.declaredKindIds);
    const entryRef = qualifyLocalRef(input.source, declaredKindIds, input.observation.localRef);
    if (typeof entryRef === 'string') return { status: 'rejected', reason: entryRef };
    if (input.requestedEntryRef && !sameEntry(entryRef, input.requestedEntryRef)) {
        return { status: 'rejected', reason: 'refMismatch' };
    }

    const common = {
        entryRef,
        sourceInstanceId: input.sourceInstanceId,
        observedAtMs: input.observedAtMs,
    } as const;

    if (input.observation.kind === 'unresolved') {
        // An unresolved answer is a real outcome of this pass, not a silent gap:
        // it says the connection could not conclude, which is what keeps it out
        // of both the present and the absent fold.
        return {
            status: 'qualified',
            observation: { ...common, outcome: { kind: 'unresolved', failure: input.observation.failure } },
        };
    }

    if (input.observation.kind === 'merged') {
        const successor = qualifyLocalRef(input.source, declaredKindIds, input.observation.successor);
        if (typeof successor === 'string') return { status: 'rejected', reason: successor };
        return {
            status: 'qualified',
            observation: { ...common, outcome: { kind: 'merged', successor } },
        };
    }

    if (input.observation.kind === 'absent') {
        // No basis member: the operation that produced this observation is the
        // basis. Only an authoritative `get` may answer `absent` at all, so
        // restating it here would mint a second absence authority.
        return {
            status: 'qualified',
            observation: { ...common, outcome: { kind: 'absent' } },
        };
    }

    return {
        status: 'qualified',
        observation: {
            ...common,
            outcome: {
                kind: 'present',
                locator: input.observation.locator,
                snapshot: input.observation.snapshot,
                viewer: input.observation.viewer,
                ...(input.observation.sourceUpdatedAtMs === undefined
                    ? {}
                    : { sourceUpdatedAtMs: input.observation.sourceUpdatedAtMs }),
                ...(input.observation.nativeRevision === undefined
                    ? {}
                    : { nativeRevision: input.observation.nativeRevision }),
                // Carried exactly as the source declared it. The aggregate
                // never derives, normalizes or repairs a repository identity:
                // the whole point of the declared form is that both sides of
                // the launch-placement join are already resolved.
                ...(input.observation.repository === undefined
                    ? {}
                    : { repository: input.observation.repository }),
            },
        },
    };
}
