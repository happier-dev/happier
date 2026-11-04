import type { ActionExecutorContext } from '@happier-dev/protocol';
import { DeploymentOwnServerContentV1Schema, type DeploymentOwnServerContentV1, type DeploymentEnvironmentDetailV1, type DeploymentMachineResultV1, type DeploymentSourceIntentV1 } from '@happier-dev/deployment-protocol';
import { createNativeComposeLifecycle } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { createDeploymentSourceMaterializationPort } from './exactCommitRelease';
import type { OwnServerDeploymentRuntime, OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { createOwnServerNativeImageAcquisition } from './nativeImageAcquisition';
import { admitOwnServerDeploymentTargetLink } from './ownServerTargetAdmission';

export const DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE: DeploymentOwnServerContentV1['onFailure'] = 'rollbackAll';

/** Exact-source/image preparation uses the same installed acquisition and native codec as review. */
export async function prepareOwnServerDeploymentCandidate(input: Readonly<{
    environment: DeploymentEnvironmentDetailV1; targetLinkId: string; machineId: string;
    sourceIntent?: DeploymentSourceIntentV1;
    sha?: string;
    stageContent(sourceIntent: DeploymentSourceIntentV1): Promise<string>;
    runtime: OwnServerDeploymentRuntime; context: ActionExecutorContext;
    readReferenceEnvironment?: OwnServerDeploymentTargetHostInput['readEnvironment'];
    machineResults?: readonly DeploymentMachineResultV1[];
}>): Promise<DeploymentOwnServerContentV1> {
    const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
    const { environment } = input;
    const link = environment.targetLinks.find(item => item.targetLink.id === input.targetLinkId)?.targetLink;
    if (!link) return refuse('target_mismatch');
    admitOwnServerDeploymentTargetLink(link, input.machineId, environment.environment.buildMachineId);
    if (!environment.environment.capabilities.deploy) return refuse('deployment_access_denied');
    if (environment.environment.buildMachineId !== input.machineId) return refuse('unsupported');
    if (!input.runtime.acquireCandidate) return refuse('unsupported');
    const runtime = await input.runtime.acquireCandidate({ environmentId: environment.environment.id, targetLinkId: input.targetLinkId,
        ...(input.sourceIntent ? { sourceIntent: input.sourceIntent } : {}), ...(input.sha ? { sha: input.sha } : {}),
        stageContent: input.stageContent, context: input.context, readReferenceEnvironment: input.readReferenceEnvironment }, environment);
    try {
        const port = createDeploymentSourceMaterializationPort({ admit: async () => ({ ...runtime.source,
            assertCurrent: runtime.assertSourceCurrent }) });
        const signal = input.context.signal ?? new AbortController().signal;
        const source = await port.materialize({ environmentId: environment.environment.id, deploymentId: runtime.source.deploymentId }, signal ? { signal } : undefined);
        try {
            const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'build', signal,
                isCurrent: () => !signal?.aborted,
                prepare: ({ phase }: Readonly<{ phase: 'build' | 'runtime'; signal: AbortSignal }>) => prepareEnvironmentSecretBindingsForLaunch({ ...runtime.secrets,
                    environmentId: environment.environment.id, machineId: input.machineId, installationId: source.installationId,
                    phase, bindings: environment.content.bindings, assertCurrent: runtime.assertCurrent }),
            });
            const intent = runtime.sourceIntent;
            const compose = intent.kind === 'repository' ? intent.compose : { ...intent, path: 'compose.yaml' };
            const project = createNativeComposeLifecycle({ kind: 'environmentProject', phase: 'build', exec: runtime.exec, envPort, source,
                ...(runtime.buildExecutionDirectory ? { executionDirectory: runtime.buildExecutionDirectory } : {}),
                files: [compose.path], profiles: compose.profiles, services: compose.services, sourceKind: intent.kind,
                images: [], imageAcquisition: createOwnServerNativeImageAcquisition({ runtime, source,
                    environment: environment.content, targetLinkId: link.id, operation: 'deploy', signal,
                    assertCurrent: runtime.assertCurrent }), storage: { runtimeMachineCount: link.machines.length },
                io: runtime.nativeIo, settleNative: runtime.settleNative });
            try {
                const images = await project.prepareImages({ planOnly: true, signal });
                await runtime.assertCurrent();
                return DeploymentOwnServerContentV1Schema.parse({ sourceIntent: intent, machines: link.machines,
                    buildMachineId: environment.environment.buildMachineId,
                    ...(environment.content.ingress ? { ingress: environment.content.ingress } : {}),
                    onFailure: DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE, images, machineResults: input.machineResults ?? [], steps: [] });
            } finally { await project.dispose(); }
        } finally { await source.abort(); }
    } finally { await runtime.release(); }
}
