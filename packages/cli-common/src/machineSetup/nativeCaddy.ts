import type { MachineRecipeStepV1, MachineSetupApplyResultV1 } from './index.js';
import { machineStateRootStep } from './stateRoot.js';
import { runMachineSetupNativeCommand, type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from './nativeBackend.js';
import { isIP } from 'node:net';
import { dirname, join, posix } from 'node:path';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import type { MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { MachineFirewallTransitionBindingsV1 } from '@happier-dev/protocol/machines/setup/machineFirewallV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

export type NativeCaddyFirewallExposure = NonNullable<Extract<MachineRecipeStepV1, { kind: 'firewall' }>['exposures']>[number];
export type NativeCaddySetupInput = Readonly<{
    dockerHost?: string; containerName: string;
    /** Durable host paths: adminDirectory is mounted at /run only inside Caddy. */
    stateDirectory: string; adminDirectory: string;
    daemonGroup: string; daemonGroupId: number; initialConfig: string; originPort: number;
    routedNetworks: readonly string[];
    privateBinding?: Readonly<{ exposure: NativeCaddyFirewallExposure; interfaceName: string; sourceRanges: readonly string[] }>;
    publicBindings?: readonly NativeCaddyFirewallExposure[];
}>;
export type NativeCaddyContainerResult = Readonly<{ status: 'ready'; containerId: string }>
    | Readonly<{ status: 'needs_setup' }>
    | Readonly<{ status: 'unavailable'; reason: 'foreign_effect_conflict' | 'required_fact_unavailable' | 'private_scope_unenforceable' | 'native_effect_failed'; details?: NativeCaddyFailureDetails }>;
type NativeCaddyFailureDetails = Readonly<{
    failure: Readonly<{ kind: 'native_observation_unavailable' | 'native_effect_failed';
        reason: 'required_fact_unavailable' | 'native_effect_failed'; requiredFact: keyof typeof caddyFactRemedies; errorCode?: string }>;
    remedy: string;
}>;
const caddyFactRemedies = {
    caddyContainer: 'Restore access to the selected Docker engine and inspect the owned Caddy container before retrying.',
    caddyMountedSeed: 'Restore daemon-group read access to the owned Caddy seed and its mounted state directory before retrying.',
    caddyAdminSocket: 'Configure the owned Caddy admin API on its mounted Unix socket, with daemon-group access, before retrying.',
    caddyAdminConfig: 'Check Caddy startup and daemon-group access to its mounted Unix admin socket. Retry the Domain action after Caddy serves its live configuration; preserve the owned container for reconciliation.',
    caddyPublishedBindings: 'Restore Docker observation of the owned Caddy TCP publications before retrying.',
    caddyListeners: 'Inspect the live Caddy HTTP listener configuration before retrying.',
};
function caddyFactUnavailable(requiredFact: keyof typeof caddyFactRemedies, error?: unknown) {
    const code = typeof error === 'string' ? error : object(error)?.code;
    const errorCode = typeof code === 'string' && /^(?:E[A-Z]+|HTTP_\d{3})$/.test(code) ? code : undefined;
    return { status: 'unavailable' as const, reason: 'required_fact_unavailable' as const, details: {
        failure: { kind: 'native_observation_unavailable' as const, reason: 'required_fact_unavailable' as const,
            requiredFact, ...(errorCode ? { errorCode } : {}) },
        remedy: `Required fact ${requiredFact} is unavailable. ${caddyFactRemedies[requiredFact]}`,
    } };
}
export const nativeCaddyImage = 'docker.io/library/caddy@sha256:c3d7ee5d2b11f9dc54f947f68a734c84e9c9666c92c88a7f30b9cba5da182adb';
/** caddy@1's reviewed default, not a workload port or a port allocator. */
export const nativeCaddyProfile = {
    id: 'caddy', revision: 1, containerName: 'happier-caddy',
    stateDirectory: '/var/lib/happier/caddy', adminDirectory: '/run/happier-caddy',
    portRequirement: { id: 'caddy-private-origin', exposure: 'privateNetwork', protocol: 'tcp',
        containerPort: 8080, hostPort: 8080 },
    publicPortRequirements: [
        { id: 'caddy-public-http', exposure: 'public', protocol: 'tcp', containerPort: 80, hostPort: 80 },
        { id: 'caddy-public-https', exposure: 'public', protocol: 'tcp', containerPort: 443, hostPort: 443 },
    ],
} as const;

export function createNativeCaddySetupInput(input: Readonly<{
    daemonGroup: string; daemonGroupId: number; routedNetworks: readonly string[]; initialConfig: string;
    bindings: Pick<NativeCaddySetupInput, 'privateBinding' | 'publicBindings'>;
}>): NativeCaddySetupInput {
    const profile = nativeCaddyProfile;
    return { containerName: profile.containerName, stateDirectory: profile.stateDirectory, adminDirectory: profile.adminDirectory,
        daemonGroup: input.daemonGroup, daemonGroupId: input.daemonGroupId,
        originPort: profile.portRequirement.containerPort, routedNetworks: input.routedNetworks, ...input.bindings,
        initialConfig: input.initialConfig,
    };
}

export function createCaddyContainerSetupSteps(input: NativeCaddySetupInput,
    options: Readonly<{ previousInitialConfig?: string }> = {}): MachineRecipeStepV1[] {
    return [
        { ...machineStateRootStep, path: dirname(input.stateDirectory) },
        { id: 'caddy-state-directory', kind: 'directory', path: input.stateDirectory, owner: 'root', group: input.daemonGroup, mode: 0o750 },
        ...['data', 'config', 'logs'].map((name): MachineRecipeStepV1 => ({
            id: `caddy-${name}-directory`, kind: 'directory', path: join(input.stateDirectory, name), owner: 'root', group: 'root', mode: 0o700,
        })),
        { id: 'caddy-admin-directory', kind: 'directory', path: input.adminDirectory, owner: 'root', group: input.daemonGroup, mode: 0o750 },
        { id: 'caddy-initial-config', kind: 'file', path: join(input.stateDirectory, 'initial.json'), owner: 'root', group: input.daemonGroup, mode: 0o640,
            ...(options.previousInitialConfig !== undefined ? {
                expectedContentDigest: createHash('sha256').update(options.previousInitialConfig).digest('hex'),
            } : {}),
            content: { kind: 'literal', value: input.initialConfig } },
    ];
}
/** Declarations for the existing firewall owner, never evidence of enforcement. */
export function readCaddyContainerFirewallExposures(input: Pick<NativeCaddySetupInput, 'publicBindings' | 'privateBinding'>): NativeCaddyFirewallExposure[] {
    return [...(input.privateBinding ? [input.privateBinding.exposure] : []), ...(input.publicBindings ?? [])];
}

export function createNativeCaddyBindings(input: Readonly<{ originPort: number; exposures: readonly NativeCaddyFirewallExposure[];
    privateNetworks: readonly MachinePrivateNetworkObservationV1[] }>): Readonly<{ status: 'ready'; privateBinding?: NativeCaddySetupInput['privateBinding']; publicBindings: readonly NativeCaddyFirewallExposure[] }>
    | Readonly<{ status: 'unavailable'; reason: 'private_scope_unenforceable' | 'required_fact_unavailable' }> {
    const publicBindings = input.exposures.filter(exposure => exposure.exposure === 'public');
    if (publicBindings.some(exposure => (exposure.containerPort ?? exposure.hostPort) === input.originPort)) {
        return { status: 'unavailable', reason: 'private_scope_unenforceable' };
    }
    const privateExposures = input.exposures.filter(exposure => exposure.exposure === 'privateNetwork');
    if (!privateExposures.length) return { status: 'ready', publicBindings };
    // The setup owner's one selected private binding cannot represent several
    // different reviewed binds. Refuse ambiguity instead of dropping a bind.
    if (privateExposures.length !== 1) return { status: 'unavailable', reason: 'private_scope_unenforceable' };
    const exposure = privateExposures[0]!;
    const network = input.privateNetworks.find(network => network.state === 'ready'
        && privateProviderId(network) === exposure.providerId && network.networkIdentity === exposure.networkIdentity
        && network.addresses.includes(exposure.hostAddress));
    if ((exposure.containerPort ?? exposure.hostPort) !== input.originPort || exposure.protocol !== 'tcp'
        || !network?.interfaceName || !network.sourceRanges.length || ['0.0.0.0', '::'].includes(exposure.hostAddress)) {
        return { status: 'unavailable', reason: 'private_scope_unenforceable' };
    }
    return { status: 'ready', publicBindings, privateBinding: {
        exposure, interfaceName: network.interfaceName, sourceRanges: network.sourceRanges,
    } };
}

export type NativeCaddyPublishedEndpoint = Readonly<{ hostAddress: string; hostPort: number; containerPort: number }>;
export type NativeCaddyAdminExchange = (request: Readonly<{
    method: 'GET' | 'PUT' | 'PATCH' | 'DELETE'; path: string; value?: unknown; etag?: string; signal?: AbortSignal;
}>) => Promise<Readonly<{ status: number; value?: unknown; etag?: string }>>;
export type NativeCaddyServerObservation = Readonly<{
    serverId: string; listen: readonly string[]; tls: boolean; automaticHttpsDisabled: boolean;
    endpoints: readonly NativeCaddyPublishedEndpoint[];
}>;
export type NativeCaddyObservationResult = Readonly<{
    status: 'ready'; containerId: string; containerName: string; adminSocketPath: string;
    networkNames: readonly string[]; servers: readonly NativeCaddyServerObservation[];
    /** Plain listeners reachable by a connector on the observed primary network. */
    containerOrigins?: readonly Readonly<{ serverId: string; networkName: string; service: string }>[];
    privateOrigins?: readonly Readonly<{ serverId: string; endpoint: string; network: MachinePrivateNetworkObservationV1 }>[];
}> | Readonly<{ status: 'needs_setup' }> | Readonly<{ status: 'stopped'; containerId: string }>
    | Readonly<{ status: 'unavailable'; reason: 'required_fact_unavailable' | 'foreign_effect_conflict'; details?: NativeCaddyFailureDetails }>;
type NativeOptions = Readonly<{ run?: (command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>; signal?: AbortSignal }>;
type ContainerInput = Readonly<{ dockerHost?: string; containerName?: string }>;

/** Caddy v2.10.2 reads non-TTY stdin through LF and removes only that LF.
 * The admitted owned container supplies bcrypt defaults; no secret enters argv. */
export async function hashNativeCaddyPassword(input: Readonly<{ dockerHost?: string; containerId: string; password: string }>,
    options: NativeOptions = {}): Promise<Readonly<{ status: 'ready'; bcryptHash: string }>
    | Readonly<{ status: 'unavailable'; reason: 'domain_credential_unavailable' | 'native_effect_failed' }>> {
    options.signal?.throwIfAborted();
    if (!input.password || input.password.includes('\n')) return { status: 'unavailable', reason: 'domain_credential_unavailable' };
    const bytes = Buffer.from(input.password + '\n', 'utf8');
    try {
        const result = await nativeDocker(input, options)(['exec', '--interactive', input.containerId,
            'caddy', 'hash-password', '--algorithm', 'bcrypt'], bytes);
        if (result.code !== 0) return { status: 'unavailable', reason: 'native_effect_failed' };
        const bcryptHash = result.stdout.replace(/\r?\n$/, '');
        if (!/^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/.test(bcryptHash)) {
            return { status: 'unavailable', reason: 'domain_credential_unavailable' };
        }
        return { status: 'ready', bcryptHash };
    } catch {
        options.signal?.throwIfAborted();
        return { status: 'unavailable', reason: 'native_effect_failed' };
    } finally { bytes.fill(0); }
}

/** The caller owns one P30 admission and supplies the captured owned container
 * and actual service-generation networks. Setup and route activation share it. */
export async function connectNativeCaddyNetworks(input: Readonly<{ dockerHost?: string; containerId: string;
    observedNetworkNames: readonly string[]; networkNames: readonly string[] }>, options: NativeOptions = {}): Promise<Readonly<{ status: 'ready' }>
    | Readonly<{ status: 'unavailable'; reason: 'native_effect_failed' }>> {
    const run = nativeDocker(input, options);
    for (const network of new Set(input.networkNames)) {
        if (input.observedNetworkNames.includes(network)) continue;
        if ((await run(['network', 'connect', network, input.containerId])).code !== 0) {
            return { status: 'unavailable', reason: 'native_effect_failed' };
        }
    }
    return { status: 'ready' };
}

const ownerLabel = 'dev.happier.machine-setup.recipe';
const ownerValue = 'caddy@1';
const command = ['caddy', 'run', '--resume', '--config', '/etc/caddy/happier.json'];
function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function privateProviderId(network: MachinePrivateNetworkObservationV1): string {
    return 'kind' in network.provider ? network.provider.id : buildQualifiedPluginContributionKey(network.provider);
}
function nativeDocker(input: ContainerInput, options: NativeOptions) {
    return (args: readonly string[], inputBytes?: Uint8Array) => {
        options.signal?.throwIfAborted();
        return (options.run ?? runMachineSetupNativeCommand)({ executable: 'docker', args: [...(input.dockerHost === undefined ? [] : ['--host', input.dockerHost]), ...args],
            ...(options.signal ? { signal: options.signal } : {}), ...(inputBytes ? { inputBytes } : {}) });
    };
}
type OwnedContainer = Readonly<{ status: 'observed'; containerId: string; containerName: string; config: Record<string, unknown>; host: Record<string, unknown>;
    running: boolean; networks: Record<string, unknown>; ports: unknown }>;
async function inspectOwnedContainer(input: ContainerInput, run: ReturnType<typeof nativeDocker>): Promise<OwnedContainer
    | Readonly<{ status: 'needs_setup' }> | Readonly<{ status: 'unavailable'; reason: 'required_fact_unavailable' | 'foreign_effect_conflict' }>> {
    const unavailable = { status: 'unavailable', reason: 'required_fact_unavailable' } as const;
    const filter = input.containerName === undefined ? `label=${ownerLabel}=${ownerValue}`
        : `name=^/${input.containerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    const listed = await run(['container', 'ls', '--all', '--no-trunc', '--filter', filter, '--format', '{{json .ID}}']);
    if (listed.code !== 0) return unavailable;
    let ids: unknown[];
    try { ids = listed.stdout.trim() ? listed.stdout.trim().split('\n').map(line => JSON.parse(line)) : []; }
    catch { return unavailable; }
    if (ids.length > 1 || ids.some(id => typeof id !== 'string' || !id)) return unavailable;
    if (!ids.length) return { status: 'needs_setup' };
    const inspected = await run(['container', 'inspect', '--', String(ids[0])]);
    if (inspected.code !== 0) return unavailable;
    let raw: unknown;
    try { raw = JSON.parse(inspected.stdout); } catch { return unavailable; }
    const state = Array.isArray(raw) && raw.length === 1 ? object(raw[0]) : undefined;
    const config = object(state?.Config), host = object(state?.HostConfig), status = object(state?.State);
    const nativeNetwork = object(state?.NetworkSettings), networks = object(nativeNetwork?.Networks);
    if (!state || typeof state.Id !== 'string' || typeof state.Name !== 'string' || !state.Name.startsWith('/') || state.Name.length === 1
        || !config || !host || !status || typeof status.Running !== 'boolean' || !networks) return unavailable;
    if (object(config.Labels)?.[ownerLabel] !== ownerValue || config.Image !== nativeCaddyImage
        || JSON.stringify(config.Cmd) !== JSON.stringify(command)
        || object(host.RestartPolicy)?.Name !== 'unless-stopped' || Array.isArray(host.Binds) && host.Binds.length > 0
        || !Array.isArray(host.Mounts)) return { status: 'unavailable', reason: 'foreign_effect_conflict' };
    return { status: 'observed', containerId: state.Id, containerName: state.Name.slice(1), config, host, running: status.Running, networks, ports: nativeNetwork?.Ports };
}

function mountedPath(host: Record<string, unknown>, containerPath: string): string | undefined {
    if (!posix.isAbsolute(containerPath)) return;
    const matches = (Array.isArray(host.Mounts) ? host.Mounts : []).flatMap(value => {
        const mount = object(value);
        if (mount?.Type !== 'bind' || typeof mount.Source !== 'string' || typeof mount.Target !== 'string') return [];
        const relative = posix.relative(mount.Target, containerPath);
        return relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative) ? []
            : [{ target: mount.Target, path: join(mount.Source, relative) }];
    }).sort((left, right) => right.target.length - left.target.length);
    return matches[0]?.path;
}
function adminSocket(host: Record<string, unknown>, config: Record<string, unknown>): string | undefined {
    const listen = object(config.admin)?.listen;
    if (typeof listen !== 'string' || !listen.startsWith('unix/')) return;
    return mountedPath(host, listen.slice('unix/'.length).split('|')[0]!);
}
/** Permissioned Unix socket only; no TCP admin fallback or request deadline. */
export function createNativeCaddyAdminExchange(socketPath: string): NativeCaddyAdminExchange {
    return input => new Promise((resolve, reject) => {
        const body = input.value === undefined ? undefined : JSON.stringify(input.value);
        const req = request({ socketPath, path: input.path, method: input.method, signal: input.signal,
            agent: false, headers: { Host: 'localhost', ...(input.etag ? { 'If-Match': input.etag } : {}),
                ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) } }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { text += chunk; });
            res.once('error', reject);
            res.once('aborted', () => reject(new Error('native_response_incomplete')));
            res.once('end', () => {
                if (!res.complete) { reject(new Error('native_response_incomplete')); return; }
                try { resolve({ status: res.statusCode ?? 0, ...(text ? { value: JSON.parse(text) as unknown } : {}),
                    ...(typeof res.headers.etag === 'string' ? { etag: res.headers.etag } : {}) }); }
                catch { reject(new Error('native_response_invalid')); }
            });
        });
        req.once('error', reject);
        req.end(body);
    });
}
function publishedEndpoints(value: unknown): NativeCaddyPublishedEndpoint[] | undefined {
    if (value === null) return [];
    const ports = object(value);
    if (!ports) return;
    const endpoints: NativeCaddyPublishedEndpoint[] = [];
    for (const [key, bindings] of Object.entries(ports)) {
        if (bindings === null) continue;
        const match = /^(\d+)\/tcp$/.exec(key);
        if (!match) continue;
        if (!Array.isArray(bindings)) return;
        for (const value of bindings) {
            const binding = object(value);
            const hostPort = typeof binding?.HostPort === 'string' ? Number(binding.HostPort) : NaN;
            const containerPort = Number(match[1]);
            if (typeof binding?.HostIp !== 'string' || !isIP(binding.HostIp) || !Number.isInteger(hostPort)
                || hostPort < 1 || hostPort > 65535 || containerPort < 1 || containerPort > 65535) return;
            endpoints.push({ hostAddress: binding.HostIp, hostPort, containerPort });
        }
    }
    return endpoints;
}

/** Review all owned publications, including stopped Caddy's configured binds.
 * Profile requirements own exposure intent; current private-network facts own
 * scope. No listener/admin observation can silently omit a retained permit. */
export async function observeNativeCaddyFirewallBindings(input: ContainerInput & Readonly<{
    privateNetworks: readonly MachinePrivateNetworkObservationV1[];
}>, options: NativeOptions = {}): Promise<Readonly<{ status: 'ready'; bindings: MachineFirewallTransitionBindingsV1 }>
    | Readonly<{ status: 'unavailable'; reason: 'required_fact_unavailable' | 'foreign_effect_conflict' | 'private_scope_unenforceable';
        details?: NativeCaddyFailureDetails }>> {
    try {
        const container = await inspectOwnedContainer(input, nativeDocker(input, options));
        if (container.status === 'needs_setup') return { status: 'ready', bindings: { publicBindings: [] } };
        if (container.status !== 'observed') return container;
        const requirements = [nativeCaddyProfile.portRequirement, ...nativeCaddyProfile.publicPortRequirements];
        const configured = container.host.PortBindings;
        const ports = configured === null ? {} : object(configured);
        if (!ports || Object.keys(ports).some(key => !requirements.some(requirement => key === `${requirement.containerPort}/${requirement.protocol}`)))
            return caddyFactUnavailable('caddyPublishedBindings');
        const endpoints = publishedEndpoints(configured);
        if (!endpoints) return caddyFactUnavailable('caddyPublishedBindings');
        const exposures: NativeCaddyFirewallExposure[] = [];
        for (const endpoint of endpoints) {
            const requirement = requirements.find(requirement => requirement.containerPort === endpoint.containerPort)!;
            const { id: requirementId, ...declaration } = requirement;
            if (requirement.exposure === 'public') {
                exposures.push({ ...declaration, ...endpoint, requirementId });
            } else {
                const networks = input.privateNetworks.filter(network => network.state === 'ready'
                    && network.addresses.includes(endpoint.hostAddress));
                if (networks.length !== 1) return { status: 'unavailable', reason: 'private_scope_unenforceable' };
                const network = networks[0]!;
                if (!network.networkIdentity) return { status: 'unavailable', reason: 'private_scope_unenforceable' };
                exposures.push({ ...declaration, ...endpoint, requirementId,
                    providerId: privateProviderId(network), networkIdentity: network.networkIdentity });
            }
        }
        const bindings = createNativeCaddyBindings({ originPort: nativeCaddyProfile.portRequirement.containerPort,
            exposures, privateNetworks: input.privateNetworks });
        if (bindings.status !== 'ready') return bindings;
        return { status: 'ready', bindings: { publicBindings: [...bindings.publicBindings],
            ...(bindings.privateBinding ? { privateBinding: { ...bindings.privateBinding,
                sourceRanges: [...bindings.privateBinding.sourceRanges] } } : {}) } };
    } catch (error) {
        options.signal?.throwIfAborted();
        return caddyFactUnavailable('caddyContainer', error);
    }
}

function listenerPort(listener: string, networks: Record<string, unknown>, endpointAddress?: string): number | undefined {
    // Caddy network addresses may have a network prefix. Only TCP HTTP
    // listeners correspond to Docker's TCP publications; Unix/UDP do not.
    const match = /^(?:(tcp[46]?)\/)?(\[[^\]]+\]|[^:/]*):(\d+)$/.exec(listener);
    if (!match) return;
    const host = match[2]!.replace(/^\[|\]$/g, '');
    if (host && host !== '0.0.0.0' && host !== '::' && !Object.values(networks).some(value => {
        const network = object(value);
        return network?.IPAddress === host || network?.GlobalIPv6Address === host;
    })) return;
    if (endpointAddress !== undefined) {
        const family = isIP(endpointAddress);
        if (!family || (match[1] === 'tcp4' || host === '0.0.0.0') && family !== 4
            || (match[1] === 'tcp6' || host === '::') && family !== 6
            || host && host !== '0.0.0.0' && host !== '::' && host !== endpointAddress) return;
    }
    const port = Number(match[3]);
    return port >= 1 && port <= 65535 ? port : undefined;
}

/** Read-only native facts. The mounted seed locates the socket; the live admin
 * response alone supplies listeners. No setup, TCP fallback or polling occurs. */
export async function observeNativeCaddyContainer(input: ContainerInput & Readonly<{
    privateNetworks?: readonly MachinePrivateNetworkObservationV1[];
    privateBinding?: NativeCaddySetupInput['privateBinding'];
}>,
    options: NativeOptions = {}): Promise<NativeCaddyObservationResult> {
    let requiredFact: keyof typeof caddyFactRemedies = 'caddyContainer';
    try {
        const container = await inspectOwnedContainer(input, nativeDocker(input, options));
        if (container.status !== 'observed') return container.status === 'unavailable' && container.reason === 'required_fact_unavailable'
            ? caddyFactUnavailable(requiredFact) : container;
        if (!container.running) return { status: 'stopped', containerId: container.containerId };
        const configPath = mountedPath(container.host, '/etc/caddy/happier.json');
        if (!configPath) return { status: 'unavailable', reason: 'foreign_effect_conflict' };
        requiredFact = 'caddyMountedSeed';
        const seed = object(JSON.parse(await readFile(configPath, 'utf8')) as unknown);
        if (!seed) return caddyFactUnavailable(requiredFact);
        const socketPath = seed && adminSocket(container.host, seed);
        if (!socketPath) return caddyFactUnavailable('caddyAdminSocket');
        requiredFact = 'caddyAdminConfig';
        const response = await createNativeCaddyAdminExchange(socketPath)({ method: 'GET', path: '/config/', signal: options.signal });
        if (response.status !== 200) return caddyFactUnavailable(requiredFact, `HTTP_${response.status}`);
        const config = response.status === 200 ? object(response.value) : undefined;
        const httpServers = object(object(object(config?.apps)?.http)?.servers);
        const endpoints = publishedEndpoints(container.ports);
        if (!config || adminSocket(container.host, config) !== socketPath || !httpServers) return caddyFactUnavailable(requiredFact);
        if (!endpoints) return caddyFactUnavailable('caddyPublishedBindings');
        const servers: NativeCaddyServerObservation[] = [];
        for (const [serverId, value] of Object.entries(httpServers)) {
            const server = object(value);
            if (!server || !Array.isArray(server.listen) || !server.listen.every((value): value is string => typeof value === 'string')) {
                return caddyFactUnavailable('caddyListeners');
            }
            const ports = server.listen.map(listener => listenerPort(listener, container.networks));
            servers.push({ serverId, listen: server.listen, tls: Array.isArray(server.tls_connection_policies) && server.tls_connection_policies.length > 0,
                automaticHttpsDisabled: object(server.automatic_https)?.disable === true,
                endpoints: endpoints.filter(endpoint => ports.includes(endpoint.containerPort)) });
        }
        const privateBinding = input.privateBinding;
        const networkName = typeof container.host.NetworkMode === 'string'
            && Object.hasOwn(container.networks, container.host.NetworkMode) ? container.host.NetworkMode : undefined;
        const primaryNetwork = networkName === undefined ? undefined : object(container.networks[networkName]);
        const containerOrigins: Array<{ serverId: string; networkName: string; service: string }> = [];
        if (networkName !== undefined && primaryNetwork) {
            const networks = { [networkName]: primaryNetwork };
            const addresses = [primaryNetwork.IPAddress, primaryNetwork.GlobalIPv6Address]
                .filter((address): address is string => typeof address === 'string' && isIP(address) !== 0);
            for (const server of servers.filter(server => !server.tls && server.automaticHttpsDisabled)) {
                const services = new Set<string>();
                for (const listener of server.listen) {
                    for (const address of addresses) {
                        const port = listenerPort(listener, networks, address);
                        if (port === undefined) continue;
                        services.add(`http://${isIP(address) === 6 ? `[${address}]` : address}:${port}`);
                        break;
                    }
                }
                containerOrigins.push(...[...services].map(service => ({ serverId: server.serverId, networkName, service })));
            }
        }
        return { status: 'ready', containerId: container.containerId, containerName: container.containerName,
            adminSocketPath: socketPath, networkNames: Object.keys(container.networks), servers, containerOrigins,
            ...(input.privateNetworks ? { privateOrigins: servers.filter(server => !server.tls && server.automaticHttpsDisabled).flatMap(server =>
                server.endpoints.flatMap(endpoint => input.privateNetworks!.filter(network => privateBinding
                    && endpoint.hostAddress === privateBinding.exposure.hostAddress && endpoint.hostPort === privateBinding.exposure.hostPort
                    && endpoint.containerPort === (privateBinding.exposure.containerPort ?? privateBinding.exposure.hostPort)
                    && network.state === 'ready' && privateProviderId(network) === privateBinding.exposure.providerId
                    && network.networkIdentity === privateBinding.exposure.networkIdentity && network.sourceRanges.length
                    && network.interfaceName === privateBinding.interfaceName && network.addresses.includes(endpoint.hostAddress)).map(network => ({ serverId: server.serverId,
                        endpoint: `${isIP(endpoint.hostAddress) === 6 ? `[${endpoint.hostAddress}]` : endpoint.hostAddress}:${endpoint.hostPort}`, network })))) } : {}),
        };
    } catch (error) {
        options.signal?.throwIfAborted();
        return caddyFactUnavailable(requiredFact, error);
    }
}
function mounts(input: NativeCaddySetupInput) {
    return [
        ...['data', 'config', 'logs'].map(name => ({ source: join(input.stateDirectory, name), target: name === 'logs' ? '/var/log/happier-caddy' : `/${name}`, readOnly: false })),
        { source: input.adminDirectory, target: '/run/happier-caddy', readOnly: false },
        { source: join(input.stateDirectory, 'initial.json'), target: '/etc/caddy/happier.json', readOnly: true },
    ];
}

/** Docker start acknowledges the process, not its admin API. Observe socket
 * creation/chmod and container exit under the admitted operation's cancellation;
 * no polling, retry budget or competing readiness deadline is introduced. */
async function startNativeCaddyContainer(input: NativeCaddySetupInput, containerId: string, options: NativeOptions): Promise<NativeCaddyContainerResult> {
    const seed = object(JSON.parse(input.initialConfig) as unknown);
    const host = { Mounts: mounts(input).map(mount => ({ Type: 'bind', Source: mount.source, Target: mount.target })) };
    const socketPath = seed && adminSocket(host, seed);
    if (!socketPath) return caddyFactUnavailable('caddyAdminSocket');
    let changed = false, wake: (() => void) | undefined, watchError: unknown;
    const notify = () => { changed = true; wake?.(); };
    const lifetime = new AbortController();
    let watcher: ReturnType<typeof watch>;
    try { watcher = watch(dirname(socketPath), notify); }
    catch (error) { return caddyFactUnavailable('caddyAdminSocket', error); }
    watcher.on('error', error => { watchError = error; lifetime.abort(); notify(); });
    const abort = () => { lifetime.abort(options.signal?.reason); notify(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    let exited: MachineSetupNativeCommandResult | undefined, exitError: unknown;
    let exit: Promise<void> | undefined;
    try {
        options.signal?.throwIfAborted();
        if ((await nativeDocker(input, options)(['container', 'start', '--', containerId])).code !== 0) {
            return { status: 'unavailable', reason: 'native_effect_failed' };
        }
        exit = nativeDocker(input, { ...options, signal: lifetime.signal })(['container', 'wait', '--', containerId])
            .then(result => { exited = result; lifetime.abort(); notify(); }, error => { exitError = error; lifetime.abort(); notify(); });
        const exchange = createNativeCaddyAdminExchange(socketPath);
        while (true) {
            options.signal?.throwIfAborted();
            if (watchError) return caddyFactUnavailable('caddyAdminSocket', watchError);
            if (exitError || exited?.code !== undefined && exited.code !== 0) return caddyFactUnavailable('caddyContainer', exitError ?? exited?.errorCode);
            if (exited) return { status: 'unavailable', reason: 'native_effect_failed', details: {
                failure: { kind: 'native_effect_failed', reason: 'native_effect_failed', requiredFact: 'caddyAdminConfig' },
                remedy: 'Caddy exited before caddyAdminConfig became available. Inspect Caddy startup logs and correct the startup failure before retrying; preserve its owned state for reconciliation.',
            } };
            changed = false;
            try {
                const response = await exchange({ method: 'GET', path: '/config/', signal: lifetime.signal });
                if (response.status !== 200) return caddyFactUnavailable('caddyAdminConfig', `HTTP_${response.status}`);
                if (!object(response.value)) return caddyFactUnavailable('caddyAdminConfig');
                return { status: 'ready', containerId };
            } catch (error) {
                options.signal?.throwIfAborted();
                if (lifetime.signal.aborted) continue;
                const code = object(error)?.code;
                if (code !== 'ENOENT' && code !== 'ECONNREFUSED') return caddyFactUnavailable('caddyAdminConfig', error);
                if (!changed) await new Promise<void>(resolve => { wake = resolve; });
                wake = undefined;
            }
        }
    } finally {
        watcher.close();
        options.signal?.removeEventListener('abort', abort);
        lifetime.abort();
        await exit;
    }
}
function portBindings(exposures: readonly NativeCaddyFirewallExposure[]) {
    const ports: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
    for (const exposure of exposures) {
        const key = `${exposure.containerPort ?? exposure.hostPort}/${exposure.protocol}`;
        (ports[key] ??= []).push({ HostIp: exposure.hostAddress, HostPort: String(exposure.hostPort) });
    }
    return ports;
}
function matchingPorts(actual: unknown, expected: ReturnType<typeof portBindings>): boolean {
    const ports = actual === null ? {} : object(actual);
    return ports !== undefined && Object.keys(ports).length === Object.keys(expected).length
        && Object.entries(expected).every(([key, bindings]) => {
            const current = ports[key];
            return Array.isArray(current) && current.length === bindings.length
                && bindings.every(binding => current.some(value => {
                    const item = object(value);
                    return item?.HostIp === binding.HostIp && item.HostPort === binding.HostPort;
                }));
        });
}

/** PUT creates only missing keys; it cannot overwrite another Domain's config.
 * Caddy persists these additions for --resume: https://caddyserver.com/docs/api#put-configpath */
async function ensurePublicCaddyConfig(input: NativeCaddySetupInput, host: Record<string, unknown>, options: NativeOptions): Promise<boolean> {
    if (!input.publicBindings?.length) return true;
    const seed = object(JSON.parse(input.initialConfig) as unknown);
    const socketPath = seed && adminSocket(host, seed);
    if (!seed || !socketPath) return false;
    const exchange = createNativeCaddyAdminExchange(socketPath);
    const response = await exchange({ method: 'GET', path: '/config/', signal: options.signal });
    const current = response.status === 200 ? object(response.value) : undefined;
    const apps = object(current?.apps), desiredApps = object(seed.apps);
    const servers = object(object(apps?.http)?.servers), desiredServers = object(object(desiredApps?.http)?.servers);
    if (!apps || !servers || !desiredApps || !desiredServers || adminSocket(host, current!) !== socketPath) return false;
    const create = async (path: string, value: unknown) => (await exchange({ method: 'PUT', path, value, signal: options.signal })).status === 200;
    if (apps.tls === undefined && desiredApps.tls !== undefined && !await create('/config/apps/tls', desiredApps.tls)) return false;
    const ports = new Set(input.publicBindings.map(binding => binding.containerPort ?? binding.hostPort));
    for (const [id, value] of Object.entries(desiredServers)) {
        const server = object(value);
        if (servers[id] !== undefined || !Array.isArray(server?.listen)
            || !server.listen.some(listener => typeof listener === 'string' && ports.has(Number(listener.slice(listener.lastIndexOf(':') + 1))))) continue;
        if (!await create(`/config/apps/http/servers/${encodeURIComponent(id)}`, server)) return false;
    }
    return true;
}

function extendsPublicPorts(actual: unknown, input: NativeCaddySetupInput): boolean {
    const ports = actual === null ? {} : object(actual);
    if (!ports) return false;
    const expected = portBindings(readCaddyContainerFirewallExposures(input));
    const publicPorts = portBindings(input.publicBindings ?? []);
    return Object.entries(ports).every(([key, values]) => matchingPorts({ [key]: values }, { [key]: expected[key] ?? [] }))
        && Object.entries(expected).every(([key, values]) => matchingPorts({ [key]: ports[key] ?? [] }, { [key]: values })
            || matchingPorts({ [key]: values }, { [key]: publicPorts[key] ?? [] }));
}

/** Setup is settled before entry; binding effects settle after the existing
 * ownership checks and before Docker writes in the same admitted operation.
 * P41 alone owns route content, health and incumbent-network drain. */
export async function ensureNativeCaddyContainer(input: NativeCaddySetupInput, options: Readonly<{
    /** The existing combined setup/firewall interpreter has settled this admission. */
    setupResult: MachineSetupApplyResultV1;
    /** Settle the admitted firewall declaration before any container mutation. */
    settleBindings?: () => Promise<void>;
    run?: (command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>; signal?: AbortSignal;
}>): Promise<NativeCaddyContainerResult> {
    options.signal?.throwIfAborted();
    if (options.setupResult.status !== 'applied') return { status: 'needs_setup' };
    const unavailable = (reason: Extract<NativeCaddyContainerResult, { status: 'unavailable' }>['reason']): NativeCaddyContainerResult => ({ status: 'unavailable', reason });
    const privateBinding = input.privateBinding;
    if (privateBinding && (!privateBinding.interfaceName || !privateBinding.sourceRanges.length
        || privateBinding.exposure.exposure !== 'privateNetwork' || !privateBinding.exposure.providerId || !privateBinding.exposure.networkIdentity
        || !isIP(privateBinding.exposure.hostAddress) || ['0.0.0.0', '::'].includes(privateBinding.exposure.hostAddress)
        || privateBinding.exposure.protocol !== 'tcp'
        || (privateBinding.exposure.containerPort ?? privateBinding.exposure.hostPort) !== input.originPort)) return unavailable('private_scope_unenforceable');
    if (input.publicBindings?.some(binding => (binding.containerPort ?? binding.hostPort) === input.originPort)) return unavailable('private_scope_unenforceable');
    if (!input.routedNetworks.length || input.publicBindings?.some(binding => binding.exposure !== 'public')) return unavailable('required_fact_unavailable');
    const exposures = readCaddyContainerFirewallExposures(input);
    const expectedMounts = mounts(input);
    const run = nativeDocker(input, options);
    // An explicit read failure is unknown, never evidence of absence. Exact
    // name selection also avoids interpreting inspect's shared error exit as
    // either a missing container or a permission/transport failure.
    const container = await inspectOwnedContainer(input, run);
    if (container.status === 'unavailable') return container.reason === 'required_fact_unavailable'
        ? caddyFactUnavailable('caddyContainer') : container;
    let id = container.status === 'observed' ? container.containerId : '';
    let running = false;
    let networks: Record<string, unknown> = {};
    let create = container.status !== 'observed';
    if (container.status === 'observed') {
        const { config, host } = container;
        if (config.User !== `0:${input.daemonGroupId}`
            || !Array.isArray(host.Mounts) || host.Mounts.length !== expectedMounts.length
            || !expectedMounts.every(expected => (host.Mounts as unknown[]).some(value => {
                const mount = object(value);
                return mount?.Type === 'bind' && mount.Source === expected.source && mount.Target === expected.target
                    && (mount.ReadOnly ?? false) === expected.readOnly;
            }))) return unavailable('foreign_effect_conflict');
        const bindingsMatch = matchingPorts(host.PortBindings, portBindings(exposures));
        if (!bindingsMatch && !extendsPublicPorts(host.PortBindings, input)) return unavailable('foreign_effect_conflict');
        id = container.containerId;
        running = container.running;
        networks = container.networks;
        await options.settleBindings?.();
        if (input.publicBindings?.length) {
            if (!running) {
                const started = await startNativeCaddyContainer(input, id, options);
                if (started.status !== 'ready') return started;
                running = true;
            }
            try {
                if (!await ensurePublicCaddyConfig(input, host, options)) return caddyFactUnavailable('caddyAdminConfig');
            } catch (error) {
                options.signal?.throwIfAborted();
                return caddyFactUnavailable('caddyAdminConfig', error);
            }
        }
        if (!bindingsMatch) {
            // Docker publications are immutable. The admitted owned extension
            // retains durable autosave/data and every incumbent network.
            if (running && (await run(['container', 'stop', '--', id])).code !== 0) return unavailable('native_effect_failed');
            if ((await run(['container', 'rm', '--', id])).code !== 0) return unavailable('native_effect_failed');
            create = true;
            running = false;
        }
    }
    if (create) {
        if (container.status !== 'observed') await options.settleBindings?.();
        const retainedNetworks = Object.keys(networks);
        const created = await run(['container', 'create', '--name', input.containerName, '--label', `${ownerLabel}=${ownerValue}`,
            '--restart', 'unless-stopped', '--user', `0:${input.daemonGroupId}`, '--network', input.routedNetworks[0]!,
            ...expectedMounts.flatMap(mount => ['--mount', `type=bind,src=${mount.source},dst=${mount.target},readonly=${mount.readOnly}`]),
            ...exposures.flatMap(exposure => ['--publish', `${isIP(exposure.hostAddress) === 6 ? `[${exposure.hostAddress}]` : exposure.hostAddress}:${exposure.hostPort}:${exposure.containerPort ?? exposure.hostPort}/${exposure.protocol}`]),
            nativeCaddyImage, ...command]);
        if (created.code !== 0) return unavailable(created.errorCode === 'ENOENT' ? 'required_fact_unavailable' : 'native_effect_failed');
        id = created.stdout.trim();
        if (!id) throw new Error('Native Caddy creation outcome is unknown');
        networks = { [input.routedNetworks[0]!]: {} };
        const retained = await connectNativeCaddyNetworks({ dockerHost: input.dockerHost, containerId: id,
            observedNetworkNames: Object.keys(networks), networkNames: retainedNetworks }, options);
        if (retained.status !== 'ready') return retained;
        networks = Object.fromEntries([...retainedNetworks, input.routedNetworks[0]!].map(name => [name, {}]));
    }
    // Keep incumbent attachments for P41's all-replica drain. Existing route
    // content stays in Caddy's durable autosave through publication changes.
    const connected = await connectNativeCaddyNetworks({ dockerHost: input.dockerHost, containerId: id,
        observedNetworkNames: Object.keys(networks), networkNames: input.routedNetworks }, options);
    if (connected.status !== 'ready') return connected;
    if (!running) return startNativeCaddyContainer(input, id, options);
    return { status: 'ready', containerId: id };
}
