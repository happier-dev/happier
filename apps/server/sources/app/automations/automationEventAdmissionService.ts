import {
    AutomationEventAdmitHttpRequestV1Schema,
    AutomationEventAdmitHttpResultV1Schema,
    AutomationEventTriggerDefinitionStoredPayloadV1Schema,
    AutomationStoredContentEnvelopeV1Schema,
    MAX_NON_TERMINAL_AUTOMATIC_RUNS_PER_ACCOUNT,
    compilePluginJsonSchema,
    buildAutomationPluginEventOccurrenceEvidenceV1,
    createCanonicalJsonSigningInput,
    deriveAutomationOccurrenceKeyV1,
    evaluateAutomationEventFilterV1,
    freezeAutomationRunPluginEventExecutionRecipeV1,
    isAutomationEventObservationFreshV1,
    isAutomationEventTriggerEvidenceCiphertextV1,
    isSameAutomationEventDeclarationReleaseV1,
    isValidPluginJsonSchemaValue,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
    parseAutomationRunExecutionRecipeV1,
    validateAutomationRunExecutionRecipeOuterV1,
    type AutomationEventAdmitHostEvidenceV1,
    type AutomationEventAdmitContinuationV1,
    type AutomationEventAdmitHttpInputV1,
    type AutomationEventAdmitItemResultV1,
    type AutomationEventAdmitHttpResultV1,
    type AutomationOccurrenceEvidenceV1,
    type AutomationRunExecutionRecipeV1,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import {
    emitAutomationRunTransition,
    emitAutomationRunUpdatedToMachineOnly,
} from "@/app/automations/automationChangePublisher";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import {
    validateCurrentPluginWebhookInvocationReferenceTxV1,
    type PluginWebhookInvocationReferenceValidationResultV1,
} from "@/app/plugins/webhooks/claimStore";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { afterTx, inTx } from "@/storage/inTx";

import {
    assertCurrentAutomationEventCallerMaterializationTx,
    readCurrentAutomationEventDurablePushEndpointTargetTxV1,
    readCurrentAutomationEventDurablePushWebhookContributionV1,
    resolveCurrentAutomationEventContributionTx,
    AutomationEventCurrentnessError,
    type AutomationEventCallerV1,
    type CurrentAutomationEventContributionV1,
} from "./automationEventCurrentness";
import { fetchAutomationAccountCurrentnessWitnessTx } from "./automationAccountCurrentness";
import { automationRunItemSelect } from "./automationPersistenceSelect";
import {
    classifyPlainAutomationOccurrenceEvidence,
    encodePlainAutomationOccurrenceEvidence,
    findAutomationOccurrenceTx,
    rejoinAutomationOccurrenceInsertRace,
} from "./automationOccurrencePersistence";
import {
    assertAutomationExecutionInputEnvelopeOuterForMode,
    validateAutomationStoredContentEnvelopeOuterForMode,
    readAutomationTriggerDefinitionBinding,
    validateAutomationTriggerDefinitionEnvelopeOuterForMode,
} from "./automationStoredContentRead";
import {
    AUTOMATION_RUN_TERMINAL_STATES,
    initialAutomationExecutionDispatchStateForRun,
    type AutomationRunItem,
} from "./automationTypes";

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
    occurrenceKey: string;
    sourceSelectorId: string;
    originOccurredAt: Date;
    evidence: AutomationOccurrenceEvidenceV1;
    occurrenceEvidenceEqualityTag: string | null;
    triggerEvidenceEnvelope: string;
    executionInputEnvelope: string;
}>;

type EncryptedCandidate = Readonly<{
    resultIndex: number;
    automationId: string;
    occurrenceKey: string;
    sourceSelectorId: string;
    originOccurredAt: Date;
    occurrenceEvidenceEqualityTag: string;
    triggerEvidenceEnvelope: string;
    executionInputEnvelope: string;
}>;

type ExistingOccurrenceRow = Readonly<{
    id: string;
    originKind: string;
    originOccurredAt: Date | null;
    occurrenceKey: string | null;
    originSourceSelectorId: string | null;
    occurrenceEvidenceEqualityTag: string | null;
    triggerEvidenceEnvelope: string | null;
}>;

const existingEventOccurrenceSelect = {
    id: true,
    originKind: true,
    originOccurredAt: true,
    occurrenceKey: true,
    originSourceSelectorId: true,
    occurrenceEvidenceEqualityTag: true,
    triggerEvidenceEnvelope: true,
} satisfies Prisma.AutomationRunSelect;

type DefinitionGroup = Readonly<{
    key: string;
    definition: AutomationEventAdmitHttpInputV1["definitions"][number];
    indexes: readonly number[];
}>;

function blocked(reason: "capacity" | "temporarilyUnavailable" | "occurrenceConflict"):
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

function groupDefinitions(input: AutomationEventAdmitHttpInputV1): readonly DefinitionGroup[] {
    const groups = new Map<string, { definition: AutomationEventAdmitHttpInputV1["definitions"][number]; indexes: number[] }>();
    input.definitions.forEach((definition, index) => {
        const key = [
            definition.automationId,
            definition.templateVersion,
            definition.sourceSelectorId,
        ].join("\u0000");
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
    group: DefinitionGroup,
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
    occurrenceKey: string;
    sourceSelectorId: string;
    evidence: AutomationOccurrenceEvidenceV1;
}>): "match" | "mismatch" | "unavailable" {
    if (
        params.row.originKind !== "pluginEvent"
        || params.row.originOccurredAt?.getTime() !== params.evidence.occurredAt
        || params.row.occurrenceKey !== params.occurrenceKey
        || params.row.originSourceSelectorId !== params.sourceSelectorId
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
    occurrenceKey: string;
    sourceSelectorId: string;
    occurredAt: number;
    occurrenceEvidenceEqualityTag: string;
}>): "match" | "mismatch" | "unavailable" {
    if (
        params.row.originKind !== "pluginEvent"
        || params.row.originOccurredAt?.getTime() !== params.occurredAt
        || params.row.occurrenceKey !== params.occurrenceKey
        || params.row.originSourceSelectorId !== params.sourceSelectorId
        || params.row.triggerEvidenceEnvelope === null
        || params.row.occurrenceEvidenceEqualityTag !== params.occurrenceEvidenceEqualityTag
    ) return "mismatch";
    const outer = validateAutomationStoredContentEnvelopeOuterForMode({
        raw: params.row.triggerEvidenceEnvelope,
        mode: "e2ee",
    });
    if (outer.kind !== "available" || outer.envelope.t !== "encrypted") return "unavailable";
    return isAutomationEventTriggerEvidenceCiphertextV1(outer.envelope.c)
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

function targetTypeForExecutionRecipe(recipe: AutomationRunExecutionRecipeV1): "new_session" | "existing_session" | "execution_run" {
    switch (recipe.target.kind) {
        case "newSession":
            return "new_session";
        case "existingSession":
            return "existing_session";
        case "executionRun":
            return "execution_run";
    }
}

function selectedPullTargetMatchesCaller(
    automation: Readonly<{
        triggerObservationTransport: string | null;
        watcherMachineId: string | null;
        watcherMachineInstallationId: string | null;
        watcherPluginId: string | null;
        watcherMaterializationId: string | null;
    }>,
    caller: AutomationEventAdmissionCallerV1,
): boolean {
    return automation.triggerObservationTransport === "checkpointedPull"
        && automation.watcherMachineId === caller.machineId
        && automation.watcherMachineInstallationId === caller.machineInstallationId
        && automation.watcherPluginId === caller.pluginId
        && automation.watcherMaterializationId === caller.materializationId;
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

function sameWebhookContribution(
    left: Readonly<{ pluginId: string; localId: string }>,
    right: Readonly<{ pluginId: string; localId: string }>,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
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
        const missing: Array<Readonly<{
            index: number;
            definition: typeof params.hostEvidence.definitions[number];
        }>> = [];
        for (const [index, definition] of params.hostEvidence.definitions.entries()) {
            const existing = await findAutomationOccurrenceTx({
                tx,
                accountId: params.accountId,
                automationId: definition.automationId,
                occurrenceKey: definition.occurrenceKey,
                select: existingEventOccurrenceSelect,
            });
            if (existing === null) {
                missing.push({ index, definition });
                continue;
            }
            const disposition = encryptedExistingEvidenceDisposition({
                row: existing,
                occurrenceKey: definition.occurrenceKey,
                sourceSelectorId: definition.sourceSelectorId,
                occurredAt: definition.occurredAt,
                occurrenceEvidenceEqualityTag: definition.occurrenceEvidenceEqualityTag,
            });
            results[index] = disposition === "match"
                ? { kind: "rejoined", runId: existing.id, checkpointSafe: true }
                : blocked(disposition === "mismatch" ? "occurrenceConflict" : "temporarilyUnavailable");
        }

        // Existing immutable occurrences rejoin above, before any mutable
        // definition/currentness decision. Every net-new outcome, including a
        // host-prepared skip, must still prove its adopted Definition is
        // current before it can be checkpoint-safe.
        if (!hostEvidenceIsCurrent) {
            for (const item of missing) results[item.index] = blocked("temporarilyUnavailable");
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
            for (const item of missing) results[item.index] = refresh("definitionStale");
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
            for (const item of missing) results[item.index] = refresh("definitionStale");
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
            for (const item of missing) results[item.index] = refresh("definitionStale");
            return await assertAllResultsWithReadyContinuationTx({
                tx,
                accountId: params.accountId,
                results,
            });
        }

        const candidates: EncryptedCandidate[] = [];
        for (const item of missing) {
            const definition = item.definition;
            const automation = await tx.automation.findFirst({
                where: { id: definition.automationId, accountId: params.accountId },
                select: {
                    id: true,
                    enabled: true,
                    deletedAt: true,
                    templateVersion: true,
                    targetType: true,
                    templateCiphertext: true,
                    triggerKind: true,
                    triggerEventPluginId: true,
                    triggerEventLocalId: true,
                    triggerSourceSelectorId: true,
                    triggerSourceContractVersion: true,
                    triggerObservationTransport: true,
                    triggerWebhookEndpointId: true,
                    triggerObservationStartsAt: true,
                    watcherMachineId: true,
                    watcherMachineInstallationId: true,
                    watcherPluginId: true,
                    watcherMaterializationId: true,
                    triggerDefinitionEnvelope: true,
                },
            });
            if (!automation || !automation.enabled || automation.deletedAt !== null
                || automation.triggerKind !== "pluginEvent") {
                results[item.index] = skipped("definitionRetired");
                continue;
            }
            if (automation.templateVersion !== definition.templateVersion) {
                results[item.index] = refresh("definitionStale");
                continue;
            }
            if (
                automation.triggerEventPluginId !== params.hostEvidence.eventRef.pluginId
                || automation.triggerEventLocalId !== params.hostEvidence.eventRef.localId
                || automation.triggerSourceSelectorId !== definition.sourceSelectorId
                || automation.triggerSourceContractVersion !== definition.sourceContractVersion
                || definition.sourceContractVersion !== event.automation.source.sourceContractVersion
                || automation.triggerObservationTransport !== definition.observationTransport
                || !event.automation.source.supportedObservationTransports.includes(
                    definition.observationTransport,
                )
            ) {
                results[item.index] = refresh("observationTargetChanged");
                continue;
            }

            if (definition.observationTransport === "checkpointedPull") {
                if (
                    params.hostEvidence.webhookInvocationReference !== undefined
                    || !selectedPullTargetMatchesCaller(automation, params.caller)
                ) {
                    results[item.index] = refresh("observationTargetChanged");
                    continue;
                }
            } else if (definition.observationTransport === "durablePush") {
                const webhookEndpointId = automation.triggerWebhookEndpointId;
                const webhookContribution = readCurrentAutomationEventDurablePushWebhookContributionV1(event);
                const reference = params.hostEvidence.webhookInvocationReference;
                if (
                    webhookEndpointId === null
                    || automation.triggerObservationStartsAt === null
                    || webhookContribution === null
                    || webhookContribution.pluginId !== params.hostEvidence.eventRef.pluginId
                ) {
                    results[item.index] = refresh("observationTargetChanged");
                    continue;
                }
                if (!reference) {
                    results[item.index] = blocked("temporarilyUnavailable");
                    continue;
                }
                const validated = await validateCurrentPluginWebhookInvocationReferenceTxV1({
                    tx,
                    accountId: params.accountId,
                    reference,
                    serverIdentityId: params.serverIdentityId,
                });
                if (validated.kind !== "ready") {
                    results[item.index] = blocked("temporarilyUnavailable");
                    continue;
                }
                if (
                    validated.webhookEndpointId !== webhookEndpointId
                    || !sameWebhookContribution(validated.webhookContribution, webhookContribution)
                    || !validatedWebhookTargetMatchesCaller(validated.target, params.caller)
                ) {
                    results[item.index] = refresh("observationTargetChanged");
                    continue;
                }
                const currentEndpoint = await readCurrentAutomationEventDurablePushEndpointTargetTxV1({
                    tx,
                    accountId: params.accountId,
                    webhookEndpointId,
                    caller: params.caller,
                    callerVersion,
                });
                if (
                    currentEndpoint === null
                    || !sameWebhookContribution(currentEndpoint.webhookContribution, webhookContribution)
                ) {
                    results[item.index] = refresh("observationTargetChanged");
                    continue;
                }
            } else {
                results[item.index] = refresh("observationTargetChanged");
                continue;
            }

            if (definition.outcome.kind === "skipped") {
                results[item.index] = skipped(definition.outcome.reason);
                continue;
            }

            if (automation.triggerDefinitionEnvelope === null) {
                results[item.index] = skipped("occurrenceRejected");
                continue;
            }
            const definitionBinding = readAutomationTriggerDefinitionBinding({
                automationId: automation.id,
                templateVersion: automation.templateVersion,
                triggerKind: automation.triggerKind,
                triggerEventPluginId: automation.triggerEventPluginId,
                triggerEventLocalId: automation.triggerEventLocalId,
                triggerSourceSelectorId: automation.triggerSourceSelectorId,
            });
            const definitionOuter = definitionBinding === null
                ? { kind: "contentInvalid" as const }
                : validateAutomationTriggerDefinitionEnvelopeOuterForMode({
                    raw: automation.triggerDefinitionEnvelope,
                    mode: "e2ee",
                    binding: definitionBinding,
                });
            if (definitionOuter.kind !== "available" || definitionOuter.envelope.t !== "encrypted") {
                results[item.index] = skipped("occurrenceRejected");
                continue;
            }

            const suppliedRecipe = parseAutomationRunExecutionRecipeV1(
                definition.outcome.executionRecipe,
            );
            const suppliedOuter = suppliedRecipe.kind === "available"
                ? validateAutomationRunExecutionRecipeOuterV1({
                    recipe: suppliedRecipe.recipe,
                    accountCurrentness: params.hostEvidence.accountCurrentness,
                })
                : { kind: "contentInvalid" as const };
            const triggerEvidence = suppliedOuter.kind === "available"
                ? suppliedOuter.recipe.triggerEvidence
                : null;
            const expectedRecipe = triggerEvidence === null
                ? { kind: "contentInvalid" as const }
                : freezeAutomationRunPluginEventExecutionRecipeV1({
                    definitionRecipe: automation.templateCiphertext,
                    templateVersion: automation.templateVersion,
                    triggerEvidence,
                });
            const expectedTargetType = suppliedOuter.kind === "available"
                ? targetTypeForExecutionRecipe(suppliedOuter.recipe)
                : null;
            if (
                expectedRecipe.kind !== "available"
                || expectedRecipe.serialized !== definition.outcome.executionRecipe
                || suppliedOuter.kind !== "available"
                || expectedTargetType !== automation.targetType
                || triggerEvidence === null
                || triggerEvidence.t !== "encrypted"
                || !isAutomationEventTriggerEvidenceCiphertextV1(triggerEvidence.c)
            ) {
                results[item.index] = skipped("occurrenceRejected");
                continue;
            }
            candidates.push({
                resultIndex: item.index,
                automationId: automation.id,
                occurrenceKey: definition.occurrenceKey,
                sourceSelectorId: definition.sourceSelectorId,
                originOccurredAt: new Date(definition.occurredAt),
                occurrenceEvidenceEqualityTag: definition.occurrenceEvidenceEqualityTag,
                triggerEvidenceEnvelope: createCanonicalJsonSigningInput(triggerEvidence),
                executionInputEnvelope: expectedRecipe.serialized,
            });
        }

        const occupied = await tx.automationRun.count({
            where: {
                accountId: params.accountId,
                originKind: { in: ["pluginEvent", "conversation"] },
                state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] },
            },
        });
        if (occupied + candidates.length > MAX_NON_TERMINAL_AUTOMATIC_RUNS_PER_ACCOUNT) {
            for (const candidate of candidates) results[candidate.resultIndex] = blocked("capacity");
            return await assertAllResultsWithReadyContinuationTx({
                tx,
                accountId: params.accountId,
                results,
            });
        }

        const newRuns: AutomationRunItem[] = [];
        const now = new Date();
        for (const candidate of candidates) {
            const run = await tx.automationRun.create({
                data: {
                    automationId: candidate.automationId,
                    accountId: params.accountId,
                    state: "queued",
                    originKind: "pluginEvent",
                    originOccurredAt: candidate.originOccurredAt,
                    occurrenceKey: candidate.occurrenceKey,
                    occurrenceEvidenceEqualityTag: candidate.occurrenceEvidenceEqualityTag,
                    originSourceSelectorId: candidate.sourceSelectorId,
                    triggerEvidenceEnvelope: candidate.triggerEvidenceEnvelope,
                    executionInputEnvelope: candidate.executionInputEnvelope,
                    executionDispatchState: initialAutomationExecutionDispatchStateForRun(
                        candidate.executionInputEnvelope,
                    ),
                    scheduledAt: now,
                    dueAt: now,
                },
                select: automationRunItemSelect,
            }) as AutomationRunItem;
            results[candidate.resultIndex] = { kind: "admitted", runId: run.id, checkpointSafe: true };
            newRuns.push(run);
        }
        if (newRuns.length > 0) {
            const assignmentRows = await tx.automationAssignment.findMany({
                where: { automationId: { in: newRuns.map((run) => run.automationId) }, enabled: true },
                select: { automationId: true, machineId: true },
            });
            const assignmentsByAutomation = new Map<string, string[]>();
            for (const assignment of assignmentRows) {
                const machines = assignmentsByAutomation.get(assignment.automationId) ?? [];
                machines.push(assignment.machineId);
                assignmentsByAutomation.set(assignment.automationId, machines);
            }
            for (const run of newRuns) {
                const cursor = await markAccountChanged(tx, {
                    accountId: params.accountId,
                    kind: "automation",
                    entityId: run.automationId,
                });
                afterTx(tx, () => {
                    emitAutomationRunTransition({
                        accountId: params.accountId,
                        run,
                        previousState: null,
                        cursor,
                    });
                    for (const machineId of assignmentsByAutomation.get(run.automationId) ?? []) {
                        emitAutomationRunUpdatedToMachineOnly({
                            accountId: params.accountId,
                            machineId,
                            run,
                            cursor,
                        });
                    }
                });
            }
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

        // The canonical Account transition fence serializes automatic-origin
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
            evidence: AutomationOccurrenceEvidenceV1;
            occurrenceKey: string;
        }>>();
        for (const group of groups) {
            const evidence = buildAutomationPluginEventOccurrenceEvidenceV1({
                eventRef: input.eventRef,
                sourceSelectorId: group.definition.sourceSelectorId,
                occurrenceId: input.occurrenceId,
                occurredAt: input.occurredAt,
                payload: input.payload,
            });
            const occurrenceKey = deriveAutomationOccurrenceKeyV1(evidence);
            occurrenceByGroupKey.set(group.key, { evidence, occurrenceKey });
            const existing = await findAutomationOccurrenceTx({
                tx,
                accountId: params.accountId,
                automationId: group.definition.automationId,
                occurrenceKey,
                select: existingEventOccurrenceSelect,
            });
            if (existing === null) {
                missingGroups.push(group);
                continue;
            }
            const disposition = existingEvidenceDisposition({
                row: existing,
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

        for (const group of missingGroups) {
            const automation = await tx.automation.findFirst({
                where: {
                    id: group.definition.automationId,
                    accountId: params.accountId,
                },
                select: {
                    id: true,
                    enabled: true,
                    deletedAt: true,
                    templateVersion: true,
                    targetType: true,
                    templateCiphertext: true,
                    triggerKind: true,
                    triggerEventPluginId: true,
                    triggerEventLocalId: true,
                    triggerSourceSelectorId: true,
                    triggerSourceContractVersion: true,
                    triggerObservationTransport: true,
                    triggerWebhookEndpointId: true,
                    triggerObservationStartsAt: true,
                    watcherMachineId: true,
                    watcherMachineInstallationId: true,
                    watcherPluginId: true,
                    watcherMaterializationId: true,
                    triggerDefinitionEnvelope: true,
                },
            });
            const sourceContractVersion = automation?.triggerSourceContractVersion ?? null;
            if (!automation || !automation.enabled || automation.deletedAt !== null
                || automation.triggerKind !== "pluginEvent") {
                assignGroupResult(results, group, skipped("definitionRetired"));
                continue;
            }
            if (automation.templateVersion !== group.definition.templateVersion) {
                assignGroupResult(results, group, refresh("definitionStale"));
                continue;
            }
            if (
                automation.triggerEventPluginId !== input.eventRef.pluginId
                || automation.triggerEventLocalId !== input.eventRef.localId
                || automation.triggerSourceSelectorId !== group.definition.sourceSelectorId
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
            if (automation.triggerObservationTransport === "checkpointedPull") {
                if (
                    hostEvidence.webhookInvocationReference !== undefined
                    || !selectedPullTargetMatchesCaller(automation, params.caller)
                ) {
                    assignGroupResult(results, group, refresh("observationTargetChanged"));
                    continue;
                }
            } else if (automation.triggerObservationTransport === "durablePush") {
                const webhookEndpointId = automation.triggerWebhookEndpointId;
                const webhookContribution =
                    readCurrentAutomationEventDurablePushWebhookContributionV1(event);
                const reference = hostEvidence.webhookInvocationReference;
                if (
                    webhookEndpointId === null
                    || webhookContribution === null
                    || webhookContribution.pluginId !== input.eventRef.pluginId
                ) {
                    assignGroupResult(results, group, refresh("observationTargetChanged"));
                    continue;
                }
                if (!reference) {
                    assignGroupResult(results, group, blocked("temporarilyUnavailable"));
                    continue;
                }
                const validated = await validateCurrentPluginWebhookInvocationReferenceTxV1({
                    tx,
                    accountId: params.accountId,
                    reference,
                    serverIdentityId,
                });
                if (validated.kind !== "ready") {
                    assignGroupResult(results, group, blocked("temporarilyUnavailable"));
                    continue;
                }
                if (
                    validated.webhookEndpointId !== webhookEndpointId
                    || !sameWebhookContribution(validated.webhookContribution, webhookContribution)
                    || !validatedWebhookTargetMatchesCaller(validated.target, params.caller)
                ) {
                    assignGroupResult(results, group, refresh("observationTargetChanged"));
                    continue;
                }
                const currentEndpoint = await readCurrentAutomationEventDurablePushEndpointTargetTxV1({
                    tx,
                    accountId: params.accountId,
                    webhookEndpointId,
                    caller: params.caller,
                    callerVersion,
                });
                if (
                    currentEndpoint === null
                    || !sameWebhookContribution(
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
                const observationStartsAt = automation.triggerObservationStartsAt?.getTime();
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

            if (automation.triggerDefinitionEnvelope === null) {
                assignGroupResult(results, group, blocked("temporarilyUnavailable"));
                continue;
            }
            const definitionBinding = readAutomationTriggerDefinitionBinding({
                automationId: automation.id,
                templateVersion: automation.templateVersion,
                triggerKind: automation.triggerKind,
                triggerEventPluginId: automation.triggerEventPluginId,
                triggerEventLocalId: automation.triggerEventLocalId,
                triggerSourceSelectorId: automation.triggerSourceSelectorId,
            });
            if (definitionBinding === null) {
                assignGroupResult(results, group, blocked("temporarilyUnavailable"));
                continue;
            }
            const outer = validateAutomationTriggerDefinitionEnvelopeOuterForMode({
                raw: automation.triggerDefinitionEnvelope,
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
            let executionInputEnvelope: string;
            try {
                const frozenRecipe = freezeAutomationRunPluginEventExecutionRecipeV1({
                    definitionRecipe: automation.templateCiphertext,
                    templateVersion: automation.templateVersion,
                    triggerEvidence: AutomationStoredContentEnvelopeV1Schema.parse({
                        t: "plain",
                        v: frozenTriggerEvidence,
                    }),
                });
                if (
                    frozenRecipe.kind !== "available"
                    || targetTypeForExecutionRecipe(frozenRecipe.recipe) !== automation.targetType
                ) {
                    throw new Error("automation_event_execution_recipe_invalid");
                }
                executionInputEnvelope = frozenRecipe.serialized;
                assertAutomationExecutionInputEnvelopeOuterForMode({
                    raw: executionInputEnvelope,
                    mode: "plain",
                    originKind: "pluginEvent",
                });
            } catch {
                assignGroupResult(results, group, blocked("temporarilyUnavailable"));
                continue;
            }
            candidates.push({
                groupKey: group.key,
                automationId: automation.id,
                occurrenceKey,
                sourceSelectorId: group.definition.sourceSelectorId,
                originOccurredAt: new Date(input.occurredAt),
                evidence,
                occurrenceEvidenceEqualityTag: null,
                triggerEvidenceEnvelope: encodePlainAutomationOccurrenceEvidence(evidence),
                executionInputEnvelope,
            });
        }

        const occupied = await tx.automationRun.count({
            where: {
                accountId: params.accountId,
                originKind: { in: ["pluginEvent", "conversation"] },
                state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] },
            },
        });
        if (occupied + candidates.length > MAX_NON_TERMINAL_AUTOMATIC_RUNS_PER_ACCOUNT) {
            const groupsByKey = new Map(groups.map((group) => [group.key, group]));
            for (const candidate of candidates) {
                assignGroupResult(results, groupsByKey.get(candidate.groupKey)!, blocked("capacity"));
            }
            return await assertAllResultsWithReadyContinuationTx({
                tx,
                accountId: params.accountId,
                results,
            });
        }

        const newRuns: AutomationRunItem[] = [];
        const groupsByKey = new Map(groups.map((group) => [group.key, group]));
        const now = new Date();
        for (const candidate of candidates) {
            const run = await tx.automationRun.create({
                data: {
                    automationId: candidate.automationId,
                    accountId: params.accountId,
                    state: "queued",
                    originKind: "pluginEvent",
                    originOccurredAt: candidate.originOccurredAt,
                    occurrenceKey: candidate.occurrenceKey,
                    occurrenceEvidenceEqualityTag: candidate.occurrenceEvidenceEqualityTag,
                    originSourceSelectorId: candidate.sourceSelectorId,
                    triggerEvidenceEnvelope: candidate.triggerEvidenceEnvelope,
                    executionInputEnvelope: candidate.executionInputEnvelope,
                    executionDispatchState: initialAutomationExecutionDispatchStateForRun(
                        candidate.executionInputEnvelope,
                    ),
                    scheduledAt: now,
                    dueAt: now,
                },
                select: automationRunItemSelect,
            }) as AutomationRunItem;
            const group = groupsByKey.get(candidate.groupKey)!;
            assignGroupResult(results, group, { kind: "admitted", runId: run.id, checkpointSafe: true });
            newRuns.push(run);
        }

        if (newRuns.length > 0) {
            const assignmentRows = await tx.automationAssignment.findMany({
                where: {
                    automationId: { in: newRuns.map((run) => run.automationId) },
                    enabled: true,
                },
                select: { automationId: true, machineId: true },
            });
            const assignmentsByAutomation = new Map<string, string[]>();
            for (const assignment of assignmentRows) {
                const machines = assignmentsByAutomation.get(assignment.automationId) ?? [];
                machines.push(assignment.machineId);
                assignmentsByAutomation.set(assignment.automationId, machines);
            }
            for (const run of newRuns) {
                const cursor = await markAccountChanged(tx, {
                    accountId: params.accountId,
                    kind: "automation",
                    entityId: run.automationId,
                });
                afterTx(tx, () => {
                    emitAutomationRunTransition({
                        accountId: params.accountId,
                        run,
                        previousState: null,
                        cursor,
                    });
                    for (const machineId of assignmentsByAutomation.get(run.automationId) ?? []) {
                        emitAutomationRunUpdatedToMachineOnly({
                            accountId: params.accountId,
                            machineId,
                            run,
                            cursor,
                        });
                    }
                });
            }
        }

        return await assertAllResultsWithReadyContinuationTx({
            tx,
            accountId: params.accountId,
            results,
        });
    }));
}
