import { runTailscaleCurrentProfileId } from '../../../tailscale/commandRunner.js';
import { relayAccessProviderDescriptorsById } from '../../catalog.js';
import type { RelayAccessProvider } from '../../types.js';
import { resolveTailscaleRelayAccessCommandParams } from './commandParams.js';
import { inspectBuiltinTailscaleAccessProvider } from './inspect.js';
import { tailscaleMembershipPrograms } from './membership.js';
import { classifyRelayAccessDiagnosticCode } from '../../diagnostics.js';
import type { MachineRecipeV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

function nativeDependencies(ctx: Parameters<RelayAccessProvider['status']>[0]['ctx']) {
    return {
        ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
        ...(ctx.resolveCommandOnPath ? { resolveCommandOnPath: ctx.resolveCommandOnPath } : {}),
        ...(ctx.readNetworkInterfaces ? { readNetworkInterfaces: ctx.readNetworkInterfaces } : {}),
    };
}

const inspect: NonNullable<RelayAccessProvider['inspect']> = async ({ ctx, ...options }) =>
    inspectBuiltinTailscaleAccessProvider(resolveTailscaleRelayAccessCommandParams(ctx, options), nativeDependencies(ctx));

/** Only this native leaf knows Tailscale commands and platform variation.
 * Configuration mutation remains the parent-reviewed P20 recipe program.
 */
export const tailscaleRelayAccessProvider: RelayAccessProvider = {
    descriptor: relayAccessProviderDescriptorsById.tailscale,
    inspect,
    async prepareMembership({ role, setupCredentialFile, observed, ctx, ...options }) {
        if (observed.state === 'unknown' || observed.state === 'unavailable') {
            return { ok: false, errorCode: 'provider_unreachable', error: 'provider_unreachable' };
        }
        if (role === 'join' && !setupCredentialFile && observed.state === 'needsAuth') {
            return { ok: false, errorCode: 'needsAuth', error: 'needsAuth' };
        }
        let profileId: string | null;
        try {
            profileId = await runTailscaleCurrentProfileId(resolveTailscaleRelayAccessCommandParams(ctx, options), nativeDependencies(ctx));
        } catch (error) {
            (options.signal ?? options.deadline?.signal)?.throwIfAborted();
            const errorCode = classifyRelayAccessDiagnosticCode(error);
            return { ok: false, errorCode, error: errorCode };
        }
        if (observed.state !== 'needsAuth' && !profileId) {
            return { ok: false, errorCode: 'invalid_provider_output', error: 'invalid_provider_output' };
        }
        const platform = ctx.platform ?? process.platform;
        const switchNetwork = role === 'join' && !!setupCredentialFile && observed.state === 'ready';
        const program: MachineRecipeV1 = tailscaleMembershipPrograms[role];
        const recipe: MachineRecipeV1 = switchNetwork ? { ...program, steps: program.steps.map(step =>
            step.id === 'tailscale-switch' ? { ...step, review: { title: 'Switch Tailscale network',
                description: `Switch this Machine from ${observed.networkIdentity ?? 'the observed profile'} to the network authorized by the selected key. This temporarily disconnects the current profile. A failed authentication leaves it stopped; its saved login is retained.` } } : step) } : program;
        return { ok: true, recipe, inputs: {
            ...(setupCredentialFile ? { setupCredentialFile } : {}),
            switchNetwork,
            // Tailscale's peer-credential operator is not available on Windows.
            // Native install/remedies retain their existing platform owner.
            setOperator: role === 'join' && !!setupCredentialFile && (platform === 'linux' || platform === 'darwin'),
        }, profile: { profileId, networkIdentity: observed.networkIdentity } };
    },
    async status(params) {
        const result = await inspect(params);
        if (result.kind !== 'confirmed') return { state: 'unknown', details: result };
        const state = result.facts.state === 'ready' ? 'enabled' : result.facts.state === 'needsAuth' ? 'needs_auth'
            : result.facts.state === 'stopped' ? 'disabled' : 'unknown';
        return { state, details: result.facts };
    },
};
