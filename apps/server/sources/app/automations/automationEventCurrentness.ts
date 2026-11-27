import type { PluginSubjectKindContributionV1 } from '@happier-dev/protocol/plugins/contributions/subjectKinds';
import { type PluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { type AutomationEventDeclarationReleaseV1 } from '@happier-dev/protocol/automations/event';
import { type ParsedPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { readAutomationEligibleEventContributionV1, type AutomationEligibleEventContributionV1 } from '@happier-dev/protocol/plugins/contributions/events';

import { resolveCurrentPluginDeclarationTx } from "@/app/plugins/availability/currentDeclaration";
import { resolveCurrentClaimablePluginMachineMaterializationTx } from "@/app/plugins/availability/operations";
import { readCurrentPluginWebhookEndpointTargetTxV1 } from "@/app/plugins/webhooks/endpointStore";
import type { Tx } from "@/storage/inTx";

export type AutomationEventCallerV1 = Readonly<{
    pluginId: string;
    machineId: string;
    machineInstallationId: string;
    materializationId: string;
    /** Derived from the verified admitted requester root, never HTTP input. */
    materializationAccountId?: string;
    /** Durable host-stamped source custody. */
    sourceCustody: PluginSourceCustodyV1;
}>;

export class AutomationEventCurrentnessError extends Error {
    readonly code: "caller_materialization_not_current" | "event_contribution_not_current";

    constructor(code: AutomationEventCurrentnessError["code"]) {
        super(code);
        this.name = "AutomationEventCurrentnessError";
        this.code = code;
    }
}

function fail(code: AutomationEventCurrentnessError["code"]): never {
    throw new AutomationEventCurrentnessError(code);
}

export type CurrentAutomationEventContributionV1 = AutomationEligibleEventContributionV1 & Readonly<{
    subjectKinds?: readonly PluginSubjectKindContributionV1[];
}>;

/**
 * The current Event declaration is the one source of truth for whether a
 * durable-push source is declared and which webhook contribution it names.
 */
export function readCurrentAutomationEventDurablePushWebhookContributionV1(
    event: CurrentAutomationEventContributionV1,
): Readonly<{ pluginId: string; localId: string }> | null {
    const source = event.automation?.source;
    if (
        event.automation?.eligible !== true
        || !source?.supportedObservationTransports.includes("durablePush")
    ) return null;
    return source.webhookContributionRef ?? null;
}

/**
 * Durable-push endpoint routing and Event declarations use the same qualified
 * webhook contribution identity. Keep that equality at the currentness owner
 * so admission, status, and stored-definition reads cannot drift apart.
 */
export function sameAutomationEventDurablePushWebhookContributionV1(
    left: Readonly<{ pluginId: string; localId: string }>,
    right: Readonly<{ pluginId: string; localId: string }>,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

/**
 * Shared current-target check for Automation durable-push sources. Webhook
 * delivery custody stays with the Webhook claim owner; this only answers
 * whether the stored Automation source still points at the current endpoint
 * target for this host-stamped Event caller.
 */
export async function readCurrentAutomationEventDurablePushEndpointTargetTxV1(params: Readonly<{
    tx: Tx;
    accountId: string;
    webhookEndpointId: string;
    caller: AutomationEventCallerV1;
    callerVersion: string;
    purpose?: "delivery" | "observation";
}>) {
    return await readCurrentPluginWebhookEndpointTargetTxV1({
        tx: params.tx,
        accountId: params.accountId,
        webhookEndpointId: params.webhookEndpointId,
        ...(params.purpose === undefined ? {} : { purpose: params.purpose }),
        target: {
            pluginId: params.caller.pluginId,
            machineId: params.caller.machineId,
            machineInstallationId: params.caller.machineInstallationId,
            materializationId: params.caller.materializationId,
            version: params.callerVersion,
        },
    });
}

export function resolveCurrentAutomationEventContributionFromManifest(params: Readonly<{
    manifest: ParsedPluginManifestV2;
    eventLocalId: string;
    sourceContractVersion?: number;
}>): CurrentAutomationEventContributionV1 {
    const event = readAutomationEligibleEventContributionV1({ events: params.manifest.contributes.events,
        eventLocalId: params.eventLocalId, sourceContractVersion: params.sourceContractVersion });
    if (!event) fail("event_contribution_not_current");
    return { ...event, subjectKinds: params.manifest.contributes.subjectKinds };
}

/**
 * Validates the exact host-stamped plugin materialization once at the shared
 * Automation Event boundary. Source status and occurrence admission consume
 * this same currentness decision rather than resolving plugin inventory again.
 *
 * The caller source custody remains mandatory provenance, but live runtime-slot
 * currentness belongs to the CLI runtime registry and is checked immediately
 * before transport. The server deliberately validates only the persisted
 * materialization/release facts it owns here.
 */
export async function assertCurrentAutomationEventCallerMaterializationTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    serverIdentityId: string;
    caller: Omit<AutomationEventCallerV1, 'sourceCustody'>;
}>): Promise<Readonly<{
    version: string;
    eventDeclarationRelease: AutomationEventDeclarationReleaseV1;
}>> {
    const materializationAccountId = params.caller.materializationAccountId ?? params.accountId;
    const current = await resolveCurrentClaimablePluginMachineMaterializationTx({
        tx: params.tx,
        accountId: materializationAccountId,
        serverIdentityId: params.serverIdentityId,
        machineId: params.caller.machineId,
        machineInstallationId: params.caller.machineInstallationId,
        materializationId: params.caller.materializationId,
        pluginId: params.caller.pluginId,
        requirePersistentMachine: true,
    });
    if (current.kind !== "current") fail("caller_materialization_not_current");
    return {
        version: current.materialization.version,
        eventDeclarationRelease: {
            release: {
                pluginId: current.materialization.pluginId,
                version: current.materialization.version,
            },
            // The selected release archive digest, or the claimed manifest
            // digest of a release-less (bundled/development) declaration.
            archiveDigestSha256: current.declarationDigestSha256,
        },
    };
}

/**
 * AM3/R25: whether this exact installed caller currently declares an Event
 * that completes the admitted Action. The Event declaration owns that relation;
 * a caller that is not current or declares no such Event does not qualify.
 */
export async function doesCurrentAutomationEventCallerCompleteActionTx(params: Readonly<{
    tx: Tx;
    serverIdentityId: string;
    caller: Omit<AutomationEventCallerV1, 'sourceCustody' | 'materializationAccountId'> & Readonly<{ materializationAccountId: string }>;
    actionId: string;
    /** When given, only this Event may be the completing one. */
    eventLocalId?: string;
}>): Promise<boolean> {
    try {
        const current = await assertCurrentAutomationEventCallerMaterializationTx({ tx: params.tx,
            accountId: params.caller.materializationAccountId, serverIdentityId: params.serverIdentityId, caller: params.caller });
        const manifest = await resolveCurrentAutomationEventManifestTx({ tx: params.tx,
            accountId: params.caller.materializationAccountId, pluginId: params.caller.pluginId, version: current.version,
            machineId: params.caller.machineId, machineInstallationId: params.caller.machineInstallationId });
        return manifest.contributes.events.some(event => event.kind === 'event'
            && (params.eventLocalId === undefined || event.id === params.eventLocalId) && event.automation?.eligible === true
            && event.automation.completesActionIds?.some(id => id === params.actionId) === true);
    } catch (error) {
        if (error instanceof AutomationEventCurrentnessError) return false;
        throw error;
    }
}

export async function resolveCurrentAutomationEventManifestTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    version: string;
    machineId: string;
    machineInstallationId: string;
}>): Promise<ParsedPluginManifestV2> {
    const declaration = await resolveCurrentPluginDeclarationTx(params);
    if (!declaration) fail("event_contribution_not_current");
    return declaration.manifest;
}

/**
 * The Event declaration is the only payload-schema and Automation-eligibility
 * owner. Callers pass its qualified local ID; no Automation-local registry or
 * inferred source declaration participates.
 */
export async function resolveCurrentAutomationEventContributionTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    version: string;
    machineId: string;
    machineInstallationId: string;
    eventLocalId: string;
    sourceContractVersion?: number;
}>): Promise<CurrentAutomationEventContributionV1> {
    const manifest = await resolveCurrentAutomationEventManifestTx(params);
    return resolveCurrentAutomationEventContributionFromManifest({
        manifest,
        eventLocalId: params.eventLocalId,
        ...(params.sourceContractVersion === undefined
            ? {}
            : { sourceContractVersion: params.sourceContractVersion }),
    });
}

/**
 * Resolves a finite source-list page against one already-current manifest.
 * The map exists only for this resolution pass; callers must not retain it as
 * a catalog or substitute it for the source-definition owner.
 */
export async function resolveCurrentAutomationEventContributionsTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    version: string;
    machineId: string;
    machineInstallationId: string;
    definitions: readonly Readonly<{
        eventLocalId: string;
        sourceContractVersion: number;
    }>[];
}>): Promise<ReadonlyMap<string, CurrentAutomationEventContributionV1>> {
    const manifest = await resolveCurrentAutomationEventManifestTx(params);
    const resolved = new Map<string, CurrentAutomationEventContributionV1>();
    for (const definition of params.definitions) {
        const current = resolveCurrentAutomationEventContributionFromManifest({
            manifest,
            eventLocalId: definition.eventLocalId,
            sourceContractVersion: definition.sourceContractVersion,
        });
        const prior = resolved.get(definition.eventLocalId);
        if (prior !== undefined && prior.automation.source.sourceContractVersion !== current.automation.source.sourceContractVersion) {
            fail("event_contribution_not_current");
        }
        resolved.set(definition.eventLocalId, current);
    }
    return resolved;
}
