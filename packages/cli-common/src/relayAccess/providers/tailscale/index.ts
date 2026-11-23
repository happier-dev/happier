import { relayAccessProviderDescriptorsById } from '../../catalog.js';
import type { RelayAccessProvider } from '../../types.js';
import { resolveTailscaleRelayAccessCommandParams } from './commandParams.js';
import { inspectBuiltinTailscaleAccessProvider } from './inspect.js';

function nativeDependencies(ctx: Parameters<RelayAccessProvider['status']>[0]['ctx']) {
    return {
        ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
        ...(ctx.resolveCommandOnPath ? { resolveCommandOnPath: ctx.resolveCommandOnPath } : {}),
        ...(ctx.readNetworkInterfaces ? { readNetworkInterfaces: ctx.readNetworkInterfaces } : {}),
    };
}

const inspect: NonNullable<RelayAccessProvider['inspect']> = async ({ config, ctx, membershipIntent, ...options }) =>
    inspectBuiltinTailscaleAccessProvider(resolveTailscaleRelayAccessCommandParams(ctx, options), nativeDependencies(ctx),
        membershipIntent ? { intent: membershipIntent,
            hasJoinCredential: config?.credentialRefs.some(ref => ref.purpose === 'network.join') ?? false,
            platform: ctx.platform ?? process.platform } : undefined);

/** Only this native leaf knows Tailscale commands and platform variation.
 * Configuration mutation remains the parent-reviewed P20 recipe program.
 */
export const tailscaleRelayAccessProvider: RelayAccessProvider = {
    descriptor: relayAccessProviderDescriptorsById.tailscale,
    inspect,
    async status(params) {
        const result = await inspect(params);
        if (result.kind !== 'confirmed') return { state: 'unknown', details: result };
        const state = result.facts.state === 'ready' ? 'enabled' : result.facts.state === 'needsAuth' ? 'needs_auth'
            : result.facts.state === 'stopped' ? 'disabled' : 'unknown';
        return { state, details: result.facts };
    },
};
