import { resolveServerFeaturePayload } from './catalog/resolveServerFeaturePayload';
import {
    serverFeatureRegistry,
    type ServerFeatureResolver,
} from './catalog/serverFeatureRegistry';

export type FeatureResolver = ServerFeatureResolver;
export const featureRegistry = serverFeatureRegistry;

export function resolveFeaturesFromEnv(
    env: NodeJS.ProcessEnv,
    resolvers: readonly FeatureResolver[] = featureRegistry,
) {
    return resolveServerFeaturePayload(env, resolvers);
}
