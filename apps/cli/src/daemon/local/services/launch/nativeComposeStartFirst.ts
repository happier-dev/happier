import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { NativeComposeActivatedProject, NativeComposeEnvironmentProject } from './nativeComposeLifecycle';
import type { MachineNativeEffectContext } from './machineNativeEffectAdmission';

export type NativeComposeRoutingGeneration = Readonly<{
    environmentInstanceId: string;
    engineId: string;
    projectName: string;
    admissionProjectName: string;
    services: readonly Readonly<{
        service: string;
        replicas: readonly Readonly<{ id: string; name: string; networks: readonly string[] }>[];
        stopGracePeriodSeconds: number | undefined;
    }>[];
}>;

export type NativeComposeRouteSwitchResult = Readonly<{ kind: 'switched' }>
    | Readonly<{ kind: 'unknown' | 'conflict' | 'unavailable' | 'cancelled'; reason: string }>;

/** The ingress owner acknowledges its exact route writes. No request counter,
 * wait, retained upstream or second route writer belongs to this native owner. */
export type NativeComposeStartFirstRoutes = Readonly<{
    switch(input: Readonly<{ candidate: NativeComposeRoutingGeneration; incumbent: NativeComposeRoutingGeneration;
        signal?: AbortSignal }>): Promise<NativeComposeRouteSwitchResult>;
}>;
export type NativeComposeStartFirstInput = Readonly<{
    render: Parameters<NativeComposeEnvironmentProject['activate']>[0]['render'];
    context: MachineNativeEffectContext;
    incumbent: NativeComposeActivatedProject;
    /** Retained generation observed by this deterministic native owner. Omit
     * for the normal candidate start; stable projects require this witness. */
    target?: NativeComposeActivatedProject;
    routes: NativeComposeStartFirstRoutes;
    signal?: AbortSignal;
}>;
export type NativeComposeStartFirstResult = Readonly<{ kind: 'activated'; activation: NativeComposeActivatedProject }>
    | Readonly<{ kind: 'route_not_switched'; activation: NativeComposeActivatedProject;
        route: Exclude<NativeComposeRouteSwitchResult, { kind: 'switched' }> }>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = (): never => { throw new PluginError({ code: 'native_failed', message: 'Start-first is unavailable for this native configuration',
    details: { reason: 'deployment_start_first_unavailable' } }); };

/** R25 physical-generation eligibility consumes native Compose and proven image
 * CONFIG. Writable mount classification stays at nativeComposeStorage. */
export function assertNativeComposeStartFirstConfiguration(model: Record<string, unknown>,
    imageConfigs: ReadonlyMap<string, Record<string, unknown>>): void {
    for (const [service, definition] of Object.entries(record(model.services) ? model.services : {})) {
        if (!record(definition)) return unavailable();
        const config = imageConfigs.get(service)?.config;
        const imageHealth = record(config) && record(config.Healthcheck) ? config.Healthcheck : undefined;
        const health = record(definition.healthcheck) ? definition.healthcheck : undefined;
        const test = health?.test ?? imageHealth?.Test;
        if (health?.disable === true || !Array.isArray(test) || !test.length || test[0] === 'NONE'
            || definition.container_name !== undefined || definition.network_mode === 'host'
            || Array.isArray(definition.ports) && definition.ports.some(port => record(port)
                && port.published !== undefined && port.published !== '' && String(port.published) !== '0')
            || record(definition.networks) && Object.values(definition.networks).some(network => record(network)
                && (network.ipv4_address !== undefined || network.ipv6_address !== undefined))) return unavailable();
    }
}

/** Consumes the existing activation/readiness and exact-generation retirement
 * owners. Unknown writes retain both generations for the next admission. */
export async function activateNativeComposeStartFirst(input: NativeComposeStartFirstInput,
    activate: NativeComposeEnvironmentProject['activate']): Promise<NativeComposeStartFirstResult> {
    const signal = input.signal ?? input.context.operation.signal;
    signal?.throwIfAborted();
    const incumbent = input.incumbent.routingGeneration();
    if (incumbent.environmentInstanceId !== input.render.environmentInstanceId
        || incumbent.engineId !== input.render.engineId
        || incumbent.admissionProjectName !== input.render.admissionProjectName
        || incumbent.projectName === input.render.projectName) {
        throw new PluginError({ code: 'native_failed', message: 'Native Compose generation is unavailable',
            details: { reason: 'deployment_generation_unavailable' } });
    }
    const activation = input.target ?? await activate({ render: input.render, context: input.context, ...(signal ? { signal } : {}), cleanupOnFailure: true });
    if (activation.health !== 'healthy') return unavailable();
    const candidate = activation.routingGeneration();
    if (input.target && (candidate.environmentInstanceId !== input.render.environmentInstanceId || candidate.engineId !== input.render.engineId
        || candidate.admissionProjectName !== input.render.admissionProjectName || candidate.projectName !== input.render.projectName)) {
        throw new PluginError({ code: 'native_failed', message: 'Native Compose generation is unavailable',
            details: { reason: 'deployment_generation_unavailable' } });
    }
    signal?.throwIfAborted();
    const route = await input.routes.switch({ candidate, incumbent, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    if (route.kind !== 'switched') return { kind: 'route_not_switched', activation, route };
    // Owner ruling 2026-10-31: Docker consumes each incumbent's StopTimeout.
    // A request exceeding that native grace can be cut; no Happier deadline.
    await input.incumbent.retire({ context: input.context, ...(signal ? { signal } : {}) });
    return { kind: 'activated', activation };
}
