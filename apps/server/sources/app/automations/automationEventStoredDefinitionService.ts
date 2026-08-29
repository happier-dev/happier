import { createHash } from "node:crypto";

import {
    AutomationEventSourcesListInputV1Schema,
    AutomationEventStoredDefinitionProjectionV1Schema,
    AutomationEventStoredDefinitionsReadResultV1Schema,
    PluginWebhookInvocationReferenceV1Schema,
    createCanonicalJsonSigningInput,
    decodeBase64,
    encodeBase64,
    type AutomationEventStoredDefinitionsReadResultV1,
    type AutomationEventCheckpointRetirementCandidateV1,
    type AutomationEventSourcesListInputV1,
    type AutomationEventDeclarationReleaseV1,
    type PluginWebhookInvocationReferenceV1,
} from "@happier-dev/protocol";

import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { listCurrentPluginWebhookEndpointTargetsTxV1 } from "@/app/plugins/webhooks/endpointStore";
import { validateCurrentPluginWebhookInvocationReferenceTxV1 } from "@/app/plugins/webhooks/claimStore";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { inTx, type Tx } from "@/storage/inTx";

import {
    assertCurrentAutomationEventCallerMaterializationTx,
    readCurrentAutomationEventDurablePushEndpointTargetTxV1,
    readCurrentAutomationEventDurablePushWebhookContributionV1,
    resolveCurrentAutomationEventContributionsTx,
    sameAutomationEventDurablePushWebhookContributionV1,
    AutomationEventCurrentnessError,
    type AutomationEventCallerV1,
} from "./automationEventCurrentness";
import {
    readAutomationTriggerDefinitionBinding,
    validateAutomationTriggerDefinitionEnvelopeOuterForMode,
} from "./automationStoredContentRead";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type AutomationEventStoredDefinitionsReadCallerV1 = AutomationEventCallerV1;

export class AutomationEventStoredDefinitionsReadError extends Error {
    readonly code:
        | "caller_materialization_not_current"
        | "event_contribution_not_current"
        | "account_content_unavailable"
        | "catalog_state_unavailable"
        | "definition_content_unavailable"
        | "durable_push_endpoint_context_unavailable";

    constructor(code: AutomationEventStoredDefinitionsReadError["code"]) {
        super(code);
        this.name = "AutomationEventStoredDefinitionsReadError";
        this.code = code;
    }
}

function fail(code: AutomationEventStoredDefinitionsReadError["code"]): never {
    throw new AutomationEventStoredDefinitionsReadError(code);
}

type StoredDefinitionCursor = Readonly<{
    v: 1;
    scope: string;
    revision: string;
    lastTriggerId: string;
}>;

type CurrentDurablePushEndpoint = Readonly<{
    webhookEndpointId: string;
    revision: number;
    webhookContribution: Readonly<{ pluginId: string; localId: string }>;
}>;

function isCanonicalUnsignedRevision(value: unknown): value is string {
    return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function scopeFingerprint(params: Readonly<{
    accountId: string;
    caller: AutomationEventStoredDefinitionsReadCallerV1;
    eventDeclarationRelease: AutomationEventDeclarationReleaseV1;
    input: Pick<AutomationEventSourcesListInputV1, "transport">;
    durablePushEndpoints?: readonly CurrentDurablePushEndpoint[];
}>): string {
    return createHash("sha256")
        .update(createCanonicalJsonSigningInput({
            accountId: params.accountId,
            caller: params.caller,
            eventDeclarationRelease: params.eventDeclarationRelease,
            transport: params.input.transport,
            durablePushEndpoints: params.input.transport.kind === "durablePush"
                ? params.durablePushEndpoints?.map((endpoint) => ({
                    webhookEndpointId: endpoint.webhookEndpointId,
                    revision: endpoint.revision,
                })) ?? []
                : null,
        }), "utf8")
        .digest("base64url");
}

function encodeCursor(cursor: StoredDefinitionCursor): string {
    return encodeBase64(textEncoder.encode(JSON.stringify(cursor)), "base64url");
}

function decodeCursor(cursor: string): StoredDefinitionCursor | null {
    try {
        const bytes = decodeBase64(cursor, "base64url");
        if (encodeBase64(bytes, "base64url") !== cursor) return null;
        const value: unknown = JSON.parse(textDecoder.decode(bytes));
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const record = value as Readonly<Record<string, unknown>>;
        if (
            Object.keys(record).length !== 4
            || record.v !== 1
            || typeof record.scope !== "string"
            || !isCanonicalUnsignedRevision(record.revision)
            || typeof record.lastTriggerId !== "string"
            || record.lastTriggerId.length === 0
        ) return null;
        const parsed: StoredDefinitionCursor = {
            v: 1,
            scope: record.scope,
            revision: record.revision,
            lastTriggerId: record.lastTriggerId,
        };
        return encodeCursor(parsed) === cursor ? parsed : null;
    } catch {
        return null;
    }
}

function eventDefinitionWhere(params: Readonly<{
    accountId: string;
    caller: AutomationEventStoredDefinitionsReadCallerV1;
    input: Pick<AutomationEventSourcesListInputV1, "transport">;
    durablePushEndpointIds?: string[];
    lastTriggerId?: string;
}>) {
    const base = {
        automation: { accountId: params.accountId, enabled: true, deletedAt: null },
        enabled: true,
        deletedAt: null,
        kind: "pluginEvent" as const,
        eventPluginId: params.caller.pluginId,
        ...(params.lastTriggerId === undefined ? {} : { id: { gt: params.lastTriggerId } }),
    };
    if (params.input.transport.kind === "checkpointedPull"
        || params.input.transport.kind === "socket") {
        return {
            ...base,
            observationTransport: params.input.transport.kind,
            watcherMachineId: params.caller.machineId,
            watcherMachineInstallationId: params.caller.machineInstallationId,
            watcherPluginId: params.caller.pluginId,
            watcherMaterializationId: params.caller.materializationId,
        };
    }
    return {
        ...base,
        observationTransport: "durablePush" as const,
        webhookEndpointId: { in: params.durablePushEndpointIds ?? [] },
    };
}

/**
 * The Event catalog owns retirement truth; a provider may only present a
 * bounded persisted checkpoint identity and later apply its incumbent row CAS.
 * A disabled Automation/trigger retains continuity. A retired trigger remains
 * retained exactly while one historical Run still names that trigger ID.
 */
function shouldRetireCheckpoint(params: Readonly<{
    candidate: AutomationEventCheckpointRetirementCandidateV1;
    caller: AutomationEventStoredDefinitionsReadCallerV1;
    trigger: Readonly<{
        id: string;
        automationId: string;
        revision: number;
        enabled: boolean;
        deletedAt: Date | null;
        kind: string;
        eventPluginId: string | null;
        eventLocalId: string | null;
        sourceSelectorId: string | null;
        sourceContractVersion: number | null;
        observationTransport: string | null;
        automation: Readonly<{ enabled: boolean; deletedAt: Date | null }>;
    }> | undefined;
    hasRetainedRun: boolean;
}>): boolean {
    const { trigger, candidate } = params;
    if (trigger === undefined) return !params.hasRetainedRun;
    if (trigger.deletedAt !== null || trigger.automation.deletedAt !== null) {
        return !params.hasRetainedRun;
    }
    if (!trigger.automation.enabled || !trigger.enabled) return false;
    return trigger.automationId !== candidate.automationId
        || trigger.revision !== candidate.triggerRevision
        || trigger.kind !== "pluginEvent"
        || trigger.eventPluginId !== params.caller.pluginId
        || trigger.eventLocalId !== candidate.eventRef.localId
        || trigger.sourceSelectorId !== candidate.sourceSelectorId
        || trigger.sourceContractVersion !== candidate.sourceContractVersion
        || trigger.observationTransport !== "checkpointedPull";
}

async function classifyCheckpointRetirementsTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    caller: AutomationEventStoredDefinitionsReadCallerV1;
    candidates: readonly AutomationEventCheckpointRetirementCandidateV1[];
}>): Promise<readonly AutomationEventCheckpointRetirementCandidateV1[]> {
    if (params.candidates.some((candidate) => candidate.eventRef.pluginId !== params.caller.pluginId)) {
        fail("event_contribution_not_current");
    }
    const triggers = await params.tx.automationTrigger.findMany({
        where: {
            id: { in: params.candidates.map((candidate) => candidate.triggerId) },
            automation: { accountId: params.accountId },
        },
        select: {
            id: true,
            automationId: true,
            revision: true,
            enabled: true,
            deletedAt: true,
            kind: true,
            eventPluginId: true,
            eventLocalId: true,
            sourceSelectorId: true,
            sourceContractVersion: true,
            observationTransport: true,
            automation: { select: { enabled: true, deletedAt: true } },
        },
    });
    const triggersById = new Map(triggers.map((trigger) => [trigger.id, trigger]));
    const retainedRunTriggerIds = new Set((await params.tx.automationRun.findMany({
        where: {
            accountId: params.accountId,
            triggerId: { in: params.candidates.map((candidate) => candidate.triggerId) },
        },
        select: { triggerId: true },
    })).flatMap((run) => run.triggerId === null ? [] : [run.triggerId]));
    return params.candidates.filter((candidate) => shouldRetireCheckpoint({
        candidate,
        caller: params.caller,
        trigger: triggersById.get(candidate.triggerId),
        hasRetainedRun: retainedRunTriggerIds.has(candidate.triggerId),
    }));
}

function webhookInvocationTargetsCaller(
    reference: PluginWebhookInvocationReferenceV1,
    caller: AutomationEventStoredDefinitionsReadCallerV1,
): boolean {
    return reference.target.materialization.pluginId === caller.pluginId
        && reference.target.materialization.machineId === caller.machineId
        && reference.target.machineInstallationId === caller.machineInstallationId
        && reference.target.materialization.materializationId === caller.materializationId;
}

function exactCurrentDurableEndpointMatchesInvocation(
    endpoint: CurrentDurablePushEndpoint | null,
    reference: PluginWebhookInvocationReferenceV1,
): endpoint is CurrentDurablePushEndpoint {
    return endpoint !== null
        && endpoint.webhookEndpointId === reference.endpoint.webhookEndpointId
        && endpoint.revision === reference.endpoint.revision
        && endpoint.webhookContribution.pluginId
            === reference.endpoint.webhookContribution.pluginId
        && endpoint.webhookContribution.localId
            === reference.endpoint.webhookContribution.localId;
}

/**
 * Canonical, caller-scoped private source-definition read. It never projects
 * plaintext to a plugin: it returns only the mode-tagged stored envelope for
 * the exact materialization and leaves unsealing to the Account crypto owner.
 */
export async function readAutomationEventStoredDefinitionsV1(params: Readonly<{
    accountId: string;
    caller: AutomationEventStoredDefinitionsReadCallerV1;
    input: unknown;
    webhookInvocationReference?: unknown;
}>): Promise<AutomationEventStoredDefinitionsReadResultV1> {
    const input = AutomationEventSourcesListInputV1Schema.parse(params.input);
    const parsedWebhookInvocationReference = params.webhookInvocationReference === undefined
        ? null
        : PluginWebhookInvocationReferenceV1Schema.safeParse(params.webhookInvocationReference);
    if (parsedWebhookInvocationReference !== null && !parsedWebhookInvocationReference.success) {
        fail("durable_push_endpoint_context_unavailable");
    }
    const webhookInvocationReference = parsedWebhookInvocationReference?.data;
    if (webhookInvocationReference !== undefined && input.transport.kind !== "durablePush") {
        fail("durable_push_endpoint_context_unavailable");
    }
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);

    return await inTx(async (tx) => {
        let callerVersion: string;
        let eventDeclarationRelease: AutomationEventDeclarationReleaseV1;
        try {
            const current = await assertCurrentAutomationEventCallerMaterializationTx({
                tx,
                accountId: params.accountId,
                serverIdentityId,
                caller: params.caller,
            });
            callerVersion = current.version;
            eventDeclarationRelease = current.eventDeclarationRelease;
        } catch (error) {
            if (error instanceof AutomationEventCurrentnessError) fail(error.code);
            throw error;
        }

        let durablePushEndpoints: readonly CurrentDurablePushEndpoint[] = [];
        if (input.transport.kind === "durablePush") {
            if (webhookInvocationReference !== undefined) {
                const invocation = await validateCurrentPluginWebhookInvocationReferenceTxV1({
                    tx,
                    accountId: params.accountId,
                    reference: webhookInvocationReference,
                    serverIdentityId,
                });
                if (
                    invocation.kind !== "ready"
                    || !webhookInvocationTargetsCaller(webhookInvocationReference, params.caller)
                ) fail("durable_push_endpoint_context_unavailable");
                const endpoint = await readCurrentAutomationEventDurablePushEndpointTargetTxV1({
                    tx,
                    accountId: params.accountId,
                    webhookEndpointId: webhookInvocationReference.endpoint.webhookEndpointId,
                    caller: params.caller,
                    callerVersion,
                });
                if (!exactCurrentDurableEndpointMatchesInvocation(endpoint, webhookInvocationReference)) {
                    fail("durable_push_endpoint_context_unavailable");
                }
                durablePushEndpoints = [endpoint];
            } else {
                durablePushEndpoints = await listCurrentPluginWebhookEndpointTargetsTxV1({
                    tx,
                    accountId: params.accountId,
                    target: {
                        pluginId: params.caller.pluginId,
                        machineId: params.caller.machineId,
                        machineInstallationId: params.caller.machineInstallationId,
                        materializationId: params.caller.materializationId,
                        version: callerVersion,
                    },
                });
            }
        }
        const durablePushEndpointsById = new Map(
            durablePushEndpoints.map((endpoint) => [endpoint.webhookEndpointId, endpoint]),
        );

        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") fail("account_content_unavailable");

        const catalog = await tx.automationEventCatalogState.findUnique({
            where: { accountId: params.accountId },
            select: { eventSourceDefinitionsRevision: true },
        });
        if (!catalog) fail("catalog_state_unavailable");
        const revision = catalog.eventSourceDefinitionsRevision.toString();
        const scope = scopeFingerprint({
            accountId: params.accountId,
            caller: params.caller,
            eventDeclarationRelease,
            input,
            ...(input.transport.kind === "durablePush"
                ? { durablePushEndpoints }
                : {}),
        });

        // Retirement is meaningful only for the revision whose complete source
        // set the observer already adopted. Unlike an ordinary source refresh,
        // a stale retirement request must not fall through to a fresh page: it
        // carries no deletion subset for the provider's Collection CAS.
        if (
            input.checkpointRetirementCandidates !== undefined
            && input.knownRevision !== revision
        ) {
            return AutomationEventStoredDefinitionsReadResultV1Schema.parse({
                kind: "cursorStale",
                currentRevision: revision,
            });
        }
        if (input.cursor === undefined && input.knownRevision === revision) {
            const checkpointRetirements = input.checkpointRetirementCandidates === undefined
                ? undefined
                : await classifyCheckpointRetirementsTx({
                    tx,
                    accountId: params.accountId,
                    caller: params.caller,
                    candidates: input.checkpointRetirementCandidates,
                });
            return AutomationEventStoredDefinitionsReadResultV1Schema.parse({
                kind: "unchanged",
                revision,
                eventDeclarationRelease,
                scope,
                ...(checkpointRetirements === undefined ? {} : { checkpointRetirements }),
            });
        }

        let lastTriggerId: string | undefined;
        if (input.cursor !== undefined) {
            const cursor = decodeCursor(input.cursor);
            if (
                cursor === null
                || cursor.scope !== scope
                || cursor.revision !== revision
            ) {
                return AutomationEventStoredDefinitionsReadResultV1Schema.parse({
                    kind: "cursorStale",
                    currentRevision: revision,
                });
            }
            lastTriggerId = cursor.lastTriggerId;
        }

        const rows = await tx.automationTrigger.findMany({
            where: eventDefinitionWhere({
                accountId: params.accountId,
                caller: params.caller,
                input,
                ...(input.transport.kind === "durablePush"
                    ? { durablePushEndpointIds: durablePushEndpoints.map((endpoint) => endpoint.webhookEndpointId) }
                    : {}),
                ...(lastTriggerId === undefined ? {} : { lastTriggerId }),
            }),
            orderBy: [
                { id: "asc" },
                { eventPluginId: "asc" },
                { eventLocalId: "asc" },
            ],
            take: input.pageSize + 1,
            select: {
                id: true,
                automationId: true,
                revision: true,
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
            },
        });
        const pageRows = rows.slice(0, input.pageSize);
        const contributions = await resolveCurrentAutomationEventContributionsTx({
            tx,
            accountId: params.accountId,
            pluginId: params.caller.pluginId,
            version: callerVersion,
            definitions: pageRows.map((row) => {
                if (row.eventLocalId === null || row.sourceContractVersion === null) {
                    fail("event_contribution_not_current");
                }
                return {
                    eventLocalId: row.eventLocalId,
                    sourceContractVersion: row.sourceContractVersion,
                };
            }),
        });

        const definitions = pageRows.map((row) => {
            if (
                row.eventPluginId !== params.caller.pluginId
                || row.eventLocalId === null
                || row.sourceSelectorId === null
                || row.sourceContractVersion === null
                || row.definitionEnvelope === null
            ) fail("event_contribution_not_current");
            const contribution = contributions.get(row.eventLocalId);
            if (!contribution || !contribution.payloadSchema) fail("event_contribution_not_current");
            const observationTransport = input.transport.kind === "checkpointedPull"
                ? (() => {
                    if (
                        row.observationTransport !== "checkpointedPull"
                        || row.watcherMachineId === null
                        || row.watcherMaterializationId === null
                    ) fail("event_contribution_not_current");
                    return {
                        kind: "checkpointedPull" as const,
                        watcherMaterializationRef: {
                            pluginId: params.caller.pluginId,
                            machineId: row.watcherMachineId,
                            materializationId: row.watcherMaterializationId,
                        },
                    };
                })()
                : input.transport.kind === "socket"
                    ? (() => {
                        if (
                            row.observationTransport !== "socket"
                            || row.watcherMachineId === null
                            || row.watcherMaterializationId === null
                        ) fail("event_contribution_not_current");
                        return {
                            kind: "socket" as const,
                            watcherMaterializationRef: {
                                pluginId: params.caller.pluginId,
                                machineId: row.watcherMachineId,
                                materializationId: row.watcherMaterializationId,
                            },
                        };
                    })()
                    : (() => {
                    const endpoint = row.webhookEndpointId === null
                        ? null
                        : durablePushEndpointsById.get(row.webhookEndpointId) ?? null;
                    const webhookContribution =
                        readCurrentAutomationEventDurablePushWebhookContributionV1(contribution);
                    if (
                        row.observationTransport !== "durablePush"
                        || endpoint === null
                        || webhookContribution === null
                        || !sameAutomationEventDurablePushWebhookContributionV1(
                            endpoint.webhookContribution,
                            webhookContribution,
                        )
                        || row.observationStartsAt === null
                        || row.watcherMachineId !== null
                        || row.watcherMachineInstallationId !== null
                        || row.watcherPluginId !== null
                        || row.watcherMaterializationId !== null
                    ) fail("event_contribution_not_current");
                    return {
                        kind: "durablePush" as const,
                        webhookEndpointId: endpoint.webhookEndpointId,
                        endpointMaterializationRef: {
                            pluginId: params.caller.pluginId,
                            machineId: params.caller.machineId,
                            materializationId: params.caller.materializationId,
                        },
                        observationStartsAt: row.observationStartsAt.getTime(),
                    };
                })();
            const binding = readAutomationTriggerDefinitionBinding({
                automationId: row.automationId,
                triggerId: row.id,
                triggerRevision: row.revision,
                triggerKind: "pluginEvent",
                triggerEventPluginId: row.eventPluginId,
                triggerEventLocalId: row.eventLocalId,
                triggerSourceSelectorId: row.sourceSelectorId,
            });
            if (binding === null) fail("definition_content_unavailable");
            const envelope = validateAutomationTriggerDefinitionEnvelopeOuterForMode({
                raw: row.definitionEnvelope,
                mode: accountFence.account.currentness.encryptionMode,
                binding,
            });
            if (envelope.kind !== "available") fail("definition_content_unavailable");
            return AutomationEventStoredDefinitionProjectionV1Schema.parse({
                automationId: row.automationId,
                triggerId: row.id,
                triggerRevision: row.revision,
                eventRef: { pluginId: params.caller.pluginId, localId: row.eventLocalId },
                sourceSelectorId: row.sourceSelectorId,
                sourceContractVersion: row.sourceContractVersion,
                observationTransport,
                storedDefinitionEnvelope: envelope.envelope,
                payloadSchema: contribution.payloadSchema,
            });
        });
        const finalRow = pageRows.at(-1);
        return AutomationEventStoredDefinitionsReadResultV1Schema.parse({
            kind: "page",
            revision,
            eventDeclarationRelease,
            scope,
            definitions,
            nextCursor: rows.length > input.pageSize && finalRow
                ? encodeCursor({
                    v: 1,
                    scope,
                    revision,
                    lastTriggerId: finalRow.id,
                })
                : null,
        });
    });
}
