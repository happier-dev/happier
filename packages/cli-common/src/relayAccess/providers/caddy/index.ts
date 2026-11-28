import { randomUUID } from 'node:crypto';
import { BlockList, isIPv4 } from 'node:net';
import os from 'node:os';
import { observeNativeCaddyContainer } from '../../../machineSetup/nativeCaddy.js';
import { relayAccessProviderDescriptorsById } from '../../catalog.js';
import type { RelayAccessProvider } from '../../types.js';

// https://www.iana.org/assignments/iana-ipv4-special-registry/
const nonPublicIpv4 = new BlockList();
for (const [network, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) nonPublicIpv4.addSubnet(network, prefix, 'ipv4');

const globallyReachableProtocolAddresses = new Set(['192.0.0.9', '192.0.0.10']);
function readCaddyIngressIpv4Candidates(): string[] {
    return [...new Set(Object.values(os.networkInterfaces()).flatMap(interfaces => (interfaces ?? [])
        .filter(({ address, internal }) => !internal && isIPv4(address)
            && (globallyReachableProtocolAddresses.has(address) || !nonPublicIpv4.check(address, 'ipv4')))
        .map(({ address }) => address)))].sort();
}

const generatedSuffix = (address: string) => `.${address.replaceAll('.', '-')}.sslip.io`;

export function readCaddyGeneratedAddressOffer() {
    const candidates = readCaddyIngressIpv4Candidates();
    if (!candidates.length) return { status: 'unavailable', reason: 'ingress_ipv4_unavailable' } as const;
    const label = randomUUID().replaceAll('-', '');
    return { status: 'available', audience: 'public', lifetime: 'temporary',
        choices: candidates.map(ingressIpv4 => ({ hostname: `${label}${generatedSuffix(ingressIpv4)}`, ingressIpv4 })) } as const;
}

export function readCaddyExpectedIngressIpv4(hostname: string): string | null {
    const candidates = readCaddyIngressIpv4Candidates();
    return candidates.find(address => hostname.endsWith(generatedSuffix(address)))
        ?? (candidates.length === 1 ? candidates[0]! : null);
}

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
