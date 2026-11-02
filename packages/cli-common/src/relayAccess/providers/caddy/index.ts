import { observeNativeCaddyContainer } from '../../../machineSetup/nativeCaddy.js';
import { relayAccessProviderDescriptorsById } from '../../catalog.js';
import type { RelayAccessProvider } from '../../types.js';

/** Native availability only; P41 owns Domain routes and P20 owns binding effects. */
const inspect: NonNullable<RelayAccessProvider['inspect']> = async ({ ctx, signal }) => {
    const observed = await observeNativeCaddyContainer({ ...(ctx.env.DOCKER_HOST ? { dockerHost: ctx.env.DOCKER_HOST } : {}) }, {
        signal,
        ...(ctx.runCommand ? { run: async command => {
            const result = await ctx.runCommand!({ command: command.executable, args: command.args, env: ctx.env,
                signal: command.signal ?? signal });
            return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        } } : {}),
    });
    if (observed.status === 'needs_setup') return { kind: 'unknown', code: observed.status };
    if (observed.status === 'unavailable') return { kind: 'unknown', code: observed.reason };
    if (observed.status === 'stopped') return { kind: 'confirmed', facts: { state: 'stopped' } };
    const ports = [...new Set(observed.servers.filter(server => server.tls)
        .flatMap(server => server.endpoints.map(endpoint => endpoint.hostPort)))].sort((left, right) => left - right);
    if (!ports.length) return { kind: 'unknown', code: 'required_fact_unavailable' };
    return { kind: 'confirmed', facts: { state: 'ready', ingress: { https: { hostname: 'custom', ports, paths: true } } } };
};
export const caddyRelayAccessProvider: RelayAccessProvider = {
    descriptor: relayAccessProviderDescriptorsById.caddy!, inspect,
    async status(params) {
        const observed = await inspect(params);
        return observed.kind === 'confirmed'
            ? { state: observed.facts.state === 'ready' ? 'enabled' : 'disabled' }
            : { state: 'unknown', details: { reason: observed.code } };
    },
};
