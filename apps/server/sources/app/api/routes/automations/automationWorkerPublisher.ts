import {
    PluginInstallationPublisherProofError,
    readPluginInstallationPublisherHeader,
    resolvePluginInstallationPublisherProofExpiresAt,
    verifyPluginInstallationPublisherHeader,
    type VerifiedPluginInstallationPublisher,
} from "@/app/plugins/installations/publisherProof";
import { db } from '@/storage/db';

type AutomationWorkerVerifiedPublisher = VerifiedPluginInstallationPublisher & Readonly<{
    /** Test seams may project the already-verified signed request identity. */
    requestNonce?: string;
    proofExpiresAt?: Date;
}>;

export type AutomationWorkerPublisherDependencies = Readonly<{
    verifyPublisher: (params: Parameters<typeof verifyPluginInstallationPublisherHeader>[0]) =>
        Promise<AutomationWorkerVerifiedPublisher | null>;
}>;

export const DEFAULT_AUTOMATION_WORKER_PUBLISHER_DEPENDENCIES: AutomationWorkerPublisherDependencies = {
    verifyPublisher: verifyPluginInstallationPublisherHeader,
};

export type ExactAutomationWorkerPublisher = Readonly<{
    kind: "publisherProof";
    machineId: string;
    machineInstallationId: string;
    requestNonce: string;
    proofExpiresAt: Date;
}>;

/**
 * Binds one worker HTTP request to the exact current machine-installation
 * publisher. Missing or invalid proof never establishes worker authority.
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
            return null;
        }
        throw error;
    }
}

/** The requester bearer owns content; the admitted installation supplies executor identity. */
export async function resolveWorkflowAutomationWorkerPublisher(params: Parameters<typeof resolveExactAutomationWorkerPublisher>[0] & Readonly<{
    runId?: string;
    purpose?: 'admission' | 'claim' | 'custody_refusal';
}>): Promise<ExactAutomationWorkerPublisher | null> {
    const machine = await db.machine.findUnique({ where: { id: params.machineId },
        select: { accountId: true } });
    if (!machine) return null;
    const publisher = await resolveExactAutomationWorkerPublisher({ ...params, accountId: machine.accountId });
    if (!publisher) return null;
    if (params.purpose === 'admission' || params.purpose === 'claim') return publisher;
    const custodyRefusal = params.purpose === 'custody_refusal';
    if (custodyRefusal && params.accountId !== machine.accountId) return null;
    if (!params.runId) return machine.accountId === params.accountId && !custodyRefusal ? publisher : null;
    const assignment = await db.automationRunAssignment.findFirst({ where: {
        machineId: params.machineId,
        ...(params.runId ? { runId: params.runId } : {}),
        OR: [{ admittedMachineInstallationId: publisher.machineInstallationId },
            ...(!custodyRefusal && machine.accountId === params.accountId
                ? [{ admittedMachineInstallationId: null }] : [])],
        run: { ...(custodyRefusal ? {} : { accountId: params.accountId }),
            workflowCustodyState: { not: null } },
    }, select: { runId: true } });
    return assignment ? publisher : null;
}
