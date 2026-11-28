import { createActionExecuteFailureError, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';
import type { DeploymentDomainContentV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { nativeCaddyDomainRouteIdsV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

type CaddyMatcher = {
    host?: readonly string[];
    method?: readonly string[];
    path?: readonly string[];
    path_regexp?: { pattern: string };
    remote_ip?: { ranges: readonly string[] };
    header?: Readonly<Record<string, readonly string[] | null>>;
    vars?: Readonly<Record<string, readonly string[]>>;
    expression?: string;
    not?: readonly CaddyMatcher[];
};

type CaddyProxy = {
    '@id': string;
    handler: 'reverse_proxy';
    upstreams: readonly { dial: string }[];
    transport: { protocol: 'http' };
    load_balancing: { selection_policy: { policy: 'round_robin' }; retries: number };
    health_checks?: { active: {
        uri: string;
        expect_status: number;
        headers: Readonly<Record<string, readonly string[]>>;
    } };
    headers: { request: {
        delete?: readonly string[];
        set?: Readonly<Record<string, readonly string[]>>;
    } };
};

type CaddyHandler = CaddyProxy
    | { handler: 'static_response'; status_code: number; body?: string; headers?: Readonly<Record<string, readonly string[]>> }
    | { handler: 'subroute'; routes: readonly CaddyRoute[] }
    | { handler: 'vars'; happierLocalProxy: string }
    | { handler: 'vars'; happierTelemetryCollectorNetwork: string }
    | { handler: 'authentication'; providers: { http_basic: {
        hash: { algorithm: 'bcrypt' };
        accounts: readonly { username: string; password?: string }[];
    } } };

export type CaddyRoute = {
    '@id'?: string;
    match?: readonly CaddyMatcher[];
    handle: readonly CaddyHandler[];
    terminal?: boolean;
};

/** Only collector routes retain private relays. Ordinary Domain upstreams
 * are never rebound by the receiver on daemon startup. */
export function readCaddyTelemetryCollectorBridges(configuration: unknown): readonly Readonly<{
    networkId: string; host: string; port: number;
}>[] {
    const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
    const result: { networkId: string; host: string; port: number }[] = [];
    const visit = (value: unknown) => {
        if (Array.isArray(value)) { for (const child of value) visit(child); return; }
        if (!object(value)) return;
        if (Array.isArray(value.handle)) {
            const marker = value.handle.find(item => object(item) && item.handler === 'vars'
                && typeof item.happierTelemetryCollectorNetwork === 'string');
            const proxy = value.handle.find(item => object(item) && item.handler === 'reverse_proxy');
            if (object(marker) && typeof marker.happierTelemetryCollectorNetwork === 'string' && object(proxy) && Array.isArray(proxy.upstreams)) {
                for (const upstream of proxy.upstreams) {
                    if (!object(upstream) || typeof upstream.dial !== 'string') continue;
                    try {
                        const address = new URL(`http://${upstream.dial}`);
                        if (address.port && address.pathname === '/' && !address.username && !address.password)
                            result.push({ networkId: marker.happierTelemetryCollectorNetwork, host: address.hostname, port: Number(address.port) });
                    } catch { /* Native malformed upstreams stay unavailable to the Domain owner. */ }
                }
            }
        }
        for (const child of Object.values(value)) visit(child);
    };
    visit(configuration);
    return result;
}

type CaddyReplicaUpstreams = { kind: 'replicas'; containerNames: readonly string[]; containerPort?: number };
export type CaddyDomainRouteInput = {
    domainId: string;
    domain: Pick<DeploymentDomainContentV1, 'healthCheck' | 'maintenancePage' | 'target'> & { hostname: string };
    listener: 'privateOrigin' | 'public';
    upstreams:
        | (CaddyReplicaUpstreams & { containerNames: readonly [string, ...string[]] })
        | { kind: 'privateOrigins'; endpoints: readonly [string, ...string[]] };
    /** Only this Environment's already-admitted P21 ranges; never inferred here. */
    privateSourceRanges: readonly string[];
    /** Exact, already-admitted private origins; no public-address fallback. */
    peerOrigins?: readonly string[];
    /** Existing bridge network, retained in native route bytes for daemon restart. */
    telemetryBridgeNetworkId?: string;
    telemetryPrivateHosts?: readonly string[];
    /** P42 custody supplies bcrypt hashes; this codec never opens credentials. */
    basicAuth?: readonly { username: string; bcryptHash?: string }[];
    /** Role-limited P42 delivery, never Domain metadata. Omitted PEM is removal-only. */
    publicTls?: { kind: 'managed' } | { kind: 'custom'; certificatePem?: string; privateKeyPem?: string };
};
/** Captured Domain intent suffices for cleanup after workloads/grants disappear. */
export type CaddyDomainRouteRemovalInput = Pick<CaddyDomainRouteInput, 'domainId' | 'domain' | 'listener' | 'basicAuth' | 'publicTls'>;
export class CaddyDomainMaterializationError extends Error {
    readonly code = 'invalid_parameters';
    constructor() {
        super('Unsupported canonical redirect destination');
        Object.assign(this, createActionExecuteFailureError({ ok: false, errorCode: this.code, error: this.message }));
    }
}
type CaddyDomainRenderInput = Omit<CaddyDomainRouteInput, 'upstreams'> & {
    upstreams: CaddyReplicaUpstreams | { kind: 'privateOrigins'; endpoints: readonly string[] };
};

export type CaddyDomainTlsMaterial = {
    connectionPolicy: { '@id': string; match: { sni: readonly string[] }; certificate_selection?: { any_tag: readonly string[] } };
    certificate?: { '@id': string; certificate: string; key: string; tags: readonly string[] };
    automationPolicy?: { '@id': string; subjects: readonly string[] };
    redirectRoute: CaddyRoute;
};
export type CaddyDomainRouteMaterial = {
    route: CaddyRoute;
    /** Present only for the local replica handler, never an edge or redirect. */
    replicaProxy?: CaddyProxy;
    /** Exact owned native identities, including absent public TLS resources. */
    removalIds: string[];
    /** Installed into the existing server's errors.routes by exact id. */
    fallbackRoute?: CaddyRoute;
    tls?: CaddyDomainTlsMaterial;
};
export type CaddyDomainObservedMaterial = CaddyDomainRouteMaterial & {
    replicaContainerPort?: number;
    observedReplicaNames?: readonly [string, ...string[]];
    /** Native dynamic routing facts, deliberately excluding hashes and PEM. */
    observedRoute: Omit<CaddyDomainRouteInput, 'upstreams'>;
};

export type CaddyInitialConfigInput = Readonly<{
    adminSocket: string;
    originListen: readonly [string, ...string[]];
    privateServer?: string;
    publicListen?: readonly [string, ...string[]];
    publicHttpListen?: readonly [string, ...string[]];
    publicServer?: string;
}>;
export type CaddyInitialConfig = {
    admin: { listen: string; config: { persist: true } };
    apps: { http: { servers: Record<string, {
        listen: readonly string[]; automatic_https: { disable: true } | { disable_redirects: true };
        tls_connection_policies?: readonly Record<string, never>[];
        routes: { handle: { handler: 'static_response'; status_code: 404 }[]; terminal: true }[];
        errors: { routes: CaddyRoute[] };
    }> }; tls?: { automation: { policies: unknown[] }; certificates: { load_pem: unknown[] } } };
};

/** Initial seed and later exact effects share the public HTTP server identity. */
export function caddyPublicHttpServerId(publicServer: string): string { return `${publicServer}_http`; }

/** P20's durable seed; public listeners exist only for reviewed public bindings. */
export function materializeCaddyInitialConfigV1(input: CaddyInitialConfigInput): CaddyInitialConfig {
    if (Boolean(input.publicListen) !== Boolean(input.publicHttpListen)) throw new Error('public_listener_pair_required');
    const result: CaddyInitialConfig = {
        admin: { listen: `unix/${input.adminSocket}|0660`, config: { persist: true } },
        apps: { http: { servers: {
            [input.privateServer ?? 'happier_private']: {
                listen: input.originListen, automatic_https: { disable: true },
                routes: [{ handle: [{ handler: 'static_response', status_code: 404 }], terminal: true }],
                errors: { routes: [] },
            },
        } } },
    };
    if (input.publicListen && input.publicHttpListen) {
        const publicServer = input.publicServer ?? 'happier_public';
        result.apps.http.servers[publicServer] = {
            listen: input.publicListen, automatic_https: { disable_redirects: true }, tls_connection_policies: [{}],
            routes: [{ handle: [{ handler: 'static_response', status_code: 404 }], terminal: true }], errors: { routes: [] },
        };
        result.apps.http.servers[caddyPublicHttpServerId(publicServer)] = {
            listen: input.publicHttpListen, automatic_https: { disable: true },
            routes: [{ handle: [{ handler: 'static_response', status_code: 404 }], terminal: true }], errors: { routes: [] },
        };
        result.apps.tls = { automation: { policies: [] }, certificates: { load_pem: [] } };
    }
    return result;
}

const FALLBACK_HEADER = 'X-Happier-Fallback';

function exactPath(path: string): CaddyMatcher['path_regexp'] {
    // Caddy's path matcher case-folds and interprets '*'. RE2 anchors preserve
    // the reviewed literal health path, including '/', without widening auth.
    return { pattern: `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` };
}

/** A canonical Domain defaults to HTTPS; explicit HTTP(S) may add a path
 * prefix. Userinfo/query/fragment cannot be combined with the incoming URI. */
function canonicalRedirectDestination(value: string): string {
    try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
            || url.href.includes('?') || url.href.includes('#')) throw new CaddyDomainMaterializationError();
        return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
    } catch (error) {
        logger.warnLocalFile('[Deployment] Domain redirect parse failed',
            projectActionFailureCauseV1(error, 'deployment.domain.redirect_parse', { allowUnknownErrorCode: false }));
        throw new CaddyDomainMaterializationError();
    }
}

/**
 * Native route bytes shared by the P21 leaf and its pinned Caddy fixture. Inputs are admitted
 * owner facts. No I/O, authority, route conflict, credential, or listener owner
 * is introduced here. Public certificate and redirect material uses this same
 * owner; private members never acquire certificate or redirect material.
 */
export function materializeCaddyDomainRouteV1(input: CaddyDomainRouteInput): CaddyDomainRouteMaterial {
    return renderCaddyDomainRoute(input, input.privateSourceRanges.length > 0);
}

/** Rebuild the same canonical shape from native-owned dynamic routing fields.
 * Read-only observation and removal need no synthetic topology for absent IDs. */
export function materializeCaddyDomainRemovalV1(input: CaddyDomainRouteRemovalInput,
    installed: Readonly<{ route?: unknown; fallbackRoute?: unknown }>): CaddyDomainObservedMaterial | undefined {
    const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
    const at = (value: unknown, path: readonly (string | number)[]): unknown => {
        for (const segment of path) value = typeof segment === 'number' ? Array.isArray(value) ? value[segment] : undefined
            : object(value) ? value[segment] : undefined;
        return value;
    };
    const dialList = (value: unknown): string[] | undefined => {
        if (!Array.isArray(value) || !value.every(entry => object(entry) && typeof entry.dial === 'string')) return;
        return value.map(entry => entry.dial as string);
    };
    const routes = at(installed.route, ['handle', 0, 'routes']);
    const handles = Array.isArray(routes) ? at(routes.at(-1), ['handle']) : undefined;
    const local = installed.route === undefined ? installed.fallbackRoute !== undefined
        : Array.isArray(handles) && typeof at(handles[0], ['happierLocalProxy']) === 'string';
    const telemetryBridgeNetworkId = Array.isArray(handles) ? at(handles[0], ['happierTelemetryCollectorNetwork']) : undefined;
    const hosts = at(installed.route, ['match', 0, 'host']);
    const telemetryPrivateHosts = input.domain.target.kind === 'telemetry' && input.listener === 'privateOrigin'
        && Array.isArray(hosts) && hosts.every(host => typeof host === 'string')
        ? hosts.filter(host => host !== input.domain.hostname) as string[] : undefined;
    const proxy = Array.isArray(handles) ? handles.at(-1) : undefined;
    const dials = installed.route === undefined || input.listener === 'public' && input.domain.target.redirectTo !== undefined
        ? [] : dialList(at(proxy, ['upstreams']));
    if (dials === undefined) return;
    let replicaContainerPort = input.domain.target.containerPort;
    if (local && input.domain.target.kind === 'telemetry') {
        try { replicaContainerPort = Number(new URL(`http://${dials[0]}`).port) || undefined; }
        catch { return; }
        if (!replicaContainerPort) return;
    }
    const suffix = `:${replicaContainerPort}`;
    if (local && dials.some(dial => !dial.endsWith(suffix) || dial.length === suffix.length)) return;
    const peerOrigins = installed.fallbackRoute === undefined ? [] : dialList(at(installed.fallbackRoute, ['handle', 0, 'upstreams']));
    if (peerOrigins === undefined) return;
    const ranges = at(routes, [0, 'match', 0, 'not', 0, 'remote_ip', 'ranges']);
    if (ranges !== undefined && (!Array.isArray(ranges) || !ranges.every(range => typeof range === 'string'))) return;
    const privateSourceRanges = Array.isArray(ranges) ? ranges as string[] : [];
    const observedRoute: CaddyDomainObservedMaterial['observedRoute'] = {
        domainId: input.domainId, domain: input.domain, listener: input.listener, privateSourceRanges, peerOrigins,
        ...(typeof telemetryBridgeNetworkId === 'string' ? { telemetryBridgeNetworkId } : {}),
        ...(telemetryPrivateHosts ? { telemetryPrivateHosts } : {}),
        ...(input.basicAuth ? { basicAuth: input.basicAuth.map(({ username }) => ({ username })) } : {}),
        ...(input.publicTls ? { publicTls: { kind: input.publicTls.kind } } : {}),
    };
    const replicaNames = local ? dials.map(dial => dial.slice(0, -suffix.length)) : [];
    const [first, ...rest] = replicaNames;
    return { ...renderCaddyDomainRoute({ ...input, privateSourceRanges, peerOrigins,
        ...(typeof telemetryBridgeNetworkId === 'string' ? { telemetryBridgeNetworkId } : {}),
        ...(telemetryPrivateHosts ? { telemetryPrivateHosts } : {}),
        upstreams: local ? { kind: 'replicas', containerNames: replicaNames, containerPort: replicaContainerPort }
            : { kind: 'privateOrigins', endpoints: dials } }, installed.fallbackRoute !== undefined), observedRoute,
        ...(first === undefined ? {} : { observedReplicaNames: [first, ...rest] as const }),
        ...(local && input.domain.target.kind === 'telemetry' && replicaContainerPort ? { replicaContainerPort } : {}) };
}

/** Start-first changes only this same codec's local proxy, preserving native custody. */
export function materializeCaddyDomainReplicaSetV1(observed: CaddyDomainObservedMaterial,
    containerNames: readonly [string, ...string[]]): CaddyDomainRouteMaterial {
    return renderCaddyDomainRoute({ ...observed.observedRoute, upstreams: { kind: 'replicas', containerNames, containerPort: observed.replicaContainerPort } },
        observed.fallbackRoute !== undefined);
}

function renderCaddyDomainRoute(input: CaddyDomainRenderInput, privatePeerAllowed: boolean): CaddyDomainRouteMaterial {
    const { domain, domainId, listener } = input;
    const redirectTo = listener === 'public' && domain.target.redirectTo !== undefined
        ? canonicalRedirectDestination(domain.target.redirectTo) : undefined;
    const { routeId, proxyId, fallbackId, redirectId, tlsPolicyId, certificateId, removalIds } = nativeCaddyDomainRouteIdsV1(domainId, listener);
    const local = input.upstreams.kind === 'replicas';
    const containerPort = domain.target.kind === 'telemetry' && input.upstreams.kind === 'replicas'
        ? input.upstreams.containerPort : domain.target.containerPort;
    const upstreams = input.upstreams.kind === 'replicas'
        ? input.upstreams.containerNames.map((name) => `${name}:${containerPort}`)
        : input.upstreams.endpoints;
    const healthCheck = domain.healthCheck;
    // Caddy's active checks take an upstream out of rotation, so they run only for an explicitly expected status:
    // the default check (any answer below 500) is the outside check's alone and can never take the site down.
    const activeHealth = healthCheck?.expectStatus !== undefined ? { path: healthCheck.path, expectStatus: healthCheck.expectStatus } : undefined;
    const healthMatcher: CaddyMatcher | undefined = activeHealth ? {
        method: ['GET'],
        // Path matchers clean traversal segments, but reverse_proxy forwards
        // the original path. Exempt only the exact path sent to the upstream.
        expression: `{http.request.uri.path} == ${JSON.stringify(activeHealth.path)}`,
        remote_ip: { ranges: input.privateSourceRanges },
    } : undefined;
    const exemptPrivateHealth = healthMatcher && listener === 'privateOrigin' && input.privateSourceRanges.length > 0;

    function proxy(id: string, addresses: readonly string[], role: 'local' | 'privateOrigin'): CaddyProxy {
        const activeHeaders: Record<string, readonly string[]> = { Host: [domain.hostname] };
        if (role === 'privateOrigin') activeHeaders[FALLBACK_HEADER] = ['1'];
        return {
            '@id': id,
            handler: 'reverse_proxy',
            upstreams: addresses.map((dial) => ({ dial })),
            transport: { protocol: 'http' },
            load_balancing: {
                selection_policy: { policy: 'round_robin' },
                retries: role === 'local' ? Math.max(0, addresses.length - 1) : 0,
            },
            ...(activeHealth ? { health_checks: { active: {
                uri: activeHealth.path,
                expect_status: activeHealth.expectStatus,
                headers: activeHeaders,
            } } } : {}),
            headers: { request: role === 'local'
                ? { delete: [FALLBACK_HEADER] }
                : { set: { [FALLBACK_HEADER]: ['1'] } } },
        };
    }

    const routes: CaddyRoute[] = [];
    if (input.basicAuth) {
        routes.push({
            ...(exemptPrivateHealth ? { match: [{ not: [healthMatcher] }] } : {}),
            handle: [{
                handler: 'authentication',
                providers: { http_basic: {
                    hash: { algorithm: 'bcrypt' },
                    accounts: input.basicAuth.map(({ username, bcryptHash }) => ({ username, password: bcryptHash })),
                } },
            }],
        });
    }
    if (domain.maintenancePage === true) {
        routes.push({ terminal: true, handle: [{ handler: 'static_response', status_code: 503,
            headers: { 'Content-Type': ['text/plain; charset=utf-8'] }, body: 'We’ll be back soon.\n' }] });
    }
    const appProxy = redirectTo ? undefined : proxy(proxyId, upstreams, local ? 'local' : 'privateOrigin');
    routes.push(redirectTo ? { handle: [{ handler: 'static_response', status_code: 308,
        headers: { Location: [`${redirectTo}{http.request.uri}`] } }] } : { handle: [
        ...(local ? [{ handler: 'vars' as const, happierLocalProxy: proxyId }]
            : input.telemetryBridgeNetworkId ? [{ handler: 'vars' as const, happierTelemetryCollectorNetwork: input.telemetryBridgeNetworkId }] : []),
        appProxy!,
    ] });

    // Only the collector's private listener accepts its observed IP URL. A
    // Machine has one token-admitting collector; ordinary service Domains and
    // public TLS routes retain their authored hostname match.
    const hostMatch: CaddyMatcher = { host: [domain.hostname, ...(domain.target.kind === 'telemetry'
        && listener === 'privateOrigin' ? input.telemetryPrivateHosts ?? [] : [])] };
    const match = domain.target.path
        ? [{ ...hostMatch, path: [`${domain.target.path}*`] },
            ...(healthCheck ? [{ ...hostMatch, path_regexp: exactPath(healthCheck.path) }] : [])]
        : [hostMatch];
    const route: CaddyRoute = {
        '@id': routeId,
        match,
        handle: [{ handler: 'subroute', routes }],
        terminal: true,
    };

    const material: CaddyDomainRouteMaterial = { route, removalIds, ...(local && appProxy ? { replicaProxy: appProxy } : {}) };
    if (listener === 'public') {
        const custom = input.publicTls?.kind === 'custom' ? input.publicTls : undefined;
        material.tls = {
            connectionPolicy: { '@id': tlsPolicyId, match: { sni: [domain.hostname] },
                ...(custom ? { certificate_selection: { any_tag: [certificateId] } } : {}) },
            // An explicit automation policy overrides Caddy's automatic internal
            // issuer selection even when its issuers field is omitted (2.10.2).
            ...(custom?.certificatePem && custom.privateKeyPem ? { certificate: {
                '@id': certificateId, certificate: custom.certificatePem, key: custom.privateKeyPem, tags: [certificateId],
            } } : {}),
            redirectRoute: { '@id': redirectId, match: route.match,
                handle: [{ handler: 'static_response', status_code: 308,
                    headers: { Location: [`https://${domain.hostname}{http.request.uri}`] } }], terminal: true },
        };
    }
    if (!local || !input.peerOrigins?.length || !privatePeerAllowed || redirectTo) return material;
    material.fallbackRoute = {
            '@id': fallbackId,
            match: [{
                host: [domain.hostname],
                vars: { happierLocalProxy: [proxyId] },
                expression: '{http.error.status_code} == 503',
                header: { [FALLBACK_HEADER]: null },
            }],
            handle: [proxy(`happier-peer-${domainId}-${listener}`, input.peerOrigins, 'privateOrigin')],
            terminal: true,
        };
    return material;
}
