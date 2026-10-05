import {
    defineProtocolArray, defineProtocolLiteral, defineProtocolObject,
    defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { TriageEntryRefV1Schema, TriageSourceInstanceIdV1Schema } from '@happier-dev/triage-protocol/v1';
import { TriageActionIdV1Schema } from '../settings/actions.js';
import { TriageStartEntrySessionResultV1Schema, TriageStartEntrySessionSettledDraftV1Schema, TriagePullRequestReviewChoiceV1Schema, TriageStartPullRequestReviewResultV1Schema, TriagePullRequestReviewInstructionsV1Schema } from './entrySessionProtocol.js';

export const TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1 = 'sessions/run-configured-v1';

/** Exact entries and destinations; configuration remains with the catalog CAS owner. */
export const TriageRunConfiguredActionInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    actionId: TriageActionIdV1Schema,
    entries: defineProtocolArray(defineProtocolObject({
        entryRef: TriageEntryRefV1Schema,
        sourceInstanceId: TriageSourceInstanceIdV1Schema,
    }, { policy: 'closed' }), { minItems: 1 }),
    destination: defineProtocolUnion([
        defineProtocolLiteral('single'), defineProtocolLiteral('oneSessionForAllEntries'),
        defineProtocolLiteral('oneSessionPerEntry'), defineProtocolLiteral('attachAllToNewSession'),
    ]),
    /** Shared destination uses one draft; per-entry destinations carry drafts in entry order. */
    drafts: defineProtocolArray(TriageStartEntrySessionSettledDraftV1Schema).optional(),
    /** Explicit engines and optional canonical launch selection for formal Review. */
    reviewChoices: TriagePullRequestReviewChoiceV1Schema.optional(),
    /** Echo a prepared result to continue only Review; never rerun Session creation. */
    resumeReview: defineProtocolObject({
        result: TriageStartEntrySessionResultV1Schema,
        instructions: TriagePullRequestReviewInstructionsV1Schema,
    }, { policy: 'closed' }).optional(),
}, { policy: 'closed' });
export type TriageRunConfiguredActionInputV1 = ReturnType<typeof TriageRunConfiguredActionInputV1Schema.parse>;

const text = defineProtocolString({ minLength: 1 });
const entryOutcome = defineProtocolObject({
    entryRef: TriageEntryRefV1Schema,
    session: defineProtocolUnion([defineProtocolLiteral('notCreated'), defineProtocolLiteral('uncertain'), defineProtocolLiteral('existing'), defineProtocolLiteral('rejoined'), defineProtocolLiteral('created')]),
    attachment: defineProtocolUnion([defineProtocolLiteral('notRequested'), defineProtocolLiteral('refused'), defineProtocolLiteral('uncertain'), defineProtocolLiteral('carried')]),
    link: defineProtocolUnion([defineProtocolLiteral('notAttempted'), defineProtocolLiteral('conflictedOrUnavailable'), defineProtocolLiteral('created')]),
    newSessionSeed: defineProtocolUnion([defineProtocolLiteral('notRequested'), defineProtocolLiteral('refused'), defineProtocolLiteral('applied')]),
    directSend: defineProtocolUnion([defineProtocolLiteral('notRequested'), defineProtocolLiteral('refused'), defineProtocolLiteral('uncertain'), defineProtocolLiteral('applied')]),
}, { policy: 'closed' });

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
    /** Formal review keeps its configured instruction beside the incumbent review context. */
    reviewInstructions: text.optional(),
    reviewResult: TriageStartPullRequestReviewResultV1Schema.optional(),
    sessionOpen: defineProtocolUnion([defineProtocolLiteral('opened'), defineProtocolLiteral('failed')]).optional(),
    results: defineProtocolArray(defineProtocolObject({
        creationKey: text,
        entryRefs: defineProtocolArray(TriageEntryRefV1Schema),
        status: defineProtocolUnion([defineProtocolLiteral('settled'), defineProtocolLiteral('unknownOutcome'), defineProtocolLiteral('notStarted')]),
        start: TriageStartEntrySessionResultV1Schema.optional(),
        entries: defineProtocolArray(entryOutcome).optional(),
    }, { policy: 'closed' })).optional(),
    entries: defineProtocolArray(entryOutcome).optional(),
    refusals: defineProtocolArray(defineProtocolObject({ entryRef: TriageEntryRefV1Schema, reason: text }, { policy: 'closed' })).optional(),
    unavailableKeys: defineProtocolArray(text).optional(),
}, { policy: 'closed' });
export type TriageRunConfiguredActionResultV1 = ReturnType<typeof TriageRunConfiguredActionResultV1Schema.parse>;
