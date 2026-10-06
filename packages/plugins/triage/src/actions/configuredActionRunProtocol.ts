import {
    defineProtocolArray, defineProtocolLiteral, defineProtocolObject,
    defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { TriageEntryRefV1Schema, TriageSourceInstanceIdV1Schema } from '@happier-dev/triage-protocol/v1';
import { TriageActionIdV1Schema, TriageActionRecordV1Schema } from '../settings/actions.js';
import { TriageStartEntrySessionInputV1Schema, TriageStartEntrySessionResultV1Schema, TriageStartEntrySessionSettledDraftV1Schema, TriagePullRequestReviewChoiceV1Schema, TriageStartPullRequestReviewResultV1Schema, TriagePullRequestReviewInstructionsV1Schema } from './entrySessionProtocol.js';

export const TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1 = 'sessions/run-configured-v1';

const text = defineProtocolString({ minLength: 1 });
const selectedEntry = defineProtocolObject({
    entryRef: TriageEntryRefV1Schema,
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
}, { policy: 'closed' });
const bulkDestination = defineProtocolUnion([
    defineProtocolLiteral('oneSessionForAllEntries'), defineProtocolLiteral('oneSessionPerEntry'),
]);
const entryOutcome = defineProtocolObject({
    entryRef: TriageEntryRefV1Schema,
    session: defineProtocolUnion([defineProtocolLiteral('notCreated'), defineProtocolLiteral('uncertain'), defineProtocolLiteral('existing'), defineProtocolLiteral('rejoined'), defineProtocolLiteral('created')]),
    attachment: defineProtocolUnion([defineProtocolLiteral('notRequested'), defineProtocolLiteral('refused'), defineProtocolLiteral('uncertain'), defineProtocolLiteral('carried')]),
    link: defineProtocolUnion([defineProtocolLiteral('notAttempted'), defineProtocolLiteral('conflictedOrUnavailable'), defineProtocolLiteral('created')]),
    newSessionSeed: defineProtocolUnion([defineProtocolLiteral('notRequested'), defineProtocolLiteral('refused'), defineProtocolLiteral('applied')]),
    directSend: defineProtocolUnion([defineProtocolLiteral('notRequested'), defineProtocolLiteral('refused'), defineProtocolLiteral('uncertain'), defineProtocolLiteral('applied')]),
}, { policy: 'closed' });
const unitIdentity = { creationKey: text, entryRefs: defineProtocolArray(TriageEntryRefV1Schema, { minItems: 1 }) };
const bulkResult = defineProtocolUnion([
    defineProtocolObject({ ...unitIdentity, status: defineProtocolLiteral('settled'),
        start: TriageStartEntrySessionResultV1Schema, entries: defineProtocolArray(entryOutcome) }, { policy: 'closed' }),
    defineProtocolObject({ ...unitIdentity, status: defineProtocolLiteral('unknownOutcome') }, { policy: 'closed' }),
    defineProtocolObject({ ...unitIdentity, status: defineProtocolLiteral('notStarted') }, { policy: 'closed' }),
]);
const refusal = defineProtocolObject({ entryRef: TriageEntryRefV1Schema, reason: text }, { policy: 'closed' });

/** Echoed controller custody, not a durable run or another Session creator. */
export const TriageConfiguredStartRecoveryV1Schema = defineProtocolObject({
    entries: defineProtocolArray(selectedEntry, { minItems: 1 }),
    state: defineProtocolUnion([
        defineProtocolObject({ kind: defineProtocolLiteral('single'), actionId: TriageActionIdV1Schema,
            input: TriageStartEntrySessionInputV1Schema, reviewInstructions: text.optional() }, { policy: 'closed' }),
        defineProtocolObject({ kind: defineProtocolLiteral('bulk'), action: TriageActionRecordV1Schema,
            destination: bulkDestination, promptText: text.nullable(),
            units: defineProtocolArray(defineProtocolObject({ result: bulkResult,
                input: TriageStartEntrySessionInputV1Schema }, { policy: 'closed' }), { minItems: 1 }),
            refusals: defineProtocolArray(refusal), unavailableKeys: defineProtocolArray(text),
        }, { policy: 'closed' }),
    ]),
}, { policy: 'closed' });
export type TriageConfiguredStartRecoveryV1 = ReturnType<typeof TriageConfiguredStartRecoveryV1Schema.parse>;

/** Exact entries and destinations; configuration remains with the catalog CAS owner. */
export const TriageRunConfiguredActionInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    actionId: TriageActionIdV1Schema,
    entries: defineProtocolArray(selectedEntry, { minItems: 1 }),
    destination: defineProtocolUnion([
        defineProtocolLiteral('single'), defineProtocolLiteral('oneSessionForAllEntries'),
        defineProtocolLiteral('oneSessionPerEntry'), defineProtocolLiteral('attachAllToNewSession'),
    ]),
    /** Shared destination uses one draft; per-entry destinations carry drafts in entry order. */
    drafts: defineProtocolArray(TriageStartEntrySessionSettledDraftV1Schema).optional(),
    /** Explicit engines and optional canonical launch selection for formal Review. */
    reviewChoices: TriagePullRequestReviewChoiceV1Schema.optional(),
    /** Echo recovery from an incomplete start; repeats only its retained identities. */
    resumeStart: TriageConfiguredStartRecoveryV1Schema.optional(),
    /** Echo a prepared result to continue only Review; never rerun Session creation. */
    resumeReview: defineProtocolObject({
        result: TriageStartEntrySessionResultV1Schema,
        instructions: TriagePullRequestReviewInstructionsV1Schema,
    }, { policy: 'closed' }).optional(),
}, { policy: 'closed' });
export type TriageRunConfiguredActionInputV1 = ReturnType<typeof TriageRunConfiguredActionInputV1Schema.parse>;

export const TriageRunConfiguredActionResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    status: defineProtocolUnion([
        defineProtocolLiteral('single'), defineProtocolLiteral('bulk'),
        defineProtocolLiteral('seeded'), defineProtocolLiteral('cancelled'), defineProtocolLiteral('unavailable'),
        defineProtocolLiteral('awaitingReview'), defineProtocolLiteral('reviewStarted'), defineProtocolLiteral('reviewPartial'),
        defineProtocolLiteral('reviewRefused'), defineProtocolLiteral('reviewUnknown'),
    ]),
    reason: text.optional(),
    result: TriageStartEntrySessionResultV1Schema.optional(),
    recovery: TriageConfiguredStartRecoveryV1Schema.optional(),
    /** Formal review keeps its configured instruction beside the incumbent review context. */
    reviewInstructions: text.optional(),
    reviewResult: TriageStartPullRequestReviewResultV1Schema.optional(),
    sessionOpen: defineProtocolUnion([defineProtocolLiteral('opened'), defineProtocolLiteral('failed')]).optional(),
    results: defineProtocolArray(bulkResult).optional(),
    entries: defineProtocolArray(entryOutcome).optional(),
    refusals: defineProtocolArray(refusal).optional(),
    unavailableKeys: defineProtocolArray(text).optional(),
}, { policy: 'closed' });
export type TriageRunConfiguredActionResultV1 = ReturnType<typeof TriageRunConfiguredActionResultV1Schema.parse>;
