import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import type { createNativeComposeGenerationProof } from './nativeComposeGeneration';
import type { NativeComposeActivatedProject, NativeComposeProjectRender } from './nativeComposeLifecycle';

type Generation = Awaited<ReturnType<ReturnType<typeof createNativeComposeGenerationProof>['inspect']>>;
const unavailable = (): never => { throw new PluginError({ code: 'native_failed', message: 'Native Compose generation is unavailable',
    details: { reason: 'deployment_generation_unavailable' } }); };

/** The same native snapshot/launch custody constructs warm and cold handles.
 * This reference lifetime owns observers/files, never a stored activation fact. */
export function createNativeComposeActivatedProject(input: Readonly<{
    current: NativeComposeProjectRender; composeArgs: readonly string[];
    generation: Generation; launch: HostAuthorizedPluginExecLaunch; prefix: readonly string[];
    release(): Promise<void>;
    retire(options: Parameters<NativeComposeActivatedProject['retire']>[0]): Promise<void>;
}>): NativeComposeActivatedProject {
    const { current, generation, launch, prefix } = input;
    const serviceFacts = new Map(current.services.map((service, index) => [service, {
        configuration: current.review.services[index]!, containerImages: generation.serviceContainerImages.get(service)!,
    }]));
    let references = 1;
    let initialReleased = false;
    let released = false;
    const release = async () => {
        references -= 1;
        if (references || released) return;
        released = true;
        await input.release();
    };
    return {
        composeArgs: input.composeArgs, services: current.services, health: generation.health,
        routingGeneration() {
            return { environmentInstanceId: current.environmentInstanceId, engineId: current.engineId,
                projectName: current.projectName, admissionProjectName: current.admissionProjectName, services: generation.routingServices() };
        },
        retire: input.retire,
        nativeIdsForService(service) {
            const ids = generation.serviceNativeIds.get(service);
            if (released || !ids) return unavailable();
            return ids;
        },
        nativeFactsForService(service) {
            const facts = serviceFacts.get(service);
            if (released || !facts) return unavailable();
            return facts;
        },
        isCurrent: () => !released,
        authorizeServiceObserver() {
            if (released) return unavailable();
            references += 1;
            let observerReleased = false;
            return { ...launch, args: [...prefix, ...input.composeArgs], env: { ...launch.env, COMPOSE_DISABLE_ENV_FILE: '1' }, async release() {
                if (observerReleased) return;
                observerReleased = true;
                await release();
            } };
        },
        async dispose() { if (!initialReleased) { initialReleased = true; await release(); } },
    };
}
