import type { NativeComposeRoutingGeneration, NativeComposeStartFirstRoutes } from '@/daemon/local/services/launch/nativeComposeStartFirst';
import type { createNativeCaddyRoutes, NativeCaddyStartFirstLeg } from './nativeCaddyRoutes';
export type { NativeCaddyStartFirstLeg } from './nativeCaddyRoutes';

/** L5 supplies affected native placements/bindings; P30 retains generation and stop ownership. */
export function createNativeCaddyStartFirstRoutes(input: Readonly<{
    routes: ReturnType<typeof createNativeCaddyRoutes>;
    legs: readonly NativeCaddyStartFirstLeg[];
}>): NativeComposeStartFirstRoutes {
    const replicasFor = (leg: NativeCaddyStartFirstLeg, generation: NativeComposeRoutingGeneration): readonly [string, ...string[]] | undefined => {
        const replicas = generation.services.find(service => service.service === leg.route.domain.target.service)?.replicas;
        const [first, ...rest] = replicas?.map(replica => replica.name) ?? [];
        if (first === undefined) return;
        return [first, ...rest];
    };
    return { async switch({ candidate, incumbent, signal }) {
        for (const leg of input.legs) {
            const previous = replicasFor(leg, incumbent), route = replicasFor(leg, candidate);
            if (!previous || !route) return { kind: 'unavailable', reason: 'native_route_unavailable' };
            const result = await input.routes.switchReplicas({ placement: leg.placement, route: leg.route,
                expectedReplicaNames: previous, candidateReplicaNames: route, ...(signal ? { signal } : {}) });
            if (result.kind === 'active') continue;
            if (result.kind === 'absent') return { kind: 'unavailable', reason: 'native_route_unavailable' };
            return result;
        }
        return { kind: 'switched' };
    } };
}
