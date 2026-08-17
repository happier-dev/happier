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
    type AutomationEventSourcesListInputV1,
    type AutomationEventDeclarationReleaseV1,
    type PluginWebhookInvocationReferenceV1,
} from "@happier-dev/protocol";

import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { listCurrentPluginWebhookEndpointTargetsTxV1 } from "@/app/plugins/webhooks/endpointStore";
import { validateCurrentPluginWebhookInvocationReferenceTxV1 } from "@/app/plugins/webhooks/claimStore";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { inTx } from "@/storage/inTx";

import {
    assertCurrentAutomationEventCallerMaterializationTx,
    readCurrentAutomationEventDurablePushEndpointTargetTxV1,
    readCurrentAutomationEventDurablePushWebhookContributionV1,
    resolveCurrentAutomationEventContributionsTx,
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
    lastAutomationId: string;
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
            || typeof record.lastAutomationId !== "string"
            || record.lastAutomationId.length === 0
        ) return null;
        const parsed: StoredDefinitionCursor = {
            v: 1,
            scope: record.scope,
            revision: record.revision,
            lastAutomationId: record.lastAutomationId,
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
    lastAutomationId?: string;
}>) {
    const base = {
        accountId: params.accountId,
        enabled: true,
        deletedAt: null,
        triggerKind: "pluginEvent" as const,
        triggerEventPluginId: params.caller.pluginId,
        ...(params.lastAutomationId === undefined ? {} : { id: { gt: params.lastAutomationId } }),
    };
    if (params.input.transport.kind === "checkpointedPull") {
        return {
            ...base,
            triggerObservationTransport: "checkpointedPull" as const,
            watcherMachineId: params.caller.machineId,
            watcherMachineInstallationId: params.caller.machineInstallationId,
            watcherPluginId: params.caller.pluginId,
            watcherMaterializationId: params.caller.materializationId,
        };
    }
    return {
        ...base,
        triggerObservationTransport: "durablePush" as const,
        triggerWebhookEndpointId: { in: params.durablePushEndpointIds ?? [] },
    };
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

        if (input.cursor === undefined && input.knownRevision === revision) {
            return AutomationEventStoredDefinitionsReadResultV1Schema.parse({
                kind: "unchanged",
                revision,
                eventDeclarationRelease,
                scope,
            });
        }

        let lastAutomationId: string | undefined;
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
            lastAutomationId = cursor.lastAutomationId;
        }

        const rows = await tx.automation.findMany({
            where: eventDefinitionWhere({
                accountId: params.accountId,
                caller: params.caller,
                input,
                ...(input.transport.kind === "durablePush"
                    ? { durablePushEndpointIds: durablePushEndpoints.map((endpoint) => endpoint.webhookEndpointId) }
                    : {}),
                ...(lastAutomationId === undefined ? {} : { lastAutomationId }),
            }),
            orderBy: [
                { id: "asc" },
                { triggerEventPluginId: "asc" },
                { triggerEventLocalId: "asc" },
            ],
            take: input.pageSize + 1,
            select: {
                id: true,
                templateVersion: true,
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
                templateCiphertext: true,
            },
        });
        const pageRows = rows.slice(0, input.pageSize);
        const contributions = await resolveCurrentAutomationEventContributionsTx({
            tx,
            accountId: params.accountId,
            pluginId: params.caller.pluginId,
            version: callerVersion,
            definitions: pageRows.map((row) => {
                if (row.triggerEventLocalId === null || row.triggerSourceContractVersion === null) {
                    fail("event_contribution_not_current");
                }
                return {
                    eventLocalId: row.triggerEventLocalId,
                    sourceContractVersion: row.triggerSourceContractVersion,
                };
            }),
        });

        const definitions = pageRows.map((row) => {
            if (
                row.triggerEventPluginId !== params.caller.pluginId
                || row.triggerEventLocalId === null
                || row.triggerSourceSelectorId === null
                || row.triggerSourceContractVersion === null
                || row.triggerDefinitionEnvelope === null
            ) fail("event_contribution_not_current");
            const contribution = contributions.get(row.triggerEventLocalId);
            if (!contribution || !contribution.payloadSchema) fail("event_contribution_not_current");
            const observationTransport = input.transport.kind === "checkpointedPull"
                ? (() => {
                    if (
                        row.triggerObservationTransport !== "checkpointedPull"
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
                : (() => {
                    const endpoint = row.triggerWebhookEndpointId === null
                        ? null
                        : durablePushEndpointsById.get(row.triggerWebhookEndpointId) ?? null;
                    const webhookContribution =
                        readCurrentAutomationEventDurablePushWebhookContributionV1(contribution);
                    if (
                        row.triggerObservationTransport !== "durablePush"
                        || endpoint === null
                        || webhookContribution === null
                        || endpoint.webhookContribution.pluginId !== webhookContribution.pluginId
                        || endpoint.webhookContribution.localId !== webhookContribution.localId
                        || row.triggerObservationStartsAt === null
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
                        observationStartsAt: row.triggerObservationStartsAt.getTime(),
                    };
                })();
            const binding = readAutomationTriggerDefinitionBinding({
                automationId: row.id,
                templateVersion: row.templateVersion,
                triggerKind: "pluginEvent",
                triggerEventPluginId: row.triggerEventPluginId,
                triggerEventLocalId: row.triggerEventLocalId,
                triggerSourceSelectorId: row.triggerSourceSelectorId,
            });
            if (binding === null) fail("definition_content_unavailable");
            const envelope = validateAutomationTriggerDefinitionEnvelopeOuterForMode({
                raw: row.triggerDefinitionEnvelope,
                mode: accountFence.account.currentness.encryptionMode,
                binding,
            });
            if (envelope.kind !== "available") fail("definition_content_unavailable");
            return AutomationEventStoredDefinitionProjectionV1Schema.parse({
                automationId: row.id,
                templateVersion: row.templateVersion,
                eventRef: { pluginId: params.caller.pluginId, localId: row.triggerEventLocalId },
                sourceSelectorId: row.triggerSourceSelectorId,
                sourceContractVersion: row.triggerSourceContractVersion,
                observationTransport,
                storedDefinitionEnvelope: envelope.envelope,
                executionRecipe: row.templateCiphertext,
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
                    lastAutomationId: finalRow.id,
                })
                : null,
        });
    });
}
