import {
    defineProtocolArray, defineProtocolLiteral, defineProtocolObject,
    defineProtocolString, defineProtocolUnion,
    type ProtocolComposableSchema, type ProtocolSchemaInput, type ProtocolSchemaOutput,
} from '@happier-dev/plugin-sdk/protocol';
import { TriageEntryRefV1Schema, TriageSourceInstanceIdV1Schema, TriageSessionHandoffInputV1Schema, TriageSessionHandoffResultV1Schema, TriageConfiguredEntryExecutionStatusV1Schema } from '@happier-dev/triage-protocol/v1';
import { ScmComparisonSourceProtocolSchema } from '@happier-dev/plugin-sdk/scm';
import { TriageActionIdV1Schema, TriageActionRecordV1Schema } from '../settings/actions.js';
import { TriageStartEntrySessionInputV1Schema, TriageStartEntrySessionResultV1Schema, TriageStartEntrySessionSettledDraftV1Schema, TriagePullRequestReviewChoiceV1Schema, TriageStartPullRequestReviewResultV1Schema, TriagePullRequestReviewInstructionsV1Schema, TriageStartEntrySessionDestinationV1Schema, TriageStartEntrySessionDeliveryV1Schema, TriageStartEntrySessionResumeV1Schema } from './entrySessionProtocol.js';
import { TriageEntrySessionLinkDisplayV1Schema } from './sessionLinksProtocol.js';
import { TriageNewSessionFailureV1Schema } from '../ui/header/newSessionSeedCommand.js';
import { TriageWorkspaceModeV1Schema } from '../sessions/entrySessionWorkspace.js';

export const TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1 = 'sessions/run-configured-v1';

const text = defineProtocolString({ minLength: 1 });
const selectedEntry = defineProtocolObject({
    entryRef: TriageEntryRefV1Schema,
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
}, { policy: 'closed' });
const bulkDestination = defineProtocolUnion([
    defineProtocolLiteral('oneSessionForAllEntries'), defineProtocolLiteral('oneSessionPerEntry'),
]);
export const TriageBulkEntryOutcomeV1Schema = defineProtocolObject({
    entryRef: TriageEntryRefV1Schema,
    session: defineProtocolUnion([defineProtocolLiteral('notCreated'), defineProtocolLiteral('uncertain'), defineProtocolLiteral('existing'), defineProtocolLiteral('rejoined'), defineProtocolLiteral('created')]),
    attachment: defineProtocolUnion([defineProtocolLiteral('notRequested'), defineProtocolLiteral('refused'), defineProtocolLiteral('uncertain'), defineProtocolLiteral('carried')]),
    link: defineProtocolUnion([defineProtocolLiteral('notAttempted'), defineProtocolLiteral('conflictedOrUnavailable'), defineProtocolLiteral('created')]),
    newSessionSeed: defineProtocolUnion([defineProtocolLiteral('notRequested'), defineProtocolLiteral('refused'), defineProtocolLiteral('applied')]),
    directSend: defineProtocolUnion([defineProtocolLiteral('notRequested'), defineProtocolLiteral('refused'), defineProtocolLiteral('uncertain'), defineProtocolLiteral('applied')]),
}, { policy: 'closed' });
const entryOutcome = TriageBulkEntryOutcomeV1Schema;
const unitIdentity = { creationKey: text, entryRefs: defineProtocolArray(TriageEntryRefV1Schema, { minItems: 1 }) };
const bulkResult = defineProtocolUnion([
    defineProtocolObject({ ...unitIdentity, status: defineProtocolLiteral('settled'),
        start: TriageStartEntrySessionResultV1Schema, entries: defineProtocolArray(entryOutcome) }, { policy: 'closed' }),
    defineProtocolObject({ ...unitIdentity, status: defineProtocolLiteral('unknownOutcome') }, { policy: 'closed' }),
    defineProtocolObject({ ...unitIdentity, status: defineProtocolLiteral('notStarted') }, { policy: 'closed' }),
]);
const refusal = defineProtocolObject({ entryRef: TriageEntryRefV1Schema, reason: text }, { policy: 'closed' });

export interface TriageConfiguredRecoveryActionAuthoredV1 extends ProtocolSchemaInput<typeof TriageActionRecordV1Schema> {}
export interface TriageConfiguredRecoveryActionV1 extends ProtocolSchemaOutput<typeof TriageActionRecordV1Schema> {}
const recoveryAction: ProtocolComposableSchema<Readonly<TriageConfiguredRecoveryActionAuthoredV1>, Readonly<TriageConfiguredRecoveryActionV1>> = TriageActionRecordV1Schema;

/** Echoed controller custody, not a durable run or another Session creator. */
export const TriageLegacyConfiguredStartRecoveryV1Schema = defineProtocolObject({
    entries: defineProtocolArray(selectedEntry, { minItems: 1 }),
    /** Original operand binds a continuation to the same configured request. */
    handoff: TriageSessionHandoffInputV1Schema.optional(),
    state: defineProtocolUnion([
        defineProtocolObject({ kind: defineProtocolLiteral('single'), actionId: TriageActionIdV1Schema,
            input: TriageStartEntrySessionInputV1Schema, reviewInstructions: text.optional() }, { policy: 'closed' }),
        defineProtocolObject({ kind: defineProtocolLiteral('bulk'), action: recoveryAction,
            destination: bulkDestination, promptText: text.nullable(),
            units: defineProtocolArray(defineProtocolObject({ result: bulkResult,
                input: TriageStartEntrySessionInputV1Schema }, { policy: 'closed' }), { minItems: 1 }),
            refusals: defineProtocolArray(refusal), unavailableKeys: defineProtocolArray(text),
        }, { policy: 'closed' }),
    ]),
}, { policy: 'closed' });
export type TriageLegacyConfiguredStartRecoveryV1 = ReturnType<typeof TriageLegacyConfiguredStartRecoveryV1Schema.parse>;

const handoffStartInputMembers = {
    workspaceMode: TriageWorkspaceModeV1Schema,
    entryRef: TriageEntryRefV1Schema.optional(), display: TriageEntrySessionLinkDisplayV1Schema.optional(),
    destination: TriageStartEntrySessionDestinationV1Schema, delivery: TriageStartEntrySessionDeliveryV1Schema,
};
type HandoffStartInputSchema = ReturnType<typeof defineProtocolObject<typeof handoffStartInputMembers, { readonly policy: 'closed' }>>;
export interface TriageHandoffStartAuthoredInputV1 extends ProtocolSchemaInput<HandoffStartInputSchema> {}
export interface TriageHandoffStartInputV1 extends ProtocolSchemaOutput<HandoffStartInputSchema> {}
const handoffStartInput: ProtocolComposableSchema<Readonly<TriageHandoffStartAuthoredInputV1>, Readonly<TriageHandoffStartInputV1>> =
    defineProtocolObject(handoffStartInputMembers, { policy: 'closed' });

/** Incumbent controller custody for a request whose subject need not be an entry. */
export const TriageSessionDeliveryFailureDetailV1Schema = defineProtocolObject({
    step: defineProtocolUnion([defineProtocolLiteral('buildInput'), defineProtocolLiteral('admitAttachment'),
        defineProtocolLiteral('dispatch'), defineProtocolLiteral('awaitAck')]),
    errorClass: text.nullable(), errorCode: text.nullable(),
}, { policy: 'closed' });
export type TriageSessionDeliveryFailureDetailV1 = ReturnType<typeof TriageSessionDeliveryFailureDetailV1Schema.parse>;

const handoffRecovery = defineProtocolObject({
    entries: defineProtocolArray(selectedEntry),
    state: defineProtocolObject({
        kind: defineProtocolLiteral('handoff'), handoff: TriageSessionHandoffInputV1Schema, serverId: text,
        input: handoffStartInput,
        pending: TriageStartEntrySessionResumeV1Schema.optional(),
        uncertainPhase: defineProtocolUnion([defineProtocolLiteral('create'), defineProtocolLiteral('link'), defineProtocolLiteral('send')]).optional(),
        detail: TriageSessionDeliveryFailureDetailV1Schema.optional(),
    }, { policy: 'closed' }),
}, { policy: 'closed' });
export const TriageConfiguredStartRecoveryV1Schema = defineProtocolUnion([TriageLegacyConfiguredStartRecoveryV1Schema, handoffRecovery]);
export type TriageConfiguredStartRecoveryV1 = ReturnType<typeof TriageConfiguredStartRecoveryV1Schema.parse>;
export type TriageHandoffStartRecoveryV1 = ReturnType<typeof handoffRecovery.parse>;

/** Existing single-entry gestures, consumed by the same Session owner as configured starts. */
const singleIntent = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('configured'),
        launchMode: defineProtocolUnion([defineProtocolLiteral('start'), defineProtocolLiteral('review')]),
        comparisonSource: ScmComparisonSourceProtocolSchema.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('orchestrate'), prompt: text }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('comparison'), comparison: ScmComparisonSourceProtocolSchema }, { policy: 'closed' }),
]);

/** One public operand; exact entry destinations delegate to the incumbent controllers. */
type ConfiguredReviewResumeSchema = ReturnType<typeof defineProtocolObject<{
    result: typeof TriageStartEntrySessionResultV1Schema;
    instructions: typeof TriagePullRequestReviewInstructionsV1Schema;
}, { readonly policy: 'closed' }>>;
type ConfiguredActionInputMembers = {
    v: ReturnType<typeof defineProtocolLiteral<1>>;
    handoff: typeof TriageSessionHandoffInputV1Schema;
    singleIntent: ReturnType<typeof singleIntent.optional>;
    drafts: ReturnType<ReturnType<typeof defineProtocolArray<typeof TriageStartEntrySessionSettledDraftV1Schema>>['optional']>;
    reviewChoices: ReturnType<typeof TriagePullRequestReviewChoiceV1Schema.optional>;
    resumeStart: ReturnType<typeof TriageConfiguredStartRecoveryV1Schema.optional>;
    resumeReview: ReturnType<ConfiguredReviewResumeSchema['optional']>;
};
type ConfiguredActionInputSchema = ReturnType<typeof defineProtocolObject<ConfiguredActionInputMembers, { readonly policy: 'closed' }>>;
export const TriageRunConfiguredActionInputV1Schema: ConfiguredActionInputSchema = defineProtocolObject({
    v: defineProtocolLiteral(1), handoff: TriageSessionHandoffInputV1Schema,
    singleIntent: singleIntent.optional(),
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

type ConfiguredEntryResultMembers = {
    reason: ReturnType<typeof text.optional>;
    failure: ReturnType<typeof TriageNewSessionFailureV1Schema.optional>;
    result: ReturnType<typeof TriageStartEntrySessionResultV1Schema.optional>;
    reviewInstructions: ReturnType<typeof text.optional>;
    reviewResult: ReturnType<typeof TriageStartPullRequestReviewResultV1Schema.optional>;
    sessionOpen: ReturnType<ReturnType<typeof defineProtocolUnion<readonly [
        ReturnType<typeof defineProtocolLiteral<'opened'>>, ReturnType<typeof defineProtocolLiteral<'failed'>>
    ]>>['optional']>;
    results: ReturnType<ReturnType<typeof defineProtocolArray<typeof bulkResult>>['optional']>;
    entries: ReturnType<ReturnType<typeof defineProtocolArray<typeof entryOutcome>>['optional']>;
    refusals: ReturnType<ReturnType<typeof defineProtocolArray<typeof refusal>>['optional']>;
    unavailableKeys: ReturnType<ReturnType<typeof defineProtocolArray<typeof text>>['optional']>;
};
const configuredEntryResultMembers: ConfiguredEntryResultMembers = {
    reason: text.optional(),
    failure: TriageNewSessionFailureV1Schema.optional(),
    result: TriageStartEntrySessionResultV1Schema.optional(),
    /** Formal review keeps its configured instruction beside the incumbent review context. */
    reviewInstructions: text.optional(),
    reviewResult: TriageStartPullRequestReviewResultV1Schema.optional(),
    sessionOpen: defineProtocolUnion([defineProtocolLiteral('opened'), defineProtocolLiteral('failed')]).optional(),
    results: defineProtocolArray(bulkResult).optional(),
    entries: defineProtocolArray(entryOutcome).optional(),
    refusals: defineProtocolArray(refusal).optional(),
    unavailableKeys: defineProtocolArray(text).optional(),
};
/** Internal controller projection; never accepted as the public Action envelope. */
type LegacyConfiguredActionResultMembers = typeof configuredEntryResultMembers & {
    v: ReturnType<typeof defineProtocolLiteral<1>>;
    status: typeof TriageConfiguredEntryExecutionStatusV1Schema;
    recovery: ReturnType<typeof TriageLegacyConfiguredStartRecoveryV1Schema.optional>;
};
const legacyConfiguredActionResultMembers: LegacyConfiguredActionResultMembers = {
    v: defineProtocolLiteral(1), status: TriageConfiguredEntryExecutionStatusV1Schema,
    ...configuredEntryResultMembers, recovery: TriageLegacyConfiguredStartRecoveryV1Schema.optional(),
};
type LegacyConfiguredActionResultSchema = ReturnType<typeof defineProtocolObject<typeof legacyConfiguredActionResultMembers, { readonly policy: 'closed' }>>;
interface TriageLegacyRunConfiguredActionResultV1Authored extends ProtocolSchemaInput<LegacyConfiguredActionResultSchema> {}
export interface TriageLegacyRunConfiguredActionResultV1 extends ProtocolSchemaOutput<LegacyConfiguredActionResultSchema> {}
export const TriageLegacyRunConfiguredActionResultV1Schema: ProtocolComposableSchema<Readonly<TriageLegacyRunConfiguredActionResultV1Authored>, Readonly<TriageLegacyRunConfiguredActionResultV1>> =
    defineProtocolObject(legacyConfiguredActionResultMembers, { policy: 'closed' });
type HandoffConfiguredActionResultMembers = typeof configuredEntryResultMembers & {
    v: ReturnType<typeof defineProtocolLiteral<1>>;
    handoff: typeof TriageSessionHandoffResultV1Schema;
    status: ReturnType<typeof TriageConfiguredEntryExecutionStatusV1Schema.optional>;
    recovery: ReturnType<typeof TriageConfiguredStartRecoveryV1Schema.optional>;
};
const handoffConfiguredActionResultMembers: HandoffConfiguredActionResultMembers = {
    v: defineProtocolLiteral(1), handoff: TriageSessionHandoffResultV1Schema,
    status: TriageConfiguredEntryExecutionStatusV1Schema.optional(), ...configuredEntryResultMembers,
    recovery: TriageConfiguredStartRecoveryV1Schema.optional(),
};
type HandoffConfiguredActionResultSchema = ReturnType<typeof defineProtocolObject<typeof handoffConfiguredActionResultMembers, { readonly policy: 'closed' }>>;
interface TriageHandoffRunConfiguredActionResultV1Authored extends ProtocolSchemaInput<HandoffConfiguredActionResultSchema> {}
export interface TriageHandoffRunConfiguredActionResultV1 extends ProtocolSchemaOutput<HandoffConfiguredActionResultSchema> {}
export const TriageHandoffRunConfiguredActionResultV1Schema: ProtocolComposableSchema<Readonly<TriageHandoffRunConfiguredActionResultV1Authored>, Readonly<TriageHandoffRunConfiguredActionResultV1>> =
    defineProtocolObject(handoffConfiguredActionResultMembers, { policy: 'closed' });
export const TriageRunConfiguredActionResultV1Schema: typeof TriageHandoffRunConfiguredActionResultV1Schema = TriageHandoffRunConfiguredActionResultV1Schema;
export type TriageRunConfiguredActionResultV1 = ReturnType<typeof TriageRunConfiguredActionResultV1Schema.parse>;
