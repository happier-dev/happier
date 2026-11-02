import { isDeepStrictEqual } from 'node:util';
import tweetnacl from 'tweetnacl';
import { type NativeCaddyAdminExchange } from '@happier-dev/cli-common/machineSetup';
export { createNativeCaddyAdminExchange, type NativeCaddyAdminExchange } from '@happier-dev/cli-common/machineSetup';
import { nativeCaddyRemovalSigningBytes as removalBytes, verifyNativeCaddyRemovalProofV1, nativeCaddyDomainRouteIdsV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { NativeCaddyRoutePlacement, NativeCaddyRemoval } from '@happier-dev/protocol/deployments/deploymentActionsV1';
export type { NativeCaddyRoutePlacement, NativeCaddyRemoval } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { CaddyDomainMaterializationError, caddyPublicHttpServerId, materializeCaddyDomainRouteV1, materializeCaddyDomainRemovalV1, materializeCaddyDomainReplicaSetV1,
    type CaddyDomainRouteInput, type CaddyDomainRouteMaterial, type CaddyDomainRouteRemovalInput } from '@/deployments/targets/ownServer/caddyRouteMaterialization';

export type NativeCaddyRouteResult = Readonly<{ kind: 'active' }> | Readonly<{ kind: 'absent' }>
    | Readonly<{ kind: 'conflict' | 'unknown' | 'unavailable' | 'cancelled'; reason: string }>;
type RouteRequest = Readonly<{ placement: NativeCaddyRoutePlacement; route: CaddyDomainRouteRemovalInput; signal?: AbortSignal }>;
type ActivationRequest = Omit<RouteRequest, 'route'> & Readonly<{ route: CaddyDomainRouteInput }>;
export type NativeCaddyStartFirstLeg = Readonly<{
    placement: NativeCaddyRoutePlacement;
    route: Omit<CaddyDomainRouteInput, 'upstreams'>;
}>;
type JsonRecord = Record<string, unknown>;
type ConfigRoot = Readonly<{ value: JsonRecord; etag: string; path: string }>;
type RootName = 'server' | 'http' | 'tls';
type Snapshot = Record<RootName, ConfigRoot | undefined>;
type Resource = Readonly<{ root: RootName; path: readonly string[]; id: string; desired?: unknown; expected?: unknown }>;
const object = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown) => object(value) && typeof value['@id'] === 'string' ? value['@id'] : undefined;
const serverPath = (placement: NativeCaddyRoutePlacement) => `/config/apps/http/servers/${encodeURIComponent(placement.nativeServer)}`;
function collection(snapshot: Snapshot, resource: Resource): unknown[] {
    let value: unknown = snapshot[resource.root]?.value;
    for (const segment of resource.path) value = object(value) ? value[segment] : undefined;
    if (!Array.isArray(value)) throw new Error('native_route_unavailable');
    return value;
}
function resources(request: RouteRequest, material: CaddyDomainRouteMaterial, expected?: CaddyDomainRouteMaterial): Resource[] {
    const ids = nativeCaddyDomainRouteIdsV1(request.route.domainId, request.route.listener);
    return [
        ...(material.tls ? [
            { root: 'tls' as const, path: ['certificates', 'load_pem'], id: ids.certificateId, desired: material.tls.certificate, expected: expected?.tls?.certificate },
            { root: 'tls' as const, path: ['automation', 'policies'], id: ids.automationPolicyId, desired: material.tls.automationPolicy, expected: expected?.tls?.automationPolicy },
            { root: 'server' as const, path: ['tls_connection_policies'], id: ids.tlsPolicyId, desired: material.tls.connectionPolicy, expected: expected?.tls?.connectionPolicy },
        ] : []),
        { root: 'server', path: ['errors', 'routes'], id: ids.fallbackId, desired: material.fallbackRoute, expected: expected?.fallbackRoute },
        { root: 'server', path: ['routes'], id: ids.routeId, desired: material.route, expected: expected?.route },
        ...(material.tls ? [{ root: 'http' as const, path: ['routes'], id: ids.redirectId, desired: material.tls.redirectRoute, expected: expected?.tls?.redirectRoute }] : []),
    ];
}
function matchesMaterial(current: unknown, resource: Resource, request: RouteRequest): boolean {
    if (isDeepStrictEqual(current, resource.desired)) return true;
    if (resource.root === 'server' && resource.path.length === 1 && resource.path[0] === 'routes'
        && request.route.basicAuth?.some(account => !account.bcryptHash)) {
        const comparable: unknown = structuredClone(current);
        let accounts: unknown = comparable;
        // Only the codec's exact authentication account slots are opaque on
        // observe/remove. Every other byte, username and account count compares.
        for (const segment of ['handle', 0, 'routes', 0, 'handle', 0, 'providers', 'http_basic', 'accounts']) {
            accounts = typeof segment === 'number' ? Array.isArray(accounts) ? accounts[segment] : undefined
                : object(accounts) ? accounts[segment] : undefined;
        }
        if (!Array.isArray(accounts) || accounts.length !== request.route.basicAuth.length) return false;
        for (const [index, expected] of request.route.basicAuth.entries()) {
            const account: unknown = accounts[index];
            if (!object(account) || account.username !== expected.username || typeof account.password !== 'string') return false;
            if (!expected.bcryptHash) account.password = undefined;
        }
        return isDeepStrictEqual(comparable, resource.desired);
    }
    // Removing or observing an admitted custom certificate does not acquire a
    // withdrawn Saved Secret again. The protected native owner tag is custody.
    return request.route.publicTls?.kind === 'custom' && resource.root === 'tls' && resource.path[0] === 'certificates'
        && resource.desired === undefined && object(current) && id(current) === resource.id
        && isDeepStrictEqual(current.tags, [resource.id]) && typeof current.certificate === 'string' && typeof current.key === 'string';
}

class NativeRouteRefusal extends Error {
    constructor(readonly kind: 'conflict' | 'unavailable', readonly reason: string) { super(reason); }
}

function hostMatches(pattern: string, hostname: string): boolean {
    const left = pattern.toLowerCase().split('.'), right = hostname.toLowerCase().split('.');
    return left.length === right.length && left.every((label, index) => label === '*' || label === right[index]);
}
function exactRegexPath(value: unknown): string | undefined {
    if (!object(value) || typeof value.pattern !== 'string' || !value.pattern.startsWith('^') || !value.pattern.endsWith('$')) return;
    let literal = '';
    const expression = value.pattern.slice(1, -1);
    for (let i = 0; i < expression.length; i++) {
        const character = expression[i]!;
        if (character === '\\') {
            const escaped = expression[++i];
            if (!escaped || !'.*+?^${}()|[]\\'.includes(escaped)) return;
            literal += escaped;
        } else {
            if ('.*+?^${}()|[]'.includes(character)) return;
            literal += character;
        }
    }
    return literal;
}
function matcherPaths(matcher: { path?: unknown; path_regexp?: unknown }): readonly string[] | undefined {
    if (Array.isArray(matcher.path) && matcher.path.every((path): path is string => typeof path === 'string')) return matcher.path;
    const exact = exactRegexPath(matcher.path_regexp);
    return exact === undefined ? undefined : [exact];
}
function pathsOverlap(left: string, right: string): boolean {
    if (left.toLowerCase() === right.toLowerCase()) return true;
    const prefix = (path: string) => path.endsWith('*') && !path.slice(0, -1).includes('*') ? path.slice(0, -1).toLowerCase() : undefined;
    const a = prefix(left), b = prefix(right);
    if (left.includes('*') && a === undefined || right.includes('*') && b === undefined) return true;
    return a !== undefined && right.toLowerCase().startsWith(a) || b !== undefined && left.toLowerCase().startsWith(b);
}
/** Native hostname ownership is decided here, once, before exact config effects. */
function foreignHostRoute(value: unknown, material: Pick<CaddyDomainRouteMaterial, 'route'>, hostname: string): boolean {
    if (!object(value) || id(value) === material.route['@id']) return false;
    if (!Array.isArray(value.match) || value.match.length === 0) {
        // The seed's terminal 404 cannot serve a removed host as another app.
        return !(Array.isArray(value.handle) && value.handle.length === 1 && object(value.handle[0])
            && value.handle[0].handler === 'static_response' && String(value.handle[0].status_code) === '404');
    }
    return value.match.some(matcher => {
        if (!object(matcher)) return true;
        if (Array.isArray(matcher.host) && !matcher.host.some(host => typeof host !== 'string'
            || hostMatches(host, hostname) || hostMatches(hostname, host))) return false;
        const paths = matcherPaths(matcher);
        return paths === undefined || material.route.match?.some(own => {
            const ownPaths = matcherPaths(own);
            return ownPaths === undefined || ownPaths.some(left => paths.some(right => pathsOverlap(left, right)));
        }) === true;
    });
}

/** DTEAR consumes this proof, then uses its existing installation-signed settlement writer. */
export function verifyNativeCaddyRemoval(result: NativeCaddyRemoval, expected: NativeCaddyRoutePlacement,
    expectedRoute: CaddyDomainRouteRemovalInput, publicKey: Uint8Array): boolean {
    if (expectedRoute.domainId !== expected.domainId) return false;
    try {
        return verifyNativeCaddyRemovalProofV1(result, expected,
            nativeCaddyDomainRouteIdsV1(expectedRoute.domainId, expectedRoute.listener).removalIds, publicKey);
    } catch { return false; }
}

/** One finite native admission. DNS, TLS observation, app health and Home authorization retain their owners. */
export function createNativeCaddyRoutes(host: Readonly<{
    machineId: string; installationId: string; privateKey: Uint8Array; exchange: NativeCaddyAdminExchange;
}>) {
    const readRoot = async (request: RouteRequest, path: string): Promise<ConfigRoot> => {
        const response = await host.exchange({ method: 'GET', path, signal: request.signal });
        if (response.status !== 200 || !object(response.value) || !response.etag) {
            throw new Error('native_route_unavailable');
        }
        return { value: response.value, etag: response.etag, path };
    };
    const read = async (request: RouteRequest): Promise<Snapshot> => {
        const [server, http, tls] = await Promise.all([
            readRoot(request, serverPath(request.placement)),
            request.route.listener === 'public' ? readRoot(request, serverPath({ ...request.placement,
                nativeServer: caddyPublicHttpServerId(request.placement.nativeServer) })) : undefined,
            request.route.listener === 'public' ? readRoot(request, '/config/apps/tls') : undefined,
        ]);
        return { server, http, tls };
    };
    const admitted = (request: RouteRequest): NativeCaddyRouteResult | undefined => {
        if (request.signal?.aborted) return { kind: 'cancelled', reason: 'cancelled' };
        if (request.placement.machineId !== host.machineId || request.placement.installationId !== host.installationId
            || request.route.domainId !== request.placement.domainId) return { kind: 'conflict', reason: 'target_mismatch' };
        return undefined;
    };
    const inspect = (snapshot: Snapshot, material: CaddyDomainRouteMaterial, request: RouteRequest): NativeCaddyRouteResult => {
        const changes = resources(request, material);
        if (changes.every(change => !collection(snapshot, change).some(value => id(value) === change.id))) return { kind: 'absent' };
        return changes.every(change => matchesMaterial(collection(snapshot, change).find(value => id(value) === change.id), change, request))
            ? { kind: 'active' } : { kind: 'conflict', reason: 'route_conflict' };
    };
    const ownedMaterial = (snapshot: Snapshot, request: RouteRequest) => {
        const ids = nativeCaddyDomainRouteIdsV1(request.route.domainId, request.route.listener);
        return materializeCaddyDomainRemovalV1(request.route, {
            route: collection(snapshot, { root: 'server', path: ['routes'], id: ids.routeId }).find(value => id(value) === ids.routeId),
            fallbackRoute: collection(snapshot, { root: 'server', path: ['errors', 'routes'], id: ids.fallbackId }).find(value => id(value) === ids.fallbackId),
        });
    };
    const hasRoutingInput = (route: CaddyDomainRouteRemovalInput | CaddyDomainRouteInput): route is CaddyDomainRouteInput =>
        'upstreams' in route && 'privateSourceRanges' in route;
    const observe = async (request: RouteRequest | ActivationRequest): Promise<NativeCaddyRouteResult> => {
        const refusal = admitted(request); if (refusal) return refusal;
        try {
            const snapshot = await read(request);
            const material = hasRoutingInput(request.route) ? materializeCaddyDomainRouteV1(request.route) : ownedMaterial(snapshot, request);
            return material ? inspect(snapshot, material, request) : { kind: 'conflict', reason: 'route_conflict' };
        }
        catch (error) { return failure(error, request.signal, false); }
    };
    const write = async (request: RouteRequest, snapshot: ConfigRoot, method: 'PUT' | 'PATCH' | 'DELETE', path: string, value?: unknown) => {
        request.signal?.throwIfAborted();
        const response = await host.exchange({ method, path, value, etag: snapshot.etag, signal: request.signal });
        if (response.status === 412) throw new NativeRouteRefusal('conflict', 'route_conflict');
        if (response.status < 200 || response.status >= 300) throw new NativeRouteRefusal('unavailable', 'native_effect_failed');
    };
    const failure = (error: unknown, signal: AbortSignal | undefined, issued: boolean): NativeCaddyRouteResult => {
        if (error instanceof CaddyDomainMaterializationError) return { kind: issued ? 'unknown' : 'unavailable', reason: error.code };
        if (error instanceof NativeRouteRefusal) return { kind: issued ? 'unknown' : error.kind, reason: error.reason };
        return { kind: !issued && signal?.aborted ? 'cancelled' : 'unknown', reason: 'native_route_unavailable' };
    };
    const activate = async (request: ActivationRequest & Readonly<{ expected?: CaddyDomainRouteMaterial }>): Promise<NativeCaddyRouteResult> => {
        const refusal = admitted(request); if (refusal) return refusal;
        let issued = false;
        try {
            const material = materializeCaddyDomainRouteV1(request.route);
            if (request.route.basicAuth?.some(account => !account.bcryptHash)) {
                return { kind: 'unavailable', reason: 'credential_unavailable' };
            }
            if (request.route.listener === 'public' && request.route.publicTls?.kind === 'custom' && !material.tls?.certificate) {
                return { kind: 'unavailable', reason: 'credential_unavailable' };
            }
            const snapshot = await read(request);
            const appRoutes = collection(snapshot, { root: 'server', path: ['routes'], id: '' });
            if (appRoutes.some(value => foreignHostRoute(value, material, request.route.domain.hostname))
                || material.tls && collection(snapshot, { root: 'http', path: ['routes'], id: '' }).some(value =>
                    foreignHostRoute(value, { route: material.tls!.redirectRoute }, request.route.domain.hostname))) {
                return { kind: 'conflict', reason: 'route_conflict' };
            }
            const changes = resources(request, material, request.expected);
            // Check the complete admitted old/new native material before the first effect.
            for (const change of changes) {
                const current = collection(snapshot, change).find(value => id(value) === change.id);
                if (current !== undefined && !matchesMaterial(current, change, request) && !isDeepStrictEqual(current, change.expected)) {
                    return { kind: 'conflict', reason: 'route_conflict' };
                }
            }
            for (const change of [...changes.filter(change => change.desired !== undefined), ...changes.filter(change => change.desired === undefined)]) {
                const current = collection(snapshot, change).find(value => id(value) === change.id);
                if (isDeepStrictEqual(current, change.desired)) continue;
                const root = snapshot[change.root]!;
                const collectionPath = `${root.path}/${change.path.join('/')}`;
                const method = change.desired === undefined ? 'DELETE' : current === undefined ? 'PUT' : 'PATCH';
                const path = current === undefined ? `${collectionPath}/0` : `/id/${encodeURIComponent(change.id)}`;
                try { await write(request, root, method, path, change.desired); }
                catch (error) {
                    // A native refusal means this call did not mutate; a lost reply may have.
                    if (!(error instanceof NativeRouteRefusal)) issued = true;
                    throw error;
                }
                issued = true;
                // The next shared-object mutation needs Caddy's new ETag. This is
                // native config concurrency, never a repeat Home/permission check.
                snapshot[change.root] = await readRoot(request, root.path);
            }
            return inspect(snapshot, material, request);
        } catch (error) { return failure(error, request.signal, issued); }
    };
    const remove = async (request: RouteRequest): Promise<NativeCaddyRouteResult | NativeCaddyRemoval> => {
        const refusal = admitted(request); if (refusal) return refusal;
        let issued = false;
        try {
            const snapshot = await read(request);
            const material = ownedMaterial(snapshot, request);
            if (!material) return { kind: 'conflict', reason: 'route_conflict' };
            const removals = resources(request, material).reverse();
            for (const removal of removals) {
                const current = collection(snapshot, removal).find(value => id(value) === removal.id);
                if (current !== undefined && !matchesMaterial(current, removal, request)) return { kind: 'conflict', reason: 'route_conflict' };
            }
            for (const removal of removals) {
                if (!collection(snapshot, removal).some(value => id(value) === removal.id)) continue;
                const root = snapshot[removal.root]!;
                try { await write(request, root, 'DELETE', `/id/${encodeURIComponent(removal.id)}`); }
                catch (error) { if (!(error instanceof NativeRouteRefusal)) issued = true; throw error; }
                issued = true;
                snapshot[removal.root] = await readRoot(request, root.path);
            }
            // Native absence, including an earlier unknown deletion, settles this
            // same admitted request. There is no blind replay or cleanup ledger.
            if (inspect(snapshot, material, request).kind !== 'absent') return { kind: 'unknown', reason: 'removal_unproved' };
            const routeIds = material.removalIds;
            return { kind: 'removed', placement: request.placement, routeIds,
                proof: { version: 1, algorithm: 'ed25519', signature: Buffer.from(tweetnacl.sign.detached(
                    removalBytes(request.placement, routeIds), host.privateKey)).toString('base64url') } };
        } catch (error) { return failure(error, request.signal, issued); }
    };
    const readStartFirstLeg = async (request: RouteRequest): Promise<
        { kind: 'ready'; leg: NativeCaddyStartFirstLeg } | { kind: 'unchanged' } | NativeCaddyRouteResult> => {
        const refusal = admitted(request); if (refusal) return refusal;
        try {
            const snapshot = await read(request);
            const material = ownedMaterial(snapshot, request);
            if (!material) return { kind: 'conflict', reason: 'route_conflict' };
            const result = inspect(snapshot, material, request);
            if (result.kind !== 'active') return result;
            return material.replicaProxy ? { kind: 'ready', leg: { placement: request.placement, route: material.observedRoute } }
                : { kind: 'unchanged' };
        } catch (error) { return failure(error, request.signal, false); }
    };
    const switchReplicas = async (request: RouteRequest & Readonly<{
        expectedReplicaNames: readonly [string, ...string[]]; candidateReplicaNames: readonly [string, ...string[]];
    }>): Promise<NativeCaddyRouteResult> => {
        const refusal = admitted(request); if (refusal) return refusal;
        let issued = false;
        try {
            const snapshot = await read(request);
            const material = ownedMaterial(snapshot, request);
            if (!material) return { kind: 'conflict', reason: 'route_conflict' };
            const result = inspect(snapshot, material, request);
            if (result.kind !== 'active') return result;
            if (!material.replicaProxy) return { kind: 'conflict', reason: 'route_conflict' };
            const desired = materializeCaddyDomainReplicaSetV1(material, request.candidateReplicaNames);
            if (isDeepStrictEqual(material.replicaProxy, desired.replicaProxy)) return { kind: 'active' };
            const expected = materializeCaddyDomainReplicaSetV1(material, request.expectedReplicaNames);
            if (!isDeepStrictEqual(material.replicaProxy, expected.replicaProxy)) return { kind: 'conflict', reason: 'route_conflict' };
            const root = snapshot.server!;
            try { await write(request, root, 'PATCH', `/id/${encodeURIComponent(material.replicaProxy['@id'])}`, desired.replicaProxy); }
            catch (error) { if (!(error instanceof NativeRouteRefusal)) issued = true; throw error; }
            issued = true;
            snapshot.server = await readRoot(request, root.path);
            return inspect(snapshot, desired, { ...request, route: material.observedRoute });
        } catch (error) { return failure(error, request.signal, issued); }
    };
    return { activate, observe, remove, readStartFirstLeg, switchReplicas };
}
