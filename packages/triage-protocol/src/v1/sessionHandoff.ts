import {
    defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString,
    defineProtocolUnion, defineProtocolUniqueArray,
    ProtocolWorkspaceAddressV1Schema, ProjectExecutionOperationRefV1ProtocolSchema,
    ProtocolLaunchProfileIdV2Schema, ScmHostingRepositoryIdentityV1ProtocolSchema,
    ProtocolServiceHealthNoticeSourceV1Schema, ProtocolServiceHealthNoticePageV1Schema,
    ProtocolServiceHealthNoticeMachineV1Schema,
    type ProtocolComposableSchema, type ProtocolSchemaInput, type ProtocolSchemaOutput,
} from '@happier-dev/plugin-sdk/protocol';
import {
    ActionSessionAddressV1Schema, SessionMessageSendResultV1ProtocolSchema, SessionTargetV1Schema,
} from '@happier-dev/plugin-sdk/sessions';
import { AgentTargetKeyV2Schema } from '@happier-dev/plugin-sdk/agents';
import { ForgeCiFailureSummaryV1Schema } from '../ci/v1/failureSummary.js';
import { ForgeReleaseNotesContextV1Schema } from '../releases/v1/operations.js';
import { TriageActionIdV1Schema, TriageActionSubjectV1Schema, TriageEntryRefV1Schema, TriageSourceInstanceIdV1Schema } from './identity.js';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString();
const bool = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const selectedEntry = defineProtocolObject({ entryRef: TriageEntryRefV1Schema, sourceInstanceId: TriageSourceInstanceIdV1Schema }, closed);
const handoffTask = defineProtocolUnion([
    defineProtocolLiteral('fix'), defineProtocolLiteral('draftReleaseNotes'), defineProtocolLiteral('investigate'),
]);

// The Artifact reference is re-read at execution; it carries no evidence text
// or authority. Identity/page admission stays with the host's canonical parser.
const healthNotice = defineProtocolObject({ kind: defineProtocolLiteral('host'), artifactId: text,
    source: defineProtocolUnion([ProtocolServiceHealthNoticeSourceV1Schema,
        defineProtocolObject({ kind: defineProtocolLiteral('host'), topic: defineProtocolLiteral('resource_limit') }, closed)]),
}, closed);
const healthPlacement = {
    machine: ProtocolServiceHealthNoticeMachineV1Schema.optional(),
    workspace: ProtocolWorkspaceAddressV1Schema.optional(),
};


/**
 * A native subject is an exact owner address, never caller-supplied logs or a health verdict. Most are failures;
 * `deploymentEnvironment` is the Environment a setup action starts from, re-read through the same owner.
 */
export const TriageFailureSubjectV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('workflowRun'), serverId: text, runId: text }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('deploymentReceipt'), serverId: text, environmentId: text, deploymentId: text }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('managedMachineOperation'), operation: ProjectExecutionOperationRefV1ProtocolSchema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('backupRun'), operation: ProjectExecutionOperationRefV1ProtocolSchema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('service'), target: ProtocolServiceHealthNoticePageV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('domain'), serverId: text, environmentId: text, domainId: text }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('deploymentEnvironment'), serverId: text, environmentId: text }, closed),
]);
export type TriageFailureSubjectV1 = ReturnType<typeof TriageFailureSubjectV1Schema.parse>;

export const TRIAGE_DEFAULT_FIX_ACTION_ID_V1 = 'fix';
export const TRIAGE_DEFAULT_INVESTIGATE_ACTION_ID_V1 = 'investigate';
export const TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1 = Object.freeze({
    pluginId: 'happier.triage', localId: 'actions/read-v1',
} as const);

const selectionMembers = {
    configuredActionId: TriageActionIdV1Schema,
    sessionChoice: defineProtocolUnion([
        defineProtocolObject({ kind: defineProtocolLiteral('configured') }, closed),
        defineProtocolObject({ kind: defineProtocolLiteral('existing'), session: SessionTargetV1Schema }, closed),
        defineProtocolObject({ kind: defineProtocolLiteral('new') }, closed),
    ]),
    agentChoice: defineProtocolUnion([
        defineProtocolObject({ kind: defineProtocolLiteral('configured') }, closed),
        defineProtocolObject({ kind: defineProtocolLiteral('profile'), profileId: ProtocolLaunchProfileIdV2Schema }, closed),
        defineProtocolObject({ kind: defineProtocolLiteral('target'), targetKey: AgentTargetKeyV2Schema }, closed),
    ]),
    delivery: defineProtocolUnion([defineProtocolLiteral('configured'), defineProtocolLiteral('compose'), defineProtocolLiteral('send')]),
};

/** The same four operands accepted by the configured handoff, with no copied preferences. */
export const TriageSessionHandoffSelectionV1Schema = defineProtocolObject(selectionMembers, closed);
export type TriageSessionHandoffSelectionV1 = ReturnType<typeof TriageSessionHandoffSelectionV1Schema.parse>;

export const TriageReadSessionHandoffChoicesInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1), projection: defineProtocolLiteral('sessionHandoff'),
    task: handoffTask.optional(),
    /** The page's own native subject: its records are added to the shared choices and marked `forSubject`. */
    subject: TriageActionSubjectV1Schema.optional(),
}, closed);
export type TriageReadSessionHandoffChoicesInputV1 = ReturnType<typeof TriageReadSessionHandoffChoicesInputV1Schema.parse>;

/** Only the catalog owner chooses offered Actions and the default identity. */
export const TriageSessionHandoffChoicesV1Schema = defineProtocolUnion([
    defineProtocolObject({ v: defineProtocolLiteral(1), kind: defineProtocolLiteral('choices'),
        actions: defineProtocolArray(defineProtocolObject({ label: text, selection: TriageSessionHandoffSelectionV1Schema,
            // The catalog owner's launch facts for the split button: its own mode, whether Start can run it, and the
            // translation key of a still-shipped label. Optional only so a newer UI reads an older catalog.
            launchMode: defineProtocolUnion([defineProtocolLiteral('start'), defineProtocolLiteral('review')]).optional(),
            startable: bool.optional(),
            titleKey: text.optional(),
            forSubject: defineProtocolLiteral(true).optional(),
        }, closed)),
        defaultActionId: TriageActionIdV1Schema.nullable(),
    }, closed),
    defineProtocolObject({ v: defineProtocolLiteral(1), kind: defineProtocolLiteral('unavailable'),
        reason: defineProtocolLiteral('catalogUnavailable'),
    }, closed),
]);
export type TriageSessionHandoffChoicesV1 = ReturnType<typeof TriageSessionHandoffChoicesV1Schema.parse>;

/** Native evidence retains its domain identity; no evidence grants authority. */
export const TriageSessionHandoffEvidenceV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('failure'), subject: TriageFailureSubjectV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('alert'), notice: healthNotice }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('hostedCi'), summary: ForgeCiFailureSummaryV1Schema }, closed),
    ForgeReleaseNotesContextV1Schema,
    defineProtocolObject({ kind: defineProtocolLiteral('alertEntry'), entry: selectedEntry }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('entry'), entry: selectedEntry }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('localTerminal'), text,
        operationRef: ProjectExecutionOperationRefV1ProtocolSchema,
        coverage: defineProtocolObject({ complete: bool, gaps: bool }, closed) }, closed),
]);
export type TriageSessionHandoffEvidenceV1 = ReturnType<typeof TriageSessionHandoffEvidenceV1Schema.parse>;

/** One configured owner chooses the Session, Agent and delivery for every caller. */
const handoffInputMembers = {
    task: handoffTask,
    configuredActionId: selectionMembers.configuredActionId,
    context: defineProtocolUnion([
        defineProtocolObject({ kind: defineProtocolLiteral('entries'),
            entries: defineProtocolArray(selectedEntry, { minItems: 1 }),
            destination: defineProtocolUnion([
                defineProtocolLiteral('single'), defineProtocolLiteral('oneSessionForAllEntries'),
                defineProtocolLiteral('oneSessionPerEntry'), defineProtocolLiteral('attachAllToNewSession'),
            ]),
        }, closed),
        defineProtocolObject({ kind: defineProtocolLiteral('failure'), subject: TriageFailureSubjectV1Schema, ...healthPlacement }, closed),
        defineProtocolObject({ kind: defineProtocolLiteral('healthAlert'), notice: healthNotice,
            target: defineProtocolUnion([ProtocolServiceHealthNoticePageV1Schema,
                defineProtocolObject({ kind: defineProtocolLiteral('machine'), machine: ProtocolServiceHealthNoticeMachineV1Schema }, closed)]),
            ...healthPlacement }, closed),
        defineProtocolObject({ kind: defineProtocolLiteral('entry'), entry: selectedEntry }, closed),
        defineProtocolObject({ kind: defineProtocolLiteral('repository'), repository: ScmHostingRepositoryIdentityV1ProtocolSchema,
            workspace: ProtocolWorkspaceAddressV1Schema.optional() }, closed),
    ]),
    evidence: defineProtocolArray(TriageSessionHandoffEvidenceV1Schema, { minItems: 1 }),
    sessionChoice: selectionMembers.sessionChoice,
    agentChoice: selectionMembers.agentChoice,
    delivery: selectionMembers.delivery,
};
type HandoffInputSchema = ReturnType<typeof defineProtocolObject<typeof handoffInputMembers, typeof closed>>;
export interface TriageSessionHandoffAuthoredInputV1 extends ProtocolSchemaInput<HandoffInputSchema> {}
export interface TriageSessionHandoffInputV1 extends ProtocolSchemaOutput<HandoffInputSchema> {}
export const TriageSessionHandoffInputV1Schema: ProtocolComposableSchema<Readonly<TriageSessionHandoffAuthoredInputV1>, Readonly<TriageSessionHandoffInputV1>> =
    defineProtocolObject(handoffInputMembers, closed);

/** Incumbent entry/bulk/Review execution phases, without claiming an Agent finished. */
export const TriageConfiguredEntryExecutionStatusV1Schema = defineProtocolUnion([
    defineProtocolLiteral('single'), defineProtocolLiteral('bulk'), defineProtocolLiteral('seeded'),
    defineProtocolLiteral('cancelled'), defineProtocolLiteral('unavailable'),
    defineProtocolLiteral('awaitingReview'), defineProtocolLiteral('reviewStarted'), defineProtocolLiteral('reviewPartial'),
    defineProtocolLiteral('reviewRefused'), defineProtocolLiteral('reviewUnknown'),
]);

/** An exact destination or native send result never claims the Agent finished. */
type HandoffSendResultAuthored = Readonly<{
    kind: 'sendResult';
    session: ProtocolSchemaInput<typeof ActionSessionAddressV1Schema>;
    result: ProtocolSchemaInput<typeof SessionMessageSendResultV1ProtocolSchema>;
}>;
type HandoffSendResult = Readonly<{
    kind: 'sendResult';
    session: ProtocolSchemaOutput<typeof ActionSessionAddressV1Schema>;
    result: ProtocolSchemaOutput<typeof SessionMessageSendResultV1ProtocolSchema>;
}>;
const handoffSendResult: ProtocolComposableSchema<HandoffSendResultAuthored, HandoffSendResult> =
    defineProtocolObject({ kind: defineProtocolLiteral('sendResult'), session: ActionSessionAddressV1Schema,
        result: SessionMessageSendResultV1ProtocolSchema }, closed);

const handoffResult = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('entryExecution'), status: TriageConfiguredEntryExecutionStatusV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('composed'), destination: defineProtocolUnion([
        defineProtocolObject({ kind: defineProtocolLiteral('newSessionDraft') }, closed),
        defineProtocolObject({ kind: defineProtocolLiteral('existing'), session: ActionSessionAddressV1Schema }, closed),
    ]) }, closed),
    handoffSendResult,
    defineProtocolObject({ kind: defineProtocolLiteral('placement_choice_required'), reason: defineProtocolUnion([
        defineProtocolLiteral('controller_required'), defineProtocolLiteral('machine_unreachable'),
        defineProtocolLiteral('ambiguous_workspace'), defineProtocolLiteral('agent_required'),
    ]), candidates: defineProtocolArray(defineProtocolObject({
        machine: ProtocolServiceHealthNoticeMachineV1Schema, workspace: ProtocolWorkspaceAddressV1Schema.optional(),
        reachable: bool,
    }, closed)), agents: defineProtocolArray(defineProtocolObject({ targetKey: AgentTargetKeyV2Schema, label: text }, closed)) }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('selectionRequired'), fields: defineProtocolUniqueArray(defineProtocolUnion([
        defineProtocolLiteral('sessionChoice'), defineProtocolLiteral('agentChoice'), defineProtocolLiteral('delivery'),
        defineProtocolLiteral('placement'),
    ])) }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('cancelled') }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), reason: defineProtocolUnion([
        defineProtocolLiteral('configuredActionUnavailable'), defineProtocolLiteral('evidenceInvalid'),
        defineProtocolLiteral('repositoryMismatch'), defineProtocolLiteral('scopeMismatch'),
        defineProtocolLiteral('sessionUnavailable'), defineProtocolLiteral('agentMismatch'),
        defineProtocolLiteral('composerUnavailable'), defineProtocolLiteral('targetUnavailable'),
    ]), detail: defineProtocolObject({ reason: defineProtocolUnion([
        defineProtocolLiteral('action_references_unresolved'), defineProtocolLiteral('entry_review_workspace_missing'),
        defineProtocolLiteral('entry_start_unavailable'), defineProtocolLiteral('entry_start_refused'),
        defineProtocolLiteral('existing_session_workspace_missing'), defineProtocolLiteral('existing_session_review_preparation_missing'),
        defineProtocolLiteral('existing_session_review_verification_failed'), defineProtocolLiteral('subject_review_workspace_missing'),
        defineProtocolLiteral('new_session_draft_unsettled'), defineProtocolLiteral('new_session_destination_refused'),
        defineProtocolLiteral('retained_review_workspace_unsupported'), defineProtocolLiteral('session_start_refused'),
    ]), cause: text.optional() }, closed).optional() }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('uncertain'), phase: defineProtocolUnion([
        defineProtocolLiteral('create'), defineProtocolLiteral('link'), defineProtocolLiteral('send'),
    ]), session: ActionSessionAddressV1Schema.nullable() }, closed),
]);
export type TriageSessionHandoffAuthoredResultV1 = ProtocolSchemaInput<typeof handoffResult>;
export type TriageSessionHandoffResultV1 = ProtocolSchemaOutput<typeof handoffResult>;
export const TriageSessionHandoffResultV1Schema: ProtocolComposableSchema<TriageSessionHandoffAuthoredResultV1, TriageSessionHandoffResultV1> = handoffResult;
