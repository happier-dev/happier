import {
    AutomationEventAdmitHttpRequestV1Schema,
    AutomationEventAdmitHttpResultV1Schema,
    AutomationEventTriggerDefinitionStoredPayloadV1Schema,
    AutomationStoredContentEnvelopeV1Schema,
    AutomationTriggerIdSchema,
    compilePluginJsonSchema,
    buildAutomationPluginEventOccurrenceEvidenceV1,
    createCanonicalJsonSigningInput,
    deriveAutomationOccurrenceKeyV1,
    evaluateAutomationEventFilterV1,
    isAutomationEventObservationFreshV1,
    isAutomationTriggerEvidenceCiphertextV1,
    isSameAutomationEventDeclarationReleaseV1,
    isValidPluginJsonSchemaValue,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
    type AutomationEventAdmitHostEvidenceV1,
    type AutomationEventAdmitContinuationV1,
    type AutomationEventAdmitHttpInputV1,
    type AutomationEventAdmitItemResultV1,
    type AutomationEventAdmitHttpResultV1,
    type AutomationOccurrenceKeyV1,
    type AutomationPluginEventOccurrenceEvidenceV1,
    type AutomationSourceSelectorIdV1,
    type AutomationTriggerId,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import {
    validateCurrentPluginWebhookInvocationReferenceTxV1,
    type PluginWebhookInvocationReferenceValidationResultV1,
} from "@/app/plugins/webhooks/claimStore";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { inTx, type Tx } from "@/storage/inTx";

import {
    assertCurrentAutomationEventCallerMaterializationTx,
    readCurrentAutomationEventDurablePushEndpointTargetTxV1,
    readCurrentAutomationEventDurablePushWebhookContributionV1,
    resolveCurrentAutomationEventContributionTx,
    sameAutomationEventDurablePushWebhookContributionV1,
    AutomationEventCurrentnessError,
    type AutomationEventCallerV1,
    type CurrentAutomationEventContributionV1,
} from "./automationEventCurrentness";
import { fetchAutomationAccountCurrentnessWitnessTx } from "./automationAccountCurrentness";
import {
    classifyPlainAutomationOccurrenceEvidence,
    encodePlainAutomationOccurrenceEvidence,
    findAutomationTriggerOccurrencesTx,
    rejoinAutomationOccurrenceInsertRace,
} from "./automationOccurrencePersistence";
import {
    validateAutomationStoredContentEnvelopeOuterForMode,
    readAutomationTriggerDefinitionBinding,
    validateAutomationTriggerDefinitionEnvelopeOuterForMode,
} from "./automationStoredContentRead";
import {
    admitAutomationRunsTx,
    type AutomationRunAdmissionIneligibleReason,
} from "./automationRunAdmissionService";

export type AutomationEventAdmissionCallerV1 = AutomationEventCallerV1;

export class AutomationEventAdmissionError extends Error {
    readonly code:
        | "caller_materialization_not_current"
        | "event_contribution_not_current";

    constructor(code: AutomationEventAdmissionError["code"]) {
        super(code);
        this.name = "AutomationEventAdmissionError";
        this.code = code;
    }
}

type Candidate = Readonly<{
    groupKey: string;
    automationId: string;
    triggerId: AutomationTriggerId;
    triggerRevision: number;
    occurrenceKey: AutomationOccurrenceKeyV1;
    sourceSelectorId: AutomationSourceSelectorIdV1;
    occurredAt: Date;
    evidence: AutomationPluginEventOccurrenceEvidenceV1;
    occurrenceEvidenceEqualityTag: string | null;
    triggerEvidenceEnvelope: string;
    executionTriggerEvidenceEnvelope: string;
}>;

type EncryptedCandidate = Readonly<{
    group: DefinitionGroup<EncryptedDefinition>;
    automationId: string;
    triggerId: AutomationTriggerId;
    triggerRevision: number;
    occurrenceKey: AutomationOccurrenceKeyV1;
    sourceSelectorId: AutomationSourceSelectorIdV1;
    occurredAt: Date;
    occurrenceEvidenceEqualityTag: string;
    triggerEvidenceEnvelope: string;
}>;

type ExistingOccurrenceRow = Readonly<{
    id: string;
    triggerId: string | null;
    causeKind: string;
    causeTriggerKind: string | null;
    causeEventPluginId: string | null;
    causeEventLocalId: string | null;
    causeOccurredAt: Date | null;
    occurrenceKey: string | null;
    causeSourceSelectorId: string | null;
    occurrenceEvidenceEqualityTag: string | null;
    triggerEvidenceEnvelope: string | null;
}>;

const existingEventOccurrenceSelect = {
    id: true,
    triggerId: true,
    causeKind: true,
    causeTriggerKind: true,
    causeEventPluginId: true,
    causeEventLocalId: true,
    causeOccurredAt: true,
    occurrenceKey: true,
    causeSourceSelectorId: true,
    occurrenceEvidenceEqualityTag: true,
    triggerEvidenceEnvelope: true,
} satisfies Prisma.AutomationRunSelect;

const currentEventAdmissionTriggerSelect = {
    id: true,
    automationId: true,
    enabled: true,
    deletedAt: true,
    revision: true,
    kind: true,
    eventPluginId: true,
    eventLocalId: true,
    sourceSelectorId: true,
    sourceContractVersion: true,
    observationTransport: true,
    webhookEndpointId: true,
    observationStartsAt: true,
    watcherMachineId: true,
    watcherMachineInstallationId: true,
    watcherPluginId: true,
    watcherMaterializationId: true,
    definitionEnvelope: true,
    automation: { select: { id: true, enabled: true, deletedAt: true } },
} satisfies Prisma.AutomationTriggerSelect;

type CurrentEventAdmissionTrigger = Prisma.AutomationTriggerGetPayload<{
    select: typeof currentEventAdmissionTriggerSelect;
}>;

async function loadCurrentEventAdmissionTriggersTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    triggerIds: readonly string[];
}>): Promise<ReadonlyMap<string, CurrentEventAdmissionTrigger>> {
    if (params.triggerIds.length === 0) return new Map();
    const rows = await params.tx.automationTrigger.findMany({
        where: {
            id: { in: [...new Set(params.triggerIds)] },
            automation: { accountId: params.accountId },
        },
        select: currentEventAdmissionTriggerSelect,
    });
    return new Map(rows.map((row) => [row.id, row]));
}

type EncryptedDefinition = Extract<
    AutomationEventAdmitHostEvidenceV1,
    Readonly<{ t: "encrypted" }>
>["definitions"][number];

type DefinitionGroup<TDefinition = AutomationEventAdmitHttpInputV1["definitions"][number]> = Readonly<{
    key: string;
    definition: TDefinition;
    indexes: readonly number[];
}>;

function occurrenceLookupKey(triggerId: string, occurrenceKey: string): string {
    return JSON.stringify([triggerId, occurrenceKey]);
}

function blocked(reason: "capacity" | "temporarilyUnavailable" | "occurrenceConflict" | "noEnabledAssignment"):
    AutomationEventAdmitItemResultV1 {
    return { kind: "blocked", reason, checkpointSafe: false };
}

function skipped(reason: "filtered" | "beforeObservationStart" | "outsideFreshness" | "definitionRetired" | "occurrenceRejected"):
    AutomationEventAdmitItemResultV1 {
    return { kind: "skipped", reason, checkpointSafe: true };
}

function refresh(reason: "definitionStale" | "observationTargetChanged"):
    AutomationEventAdmitItemResultV1 {
    return { kind: "refreshDefinition", reason, checkpointSafe: false };
}

function ineligibleAdmissionResult(
    reason: AutomationRunAdmissionIneligibleReason,
): AutomationEventAdmitItemResultV1 {
    if (reason === "triggerRevisionMismatch") return refresh("definitionStale");
    if (reason === "triggerKindMismatch") return refresh("observationTargetChanged");
    if (reason === "capacity") return blocked("capacity");
    if (reason === "noEnabledAssignment") return blocked("noEnabledAssignment");
    if (reason === "definitionInvalid") return skipped("occurrenceRejected");
    // Missing or disabled definitions are terminal for this observation and
    // checkpoint-safe. Assignment liveness is handled above as retryable: a
    // repaired definition must still be able to admit this exact occurrence.
    return skipped("definitionRetired");
}

/**
 * One bounded request may address the same occurrence from several positions.
 * Grouping is request-local: each identity is evaluated once and its outcome is
 * expanded back to every supplied position, so the transaction never attempts
 * the same unique occurrence insert twice.
 */
function groupRequestDefinitions<TDefinition>(
    definitions: readonly TDefinition[],
    identityOf: (definition: TDefinition) => string,
): readonly DefinitionGroup<TDefinition>[] {
    const groups = new Map<string, { definition: TDefinition; indexes: number[] }>();
    definitions.forEach((definition, index) => {
        const key = identityOf(definition);
        const existing = groups.get(key);
        if (existing) {
            existing.indexes.push(index);
            return;
        }
        groups.set(key, { definition, indexes: [index] });
    });
    return Array.from(groups.entries(), ([key, value]) => ({
        key,
        definition: value.definition,
        indexes: value.indexes,
    }));
}

function groupDefinitions(input: AutomationEventAdmitHttpInputV1): readonly DefinitionGroup[] {
    return groupRequestDefinitions(input.definitions, (definition) => [
        definition.automationId,
        definition.triggerId,
        definition.triggerRevision,
        definition.sourceSelectorId,
    ].join("\u0000"));
}

/**
 * Encrypted definitions carry their own host-derived occurrence key, so the
 * durable `(triggerId, occurrenceKey)` identity is the request-local group.
 * Positions that claim one identity with different sealed evidence cannot both
 * be honoured; they are refused before any mutation instead of letting the
 * unique-constraint exception choose the outcome.
 */
function groupEncryptedDefinitions(
    definitions: readonly EncryptedDefinition[],
): Readonly<{
    groups: readonly DefinitionGroup<EncryptedDefinition>[];
    conflicting: readonly DefinitionGroup<EncryptedDefinition>[];
}> {
    const groups: DefinitionGroup<EncryptedDefinition>[] = [];
    const conflicting: DefinitionGroup<EncryptedDefinition>[] = [];
    for (const group of groupRequestDefinitions(
        definitions,
        (definition) => [definition.triggerId, definition.occurrenceKey].join("\u0000"),
    )) {
        const representative = createCanonicalJsonSigningInput(group.definition);
        const identical = group.indexes.every((index) => (
            createCanonicalJsonSigningInput(definitions[index]) === representative
        ));
        (identical ? groups : conflicting).push(group);
    }
    return { groups, conflicting };
}

function stoppedContinuation(
    reason: "accountCurrentnessMoved" | "accountUnavailable",
): Extract<AutomationEventAdmitContinuationV1, Readonly<{ kind: "stopped" }>> {
    return { kind: "stopped", reason };
}

function resultForEveryDefinition(
    input: AutomationEventAdmitHttpInputV1,
    result: AutomationEventAdmitItemResultV1,
    continuation: AutomationEventAdmitContinuationV1,
):
    AutomationEventAdmitHttpResultV1 {
    return AutomationEventAdmitHttpResultV1Schema.parse({
        results: input.definitions.map(() => result),
        continuation,
    });
}

function assignGroupResult(
    results: Array<AutomationEventAdmitItemResultV1 | undefined>,
    group: DefinitionGroup<unknown>,
    result: AutomationEventAdmitItemResultV1,
): void {
    for (const index of group.indexes) results[index] = result;
}

function assertAllResults(
    results: ReadonlyArray<AutomationEventAdmitItemResultV1 | undefined>,
    continuation: AutomationEventAdmitContinuationV1,
): AutomationEventAdmitHttpResultV1 {
    return AutomationEventAdmitHttpResultV1Schema.parse({ results, continuation });
}

async function assertAllResultsWithReadyContinuationTx(params: Readonly<{
    tx: Parameters<typeof fetchAutomationAccountCurrentnessWitnessTx>[0];
    accountId: string;
    results: ReadonlyArray<AutomationEventAdmitItemResultV1 | undefined>;
}>): Promise<AutomationEventAdmitHttpResultV1> {
    const accountCurrentness = await fetchAutomationAccountCurrentnessWitnessTx(
        params.tx,
        params.accountId,
    );
    if (accountCurrentness === null) {
        throw new Error("Automation Event admission lost Account currentness before response");
    }
    return assertAllResults(params.results, { kind: "ready", accountCurrentness });
}

function existingEvidenceDisposition(params: Readonly<{
    row: ExistingOccurrenceRow;
    triggerId: string;
    occurrenceKey: string;
    sourceSelectorId: string;
    evidence: AutomationPluginEventOccurrenceEvidenceV1;
}>): "match" | "mismatch" | "unavailable" {
    if (
        params.row.triggerId !== params.triggerId
        || params.row.causeKind !== "trigger"
        || params.row.causeTriggerKind !== "pluginEvent"
        || params.row.causeEventPluginId !== params.evidence.eventRef.pluginId
        || params.row.causeEventLocalId !== params.evidence.eventRef.localId
        || params.row.causeOccurredAt?.getTime() !== params.evidence.occurredAt
        || params.row.occurrenceKey !== params.occurrenceKey
        || params.row.causeSourceSelectorId !== params.sourceSelectorId
        || params.row.triggerEvidenceEnvelope === null
    ) return "mismatch";

    if (params.row.occurrenceEvidenceEqualityTag !== null) return "mismatch";

    return classifyPlainAutomationOccurrenceEvidence({
        triggerEvidenceEnvelope: params.row.triggerEvidenceEnvelope,
        expectedEvidence: params.evidence,
    });
}

function encryptedExistingEvidenceDisposition(params: Readonly<{
    row: ExistingOccurrenceRow;
    triggerId: string;
    eventRef: Readonly<{ pluginId: string; localId: string }>;
    occurrenceKey: string;
    sourceSelectorId: string;
    occurredAt: number;
    occurrenceEvidenceEqualityTag: string;
}>): "match" | "mismatch" | "unavailable" {
    if (
        params.row.triggerId !== params.triggerId
        || params.row.causeKind !== "trigger"
        || params.row.causeTriggerKind !== "pluginEvent"
        || params.row.causeEventPluginId !== params.eventRef.pluginId
        || params.row.causeEventLocalId !== params.eventRef.localId
        || params.row.causeOccurredAt?.getTime() !== params.occurredAt
        || params.row.occurrenceKey !== params.occurrenceKey
        || params.row.causeSourceSelectorId !== params.sourceSelectorId
        || params.row.triggerEvidenceEnvelope === null
        || params.row.occurrenceEvidenceEqualityTag !== params.occurrenceEvidenceEqualityTag
    ) return "mismatch";
    const outer = validateAutomationStoredContentEnvelopeOuterForMode({
        raw: params.row.triggerEvidenceEnvelope,
        mode: "e2ee",
    });
    if (outer.kind !== "available" || outer.envelope.t !== "encrypted") return "unavailable";
    return isAutomationTriggerEvidenceCiphertextV1(outer.envelope.c)
        ? "match"
        : "unavailable";
}

function hostEvidenceMatchesAccountModeAndKey(params: Readonly<{
    hostEvidence: AutomationEventAdmitHostEvidenceV1;
    account: Readonly<{
        contentKeyFingerprint: string | null;
        currentness: Readonly<{ encryptionMode: "plain" | "e2ee" }>;
    }>;
}>): boolean {
    return params.hostEvidence.t
        === (params.account.currentness.encryptionMode === "plain" ? "plain" : "encrypted")
        && params.hostEvidence.accountCurrentness.mode === params.account.currentness.encryptionMode
        && params.hostEvidence.accountCurrentness.contentKeyFingerprint
            === params.account.contentKeyFingerprint;
}

function hostEvidenceMatchesAccountCurrentness(params: Readonly<{
    hostEvidence: AutomationEventAdmitHostEvidenceV1;
    account: Readonly<{
        version: number;
        contentKeyFingerprint: string | null;
        currentness: Readonly<{ encryptionMode: "plain" | "e2ee" }>;
    }>;
}>): boolean {
    return hostEvidenceMatchesAccountModeAndKey(params)
        && params.hostEvidence.accountCurrentness.version === params.account.version;
}

function selectedWatcherTargetMatchesCaller(
    trigger: Readonly<{
        observationTransport: string | null;
        watcherMachineId: string | null;
        watcherMachineInstallationId: string | null;
        watcherPluginId: string | null;
        watcherMaterializationId: string | null;
    }>,
    caller: AutomationEventAdmissionCallerV1,
): boolean {
    // Checkpointed-pull and session-socket triggers both observe through one
    // exact assigned watcher materialization; only durable push derives its
    // target from a webhook endpoint.
    return (trigger.observationTransport === "checkpointedPull"
        || trigger.observationTransport === "socket")
        && trigger.watcherMachineId === caller.machineId
        && trigger.watcherMachineInstallationId === caller.machineInstallationId
        && trigger.watcherPluginId === caller.pluginId
        && trigger.watcherMaterializationId === caller.materializationId;
}

function validatedWebhookTargetMatchesCaller(
    target: Extract<
        PluginWebhookInvocationReferenceValidationResultV1,
        Readonly<{ kind: "ready" }>
    >["target"],
    caller: AutomationEventAdmissionCallerV1,
): boolean {
    return target.materialization.pluginId === caller.pluginId
        && target.materialization.machineId === caller.machineId
        && target.materialization.materializationId === caller.materializationId
        && target.machineInstallationId === caller.machineInstallationId;
}

/** One bounded admission request must not re-read identical webhook authority per definition. */
export function createRequestLocalDurablePushCurrentnessReads<TValidation, TEndpoint>(params: Readonly<{
    validateInvocation: () => Promise<TValidation>;
    readEndpoint: (webhookEndpointId: string) => Promise<TEndpoint>;
}>) {
    let validation: Promise<TValidation> | null = null;
    const endpoints = new Map<string, Promise<TEndpoint>>();
    return {
        validateInvocation: async () => await (validation ??= params.validateInvocation()),
        readEndpoint: async (webhookEndpointId: string) => {
            let endpoint = endpoints.get(webhookEndpointId);
            if (!endpoint) {
                endpoint = params.readEndpoint(webhookEndpointId);
                endpoints.set(webhookEndpointId, endpoint);
            }
            return await endpoint;
        },
    };
}

async function admitEncryptedAutomationEventV1(params: Readonly<{
    accountId: string;
    caller: AutomationEventAdmissionCallerV1;
    hostEvidence: Extract<AutomationEventAdmitHostEvidenceV1, Readonly<{ t: "encrypted" }>>;
    serverIdentityId: string;
}>): Promise<AutomationEventAdmitHttpResultV1> {
    return await rejoinAutomationOccurrenceInsertRace(() => inTx(async (tx) => {
        let callerVersion: string;
        let eventDeclarationRelease: Extract<
            AutomationEventAdmitHostEvidenceV1,
            Readonly<{ t: "encrypted" }>
        >["eventDeclarationRelease"];
        try {
            const currentCaller = await assertCurrentAutomationEventCallerMaterializationTx({
                tx,
                accountId: params.accountId,
                serverIdentityId: params.serverIdentityId,
                caller: params.caller,
            });
            callerVersion = currentCaller.version;
            eventDeclarationRelease = currentCaller.eventDeclarationRelease;
        } catch (error) {
            if (error instanceof AutomationEventCurrentnessError) {
                throw new AutomationEventAdmissionError(error.code);
            }
            throw error;
        }

        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
            tx,
            params.accountId,
        );
        if (
            accountFence.status !== "ready"
            || !hostEvidenceMatchesAccountModeAndKey({
                hostEvidence: params.hostEvidence,
                account: accountFence.account,
            })
        ) {
            return AutomationEventAdmitHttpResultV1Schema.parse({
                results: params.hostEvidence.definitions.map(() => blocked("temporarilyUnavailable")),
                continuation: stoppedContinuation("accountUnavailable"),
            });
        }
        const hostEvidenceIsCurrent = hostEvidenceMatchesAccountCurrentness({
            hostEvidence: params.hostEvidence,
            account: accountFence.account,
        });

        const results: Array<AutomationEventAdmitItemResultV1 | undefined> = Array(
            params.hostEvidence.definitions.length,
        );
        const { groups, conflicting } = groupEncryptedDefinitions(params.hostEvidence.definitions);
        for (const group of conflicting) {
            assignGroupResult(results, group, blocked("occurrenceConflict"));
        }
        const existingOccurrences = await findAutomationTriggerOccurrencesTx({
            tx,
            accountId: params.accountId,
            occurrences: groups.map(({ definition }) => ({
                triggerId: definition.triggerId,
                occurrenceKey: definition.occurrenceKey,
            })),
            select: existingEventOccurrenceSelect,
        });
        const existingByOccurrence = new Map(existingOccurrences.map((row) => [
            occurrenceLookupKey(row.triggerId!, row.occurrenceKey!),
            row,
        ]));
        const missing: DefinitionGroup<EncryptedDefinition>[] = [];
        for (const group of groups) {
            const definition = group.definition;
            const existing = existingByOccurrence.get(occurrenceLookupKey(
                definition.triggerId,
                definition.occurrenceKey,
            )) ?? null;
            if (existing === null) {
                missing.push(group);
                continue;
            }
            const disposition = encryptedExistingEvidenceDisposition({
                row: existing,
                triggerId: definition.triggerId,
                eventRef: params.hostEvidence.eventRef,
                occurrenceKey: definition.occurrenceKey,
                sourceSelectorId: definition.sourceSelectorId,
                occurredAt: definition.occurredAt,
                occurrenceEvidenceEqualityTag: definition.occurrenceEvidenceEqualityTag,
            });
            assignGroupResult(results, group, disposition === "match"
                ? { kind: "rejoined", runId: existing.id, checkpointSafe: true }
                : blocked(disposition === "mismatch" ? "occurrenceConflict" : "temporarilyUnavailable"));
        }

        // Existing immutable occurrences rejoin above, before any mutable
        // definition/currentness decision. Every net-new outcome, including a
        // host-prepared skip, must still prove its adopted Definition is
        // current before it can be checkpoint-safe.
        if (!hostEvidenceIsCurrent) {
            for (const group of missing) assignGroupResult(results, group, blocked("temporarilyUnavailable"));
            return assertAllResults(results, stoppedContinuation("accountCurrentnessMoved"));
        }
        if (missing.length === 0) {
            return await assertAllResultsWithReadyContinuationTx({
                tx,
                accountId: params.accountId,
                results,
            });
        }

        if (!isSameAutomationEventDeclarationReleaseV1(
            params.hostEvidence.eventDeclarationRelease,
            eventDeclarationRelease,
        )) {
            for (const group of missing) assignGroupResult(results, group, refresh("definitionStale"));
            return await assertAllResultsWithReadyContinuationTx({
                tx,
                accountId: params.accountId,
                results,
            });
        }

        let event: CurrentAutomationEventContributionV1 | null = null;
        if (params.hostEvidence.eventRef.pluginId === params.caller.pluginId) {
            try {
                event = await resolveCurrentAutomationEventContributionTx({
                    tx,
                    accountId: params.accountId,
                    pluginId: params.caller.pluginId,
                    version: callerVersion,
                    eventLocalId: params.hostEvidence.eventRef.localId,
                });
            } catch {
                event = null;
            }
        }
        if (event === null || !event.payloadSchema) {
            for (const group of missing) assignGroupResult(results, group, refresh("definitionStale"));
            return await assertAllResultsWithReadyContinuationTx({
                tx,
                accountId: params.accountId,
                results,
            });
        }
        const catalog = await tx.automationEventCatalogState.findUnique({
            where: { accountId: params.accountId },
            select: { eventSourceDefinitionsRevision: true },
        });
        if (catalog === null || catalog.eventSourceDefinitionsRevision.toString() !== params.hostEvidence.adoptedRevision) {
            for (const group of missing) assignGroupResult(results, group, refresh("definitionStale"));
            return await assertAllResultsWithReadyContinuationTx({
                tx,
                accountId: params.accountId,
                results,
            });
        }

        const currentTriggers = await loadCurrentEventAdmissionTriggersTx({
            tx,
            accountId: params.accountId,
            triggerIds: missing.map(({ definition }) => definition.triggerId),
        });
        const durablePushCurrentness = params.hostEvidence.webhookInvocationReference
            ? createRequestLocalDurablePushCurrentnessReads({
                validateInvocation: async () => await validateCurrentPluginWebhookInvocationReferenceTxV1({
                    tx,
                    accountId: params.accountId,
                    reference: params.hostEvidence.webhookInvocationReference!,
                    serverIdentityId: params.serverIdentityId,
                }),
                readEndpoint: async (webhookEndpointId: string) =>
                    await readCurrentAutomationEventDurablePushEndpointTargetTxV1({
                        tx,
                        accountId: params.accountId,
                        webhookEndpointId,
                        caller: params.caller,
                        callerVersion,
                    }),
            })
            : null;
        const candidates: EncryptedCandidate[] = [];
        for (const group of missing) {
            const definition = group.definition;
            const trigger = currentTriggers.get(definition.triggerId);
            const automation = trigger?.automation;
            if (!trigger || trigger.automationId !== definition.automationId
                || !automation || !automation.enabled || automation.deletedAt !== null
                || !trigger.enabled || trigger.deletedAt !== null || trigger.kind !== "pluginEvent") {
                assignGroupResult(results, group, skipped("definitionRetired"));
                continue;
            }
            if (trigger.revision !== definition.triggerRevision) {
                assignGroupResult(results, group, refresh("definitionStale"));
                continue;
            }
            if (
                trigger.eventPluginId !== params.hostEvidence.eventRef.pluginId
                || trigger.eventLocalId !== params.hostEvidence.eventRef.localId
                || trigger.sourceSelectorId !== definition.sourceSelectorId
                || trigger.sourceContractVersion !== definition.sourceContractVersion
                || definition.sourceContractVersion !== event.automation.source.sourceContractVersion
                || trigger.observationTransport !== definition.observationTransport
                || !event.automation.source.supportedObservationTransports.includes(
                    definition.observationTransport,
                )
            ) {
                assignGroupResult(results, group, refresh("observationTargetChanged"));
                continue;
            }

            if (definition.observationTransport === "checkpointedPull"
                || definition.observationTransport === "socket") {
                if (
                    params.hostEvidence.webhookInvocationReference !== undefined
                    || !selectedWatcherTargetMatchesCaller(trigger, params.caller)
                ) {
                    assignGroupResult(results, group, refresh("observationTargetChanged"));
                    continue;
                }
            } else if (definition.observationTransport === "durablePush") {
                const webhookEndpointId = trigger.webhookEndpointId;
                const webhookContribution = readCurrentAutomationEventDurablePushWebhookContributionV1(event);
                if (
                    webhookEndpointId === null
                    || trigger.observationStartsAt === null
                    || webhookContribution === null
                    || webhookContribution.pluginId !== params.hostEvidence.eventRef.pluginId
                ) {
                    assignGroupResult(results, group, refresh("observationTargetChanged"));
                    continue;
                }
                if (!durablePushCurrentness) {
                    assignGroupResult(results, group, blocked("temporarilyUnavailable"));
                    continue;
                }
                const validated = await durablePushCurrentness.validateInvocation();
                if (validated.kind !== "ready") {
                    assignGroupResult(results, group, blocked("temporarilyUnavailable"));
                    continue;
                }
                if (
                    validated.webhookEndpointId !== webhookEndpointId
                    || !sameAutomationEventDurablePushWebhookContributionV1(
                        validated.webhookContribution,
                        webhookContribution,
                    )
                    || !validatedWebhookTargetMatchesCaller(validated.target, params.caller)
                ) {
                    assignGroupResult(results, group, refresh("observationTargetChanged"));
                    continue;
                }
                const currentEndpoint = await durablePushCurrentness.readEndpoint(webhookEndpointId);
                if (
                    currentEndpoint === null
                    || !sameAutomationEventDurablePushWebhookContributionV1(
                        currentEndpoint.webhookContribution,
                        webhookContribution,
                    )
                ) {
                    assignGroupResult(results, group, refresh("observationTargetChanged"));
                    continue;
                }
            } else {
                assignGroupResult(results, group, refresh("observationTargetChanged"));
                continue;
            }

            if (definition.outcome.kind === "skipped") {
                assignGroupResult(results, group, skipped(definition.outcome.reason));
                continue;
            }

            if (trigger.definitionEnvelope === null) {
                assignGroupResult(results, group, skipped("occurrenceRejected"));
                continue;
            }
            const definitionBinding = readAutomationTriggerDefinitionBinding({
                automationId: automation.id,
                triggerId: trigger.id,
                triggerRevision: trigger.revision,
                triggerKind: trigger.kind,
                triggerEventPluginId: trigger.eventPluginId,
                triggerEventLocalId: trigger.eventLocalId,
                triggerSourceSelectorId: trigger.sourceSelectorId,
            });
            const definitionOuter = definitionBinding === null
                ? { kind: "contentInvalid" as const }
                : validateAutomationTriggerDefinitionEnvelopeOuterForMode({
                    raw: trigger.definitionEnvelope,
                    mode: "e2ee",
                    binding: definitionBinding,
                });
            if (definitionOuter.kind !== "available" || definitionOuter.envelope.t !== "encrypted") {
                assignGroupResult(results, group, skipped("occurrenceRejected"));
                continue;
            }

            candidates.push({
                group,
                automationId: automation.id,
                triggerId: AutomationTriggerIdSchema.parse(trigger.id),
                triggerRevision: trigger.revision,
                occurrenceKey: definition.occurrenceKey,
                sourceSelectorId: definition.sourceSelectorId,
                occurredAt: new Date(definition.occurredAt),
                occurrenceEvidenceEqualityTag: definition.occurrenceEvidenceEqualityTag,
                triggerEvidenceEnvelope: createCanonicalJsonSigningInput(
                    definition.triggerEvidenceEnvelope,
                ),
            });
        }

        const now = new Date();
        const admissions = await admitAutomationRunsTx({
            tx,
            accountId: params.accountId,
            admissions: candidates.map((candidate) => ({
                automationId: candidate.automationId,
                now,
                cause: {
                    kind: "trigger",
                    triggerId: candidate.triggerId,
                    triggerRevision: candidate.triggerRevision,
                    triggerKind: "pluginEvent",
                    occurrenceKey: candidate.occurrenceKey,
                    occurredAt: candidate.occurredAt.getTime(),
                    evidence: {
                        eventRef: params.hostEvidence.eventRef,
                        sourceSelectorId: candidate.sourceSelectorId,
                    },
                },
                triggerEvidenceEnvelope: candidate.triggerEvidenceEnvelope,
                occurrenceEvidenceEqualityTag: candidate.occurrenceEvidenceEqualityTag,
            })),
        });
        for (const [index, candidate] of candidates.entries()) {
            const admitted = admissions[index]!;
            if (admitted.kind === "ineligible") {
                assignGroupResult(
                    results,
                    candidate.group,
                    ineligibleAdmissionResult(admitted.reason),
                );
                continue;
            }
            const run = admitted.run;
            assignGroupResult(results, candidate.group, {
                kind: admitted.kind,
                runId: run.id,
                checkpointSafe: true,
            });
        }
        return await assertAllResultsWithReadyContinuationTx({
            tx,
            accountId: params.accountId,
            results,
        });
    }));
}

/**
 * Sole server writer for a plugin Event occurrence. It validates the current
 * host-stamped caller and Event declaration, admits through the existing
 * AutomationRun ledger, and leaves execution/Session/Pending ownership to the
 * incumbent worker after the durable Run exists.
 */
export async function admitAutomationEventV1(params: Readonly<{
    accountId: string;
    caller: AutomationEventAdmissionCallerV1;
    request: unknown;
}>): Promise<AutomationEventAdmitHttpResultV1> {
    const admission = AutomationEventAdmitHttpRequestV1Schema.parse(params.request);
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    if (!("input" in admission)) {
        return await admitEncryptedAutomationEventV1({
            accountId: params.accountId,
            caller: params.caller,
            hostEvidence: admission.hostEvidence,
            serverIdentityId,
        });
    }
    const hostEvidence = admission.hostEvidence;
    const input = admission.input;

    return await rejoinAutomationOccurrenceInsertRace(() => inTx(async (tx) => {
        let callerVersion: string;
        try {
            const currentCaller = await assertCurrentAutomationEventCallerMaterializationTx({
                tx,
                accountId: params.accountId,
                serverIdentityId,
                caller: params.caller,
            });
            callerVersion = currentCaller.version;
            if (input.eventRef.pluginId !== params.caller.pluginId) {
                throw new AutomationEventAdmissionError("event_contribution_not_current");
            }
        } catch (error) {
            if (error instanceof AutomationEventCurrentnessError) {
                throw new AutomationEventAdmissionError(error.code);
            }
            throw error;
        }

        // The canonical Account transition fence serializes automatic-cause
        // capacity and supplies the one current mode/key/version witness.
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
            tx,
            params.accountId,
        );
        if (
            accountFence.status !== "ready"
            || !hostEvidenceMatchesAccountModeAndKey({
                hostEvidence,
                account: accountFence.account,
            })
        ) {
            return resultForEveryDefinition(
                input,
                blocked("temporarilyUnavailable"),
                stoppedContinuation("accountUnavailable"),
            );
        }
        const hostEvidenceIsCurrent = hostEvidenceMatchesAccountCurrentness({
            hostEvidence,
            account: accountFence.account,
        });

        const results: Array<AutomationEventAdmitItemResultV1 | undefined> = Array(
            input.definitions.length,
        );
        const candidates: Candidate[] = [];
        const groups = groupDefinitions(input);
        const missingGroups: DefinitionGroup[] = [];
        const occurrenceByGroupKey = new Map<string, Readonly<{
            evidence: AutomationPluginEventOccurrenceEvidenceV1;
            occurrenceKey: AutomationOccurrenceKeyV1;
        }>>();
        for (const group of groups) {
            const evidence = buildAutomationPluginEventOccurrenceEvidenceV1({
                eventRef: input.eventRef,
                sourceSelectorId: group.definition.sourceSelectorId,
                occurrenceId: input.occurrenceId,
                occurredAt: input.occurredAt,
                payload: input.payload,
            });
            const occurrenceKey = deriveAutomationOccurrenceKeyV1({
                triggerId: group.definition.triggerId,
                evidence,
            });
            occurrenceByGroupKey.set(group.key, { evidence, occurrenceKey });
        }
        const existingOccurrences = await findAutomationTriggerOccurrencesTx({
            tx,
            accountId: params.accountId,
            occurrences: groups.map((group) => ({
                triggerId: group.definition.triggerId,
                occurrenceKey: occurrenceByGroupKey.get(group.key)!.occurrenceKey,
            })),
            select: existingEventOccurrenceSelect,
        });
        const existingByOccurrence = new Map(existingOccurrences.map((row) => [
            occurrenceLookupKey(row.triggerId!, row.occurrenceKey!),
            row,
        ]));
        for (const group of groups) {
            const { evidence, occurrenceKey } = occurrenceByGroupKey.get(group.key)!;
            const existing = existingByOccurrence.get(occurrenceLookupKey(
                group.definition.triggerId,
                occurrenceKey,
            )) ?? null;
            if (existing === null) {
                missingGroups.push(group);
                continue;
            }
            const disposition = existingEvidenceDisposition({
                row: existing,
                triggerId: group.definition.triggerId,
                occurrenceKey,
                sourceSelectorId: group.definition.sourceSelectorId,
                evidence,
            });
            assignGroupResult(
                results,
                group,
                disposition === "match"
                    ? { kind: "rejoined", runId: existing.id, checkpointSafe: true }
                    : blocked(disposition === "mismatch" ? "occurrenceConflict" : "temporarilyUnavailable"),
            );
        }
        if (!hostEvidenceIsCurrent) {
            for (const group of missingGroups) {
                assignGroupResult(results, group, blocked("temporarilyUnavailable"));
            }
            return assertAllResults(results, stoppedContinuation("accountCurrentnessMoved"));
        }
        if (missingGroups.length === 0) {
            return await assertAllResultsWithReadyContinuationTx({
                tx,
                accountId: params.accountId,
                results,
            });
        }

        let event: CurrentAutomationEventContributionV1;
        try {
            event = await resolveCurrentAutomationEventContributionTx({
                tx,
                accountId: params.accountId,
                pluginId: params.caller.pluginId,
                version: callerVersion,
                eventLocalId: input.eventRef.localId,
            });
        } catch {
            for (const group of missingGroups) assignGroupResult(results, group, refresh("definitionStale"));
            return await assertAllResultsWithReadyContinuationTx({
                tx,
                accountId: params.accountId,
                results,
            });
        }
        // An Event contribution must declare the exact static schema that
        // validates provider observations; generic JSON validity is not enough.
        if (!event.payloadSchema) {
            for (const group of missingGroups) assignGroupResult(results, group, refresh("definitionStale"));
            return await assertAllResultsWithReadyContinuationTx({
                tx,
                accountId: params.accountId,
                results,
            });
        }
        let payloadValid: boolean;
        try {
            payloadValid = isValidPluginJsonSchemaValue(
                compilePluginJsonSchema(event.payloadSchema),
                input.payload,
            );
        } catch {
            for (const group of missingGroups) assignGroupResult(results, group, refresh("definitionStale"));
            return await assertAllResultsWithReadyContinuationTx({
                tx,
                accountId: params.accountId,
                results,
            });
        }

        const currentTriggers = await loadCurrentEventAdmissionTriggersTx({
            tx,
            accountId: params.accountId,
            triggerIds: missingGroups.map(({ definition }) => definition.triggerId),
        });
        const durablePushCurrentness = hostEvidence.webhookInvocationReference
            ? createRequestLocalDurablePushCurrentnessReads({
                validateInvocation: async () => await validateCurrentPluginWebhookInvocationReferenceTxV1({
                    tx,
                    accountId: params.accountId,
                    reference: hostEvidence.webhookInvocationReference!,
                    serverIdentityId,
                }),
                readEndpoint: async (webhookEndpointId: string) =>
                    await readCurrentAutomationEventDurablePushEndpointTargetTxV1({
                        tx,
                        accountId: params.accountId,
                        webhookEndpointId,
                        caller: params.caller,
                        callerVersion,
                    }),
            })
            : null;
        for (const group of missingGroups) {
            const trigger = currentTriggers.get(group.definition.triggerId);
            const automation = trigger?.automation;
            const sourceContractVersion = trigger?.sourceContractVersion ?? null;
            if (!trigger || trigger.automationId !== group.definition.automationId
                || !automation || !automation.enabled || automation.deletedAt !== null
                || !trigger.enabled || trigger.deletedAt !== null || trigger.kind !== "pluginEvent") {
                assignGroupResult(results, group, skipped("definitionRetired"));
                continue;
            }
            if (trigger.revision !== group.definition.triggerRevision) {
                assignGroupResult(results, group, refresh("definitionStale"));
                continue;
            }
            if (
                trigger.eventPluginId !== input.eventRef.pluginId
                || trigger.eventLocalId !== input.eventRef.localId
                || trigger.sourceSelectorId !== group.definition.sourceSelectorId
                || sourceContractVersion === null
                || sourceContractVersion !== event.automation.source.sourceContractVersion
            ) {
                assignGroupResult(results, group, refresh("observationTargetChanged"));
                continue;
            }
            let durablePushInvocation: Extract<
                PluginWebhookInvocationReferenceValidationResultV1,
                Readonly<{ kind: "ready" }>
            > | null = null;
            if (trigger.observationTransport === "checkpointedPull"
                || trigger.observationTransport === "socket") {
                if (
                    hostEvidence.webhookInvocationReference !== undefined
                    || !selectedWatcherTargetMatchesCaller(trigger, params.caller)
                ) {
                    assignGroupResult(results, group, refresh("observationTargetChanged"));
                    continue;
                }
            } else if (trigger.observationTransport === "durablePush") {
                const webhookEndpointId = trigger.webhookEndpointId;
                const webhookContribution =
                    readCurrentAutomationEventDurablePushWebhookContributionV1(event);
                if (
                    webhookEndpointId === null
                    || webhookContribution === null
                    || webhookContribution.pluginId !== input.eventRef.pluginId
                ) {
                    assignGroupResult(results, group, refresh("observationTargetChanged"));
                    continue;
                }
                if (!durablePushCurrentness) {
                    assignGroupResult(results, group, blocked("temporarilyUnavailable"));
                    continue;
                }
                const validated = await durablePushCurrentness.validateInvocation();
                if (validated.kind !== "ready") {
                    assignGroupResult(results, group, blocked("temporarilyUnavailable"));
                    continue;
                }
                if (
                    validated.webhookEndpointId !== webhookEndpointId
                    || !sameAutomationEventDurablePushWebhookContributionV1(
                        validated.webhookContribution,
                        webhookContribution,
                    )
                    || !validatedWebhookTargetMatchesCaller(validated.target, params.caller)
                ) {
                    assignGroupResult(results, group, refresh("observationTargetChanged"));
                    continue;
                }
                const currentEndpoint = await durablePushCurrentness.readEndpoint(webhookEndpointId);
                if (
                    currentEndpoint === null
                    || !sameAutomationEventDurablePushWebhookContributionV1(
                        currentEndpoint.webhookContribution,
                        webhookContribution,
                    )
                ) {
                    assignGroupResult(results, group, refresh("observationTargetChanged"));
                    continue;
                }
                durablePushInvocation = validated;

                // A durable-push definition only observes deliveries received
                // strictly after its committed observation boundary. The
                // generic webhook owner supplies the original receivedAt
                // timestamp; retry time must never reopen an older delivery.
                const observationStartsAt = trigger.observationStartsAt?.getTime();
                if (observationStartsAt === undefined
                    || input.observationReceivedAt <= observationStartsAt) {
                    assignGroupResult(
                        results,
                        group,
                        observationStartsAt === undefined
                            ? refresh("observationTargetChanged")
                            : skipped("beforeObservationStart"),
                    );
                    continue;
                }
            } else {
                assignGroupResult(results, group, refresh("observationTargetChanged"));
                continue;
            }
            if (!payloadValid) {
                assignGroupResult(results, group, skipped("occurrenceRejected"));
                continue;
            }

            const occurrence = occurrenceByGroupKey.get(group.key)!;
            const { evidence, occurrenceKey } = occurrence;

            if (trigger.definitionEnvelope === null) {
                assignGroupResult(results, group, blocked("temporarilyUnavailable"));
                continue;
            }
            const definitionBinding = readAutomationTriggerDefinitionBinding({
                automationId: automation.id,
                triggerId: trigger.id,
                triggerRevision: trigger.revision,
                triggerKind: trigger.kind,
                triggerEventPluginId: trigger.eventPluginId,
                triggerEventLocalId: trigger.eventLocalId,
                triggerSourceSelectorId: trigger.sourceSelectorId,
            });
            if (definitionBinding === null) {
                assignGroupResult(results, group, blocked("temporarilyUnavailable"));
                continue;
            }
            const outer = validateAutomationTriggerDefinitionEnvelopeOuterForMode({
                raw: trigger.definitionEnvelope,
                mode: "plain",
                binding: definitionBinding,
            });
            const openedDefinition = outer.kind === "available"
                ? openAutomationTriggerDefinitionStoredEnvelopeV1({
                    mode: "plain",
                    binding: definitionBinding,
                    envelope: outer.envelope,
                })
                : null;
            const triggerDefinition = openedDefinition?.kind === "available"
                ? AutomationEventTriggerDefinitionStoredPayloadV1Schema.safeParse(
                    openedDefinition.definition,
                )
                : null;
            if (!triggerDefinition || !triggerDefinition.success) {
                assignGroupResult(results, group, blocked("temporarilyUnavailable"));
                continue;
            }
            if (
                durablePushInvocation !== null
                && (
                    triggerDefinition.data.webhookRoutingSourceInstanceId === undefined
                    || triggerDefinition.data.webhookRoutingSourceInstanceId
                        !== durablePushInvocation.sourceInstanceId
                )
            ) {
                assignGroupResult(results, group, refresh("observationTargetChanged"));
                continue;
            }
            if (!isAutomationEventObservationFreshV1({
                occurredAt: input.occurredAt,
                observationReceivedAt: input.observationReceivedAt,
                maximumObservationAgeMs: triggerDefinition.data.maximumObservationAgeMs,
            })) {
                assignGroupResult(results, group, skipped("outsideFreshness"));
                continue;
            }
            if (!evaluateAutomationEventFilterV1(triggerDefinition.data.filter, input.payload)) {
                assignGroupResult(results, group, skipped("filtered"));
                continue;
            }

            const frozenTriggerEvidence = {
                ...evidence,
                sourceInstanceId: triggerDefinition.data.sourceInstanceId,
                sourceContractVersion,
                observationReceivedAt: input.observationReceivedAt,
                filter: {
                    version: triggerDefinition.data.filter?.v ?? null,
                    result: "matched" as const,
                },
            };
            const triggerEvidenceEnvelope = createCanonicalJsonSigningInput(
                AutomationStoredContentEnvelopeV1Schema.parse({
                    t: "plain",
                    v: frozenTriggerEvidence,
                }),
            );
            candidates.push({
                groupKey: group.key,
                automationId: automation.id,
                triggerId: AutomationTriggerIdSchema.parse(trigger.id),
                triggerRevision: trigger.revision,
                occurrenceKey,
                sourceSelectorId: group.definition.sourceSelectorId,
                occurredAt: new Date(input.occurredAt),
                evidence,
                occurrenceEvidenceEqualityTag: null,
                triggerEvidenceEnvelope: encodePlainAutomationOccurrenceEvidence(evidence),
                executionTriggerEvidenceEnvelope: triggerEvidenceEnvelope,
            });
        }

        const groupsByKey = new Map(groups.map((group) => [group.key, group]));
        const now = new Date();
        const admissions = await admitAutomationRunsTx({
            tx,
            accountId: params.accountId,
            admissions: candidates.map((candidate) => ({
                automationId: candidate.automationId,
                now,
                cause: {
                    kind: "trigger",
                    triggerId: candidate.triggerId,
                    triggerRevision: candidate.triggerRevision,
                    triggerKind: "pluginEvent",
                    occurrenceKey: candidate.occurrenceKey,
                    occurredAt: candidate.occurredAt.getTime(),
                    evidence: {
                        eventRef: input.eventRef,
                        sourceSelectorId: candidate.sourceSelectorId,
                    },
                },
                triggerEvidenceEnvelope: candidate.triggerEvidenceEnvelope,
                executionTriggerEvidenceEnvelope: candidate.executionTriggerEvidenceEnvelope,
                occurrenceEvidenceEqualityTag: candidate.occurrenceEvidenceEqualityTag,
            })),
        });
        for (const [index, candidate] of candidates.entries()) {
            const group = groupsByKey.get(candidate.groupKey)!;
            const admitted = admissions[index]!;
            if (admitted.kind === "ineligible") {
                assignGroupResult(
                    results,
                    group,
                    ineligibleAdmissionResult(admitted.reason),
                );
                continue;
            }
            assignGroupResult(results, group, {
                kind: admitted.kind,
                runId: admitted.run.id,
                checkpointSafe: true,
            });
        }

        return await assertAllResultsWithReadyContinuationTx({
            tx,
            accountId: params.accountId,
            results,
        });
    }));
}
