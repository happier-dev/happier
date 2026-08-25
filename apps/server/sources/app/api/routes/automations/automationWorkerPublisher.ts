import {
    PluginInstallationPublisherProofError,
    verifyPluginInstallationPublisherHeader,
} from "@/app/plugins/installations/publisherProof";

export type AutomationWorkerPublisherDependencies = Readonly<{
    verifyPublisher: typeof verifyPluginInstallationPublisherHeader;
}>;

export const DEFAULT_AUTOMATION_WORKER_PUBLISHER_DEPENDENCIES: AutomationWorkerPublisherDependencies = {
    verifyPublisher: verifyPluginInstallationPublisherHeader,
};

/** Binds one worker HTTP request to the exact current machine-installation publisher. */
export async function hasExactAutomationWorkerPublisher(params: Readonly<{
    dependencies: AutomationWorkerPublisherDependencies;
    accountId: string;
    request: Readonly<{
        method?: string;
        headers?: Record<string, string | string[] | undefined>;
        body?: unknown;
    }>;
    path: string;
    machineId: string;
}>): Promise<boolean> {
    try {
        const publisher = await params.dependencies.verifyPublisher({
            accountId: params.accountId,
            request: params.request,
            path: params.path,
            required: true,
        });
        return publisher?.machineId === params.machineId;
    } catch (error) {
        if (error instanceof PluginInstallationPublisherProofError) return false;
        throw error;
    }
}
