import {
    PluginInstallationPublisherProofError,
    readPluginInstallationPublisherHeader,
    resolvePluginInstallationPublisherProofExpiresAt,
    verifyPluginInstallationPublisherHeader,
    type VerifiedPluginInstallationPublisher,
} from "@/app/plugins/installations/publisherProof";
import {
    readMachineAvailabilityState,
    type MachineAvailabilityState,
} from "@/app/machines/machineStateGuards";

type AutomationWorkerVerifiedPublisher = VerifiedPluginInstallationPublisher & Readonly<{
    /** Test seams may project the already-verified signed request identity. */
    requestNonce?: string;
    proofExpiresAt?: Date;
}>;

export type AutomationWorkerPublisherDependencies = Readonly<{
    verifyPublisher: (params: Parameters<typeof verifyPluginInstallationPublisherHeader>[0]) =>
        Promise<AutomationWorkerVerifiedPublisher | null>;
    readMachineAvailability?: (params: Readonly<{
        accountId: string;
        machineId: string;
    }>) => Promise<MachineAvailabilityState>;
}>;

export const DEFAULT_AUTOMATION_WORKER_PUBLISHER_DEPENDENCIES: AutomationWorkerPublisherDependencies = {
    verifyPublisher: verifyPluginInstallationPublisherHeader,
    readMachineAvailability: readMachineAvailabilityState,
};

export type ExactAutomationWorkerPublisher =
    | Readonly<{
        kind: "publisherProof";
        machineId: string;
        machineInstallationId: string;
        requestNonce: string;
        proofExpiresAt: Date;
    }>
    | Readonly<{
        kind: "releasedV2Bearer";
        machineId: string;
    }>;

function isReleasedV2AutomationWorkerPath(path: string): boolean {
    return path === "/v2/automations/runs/claim"
        || path === "/v2/automations/daemon/assignments"
        || /^\/v2\/automations\/runs\/[^/]+\/(?:heartbeat|start|succeed|fail)$/.test(path);
}

/**
 * Binds one worker HTTP request to the exact current machine-installation
 * publisher. The sole exception is the missing-header shape emitted by
 * supported released V2 workers: stable `cli-v0.2.1` and preview
 * `cli-v0.2.2-preview.1775586717.26498` both sent only bearer and content-type
 * headers. Their already-verified bearer Account plus the Run/assignment
 * owner's exact Account + machine checks remain the authority; any
 * present-but-invalid publisher proof still fails closed.
 *
 * Remove the exception when no released V2 worker remains supported.
 */
export async function resolveExactAutomationWorkerPublisher(params: Readonly<{
    dependencies: AutomationWorkerPublisherDependencies;
    accountId: string;
    request: Readonly<{
        method?: string;
        headers?: Record<string, string | string[] | undefined>;
        body?: unknown;
    }>;
    path: string;
    machineId: string;
    allowReleasedV2MissingProof?: boolean;
}>): Promise<ExactAutomationWorkerPublisher | null> {
    try {
        const publisher = await params.dependencies.verifyPublisher({
            accountId: params.accountId,
            request: params.request,
            path: params.path,
            required: true,
        });
        if (publisher?.machineId !== params.machineId) return null;
        const header = publisher.requestNonce && publisher.proofExpiresAt
            ? null
            : readPluginInstallationPublisherHeader(params.request.headers);
        if (
            header
            && (
                header.proof.machineId !== publisher.machineId
                || header.proof.installationId !== publisher.installationId
            )
        ) return null;
        const requestNonce = publisher.requestNonce ?? header?.proof.nonce;
        const proofExpiresAt = publisher.proofExpiresAt
            ?? (header ? resolvePluginInstallationPublisherProofExpiresAt(header.proof) : undefined);
        if (!requestNonce || !proofExpiresAt) return null;
        return {
            kind: "publisherProof",
            machineId: publisher.machineId,
            machineInstallationId: publisher.installationId,
            requestNonce,
            proofExpiresAt,
        };
    } catch (error) {
        if (error instanceof PluginInstallationPublisherProofError) {
            if (
                error.code !== "required"
                || params.allowReleasedV2MissingProof !== true
                || !isReleasedV2AutomationWorkerPath(params.path)
            ) return null;
            const available = await (
                params.dependencies.readMachineAvailability
                ?? readMachineAvailabilityState
            )({
                accountId: params.accountId,
                machineId: params.machineId,
            }) === "available";
            return available
                ? { kind: "releasedV2Bearer", machineId: params.machineId }
                : null;
        }
        throw error;
    }
}
