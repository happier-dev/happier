import { z } from 'zod/mini';
import { CrabboxLaunchV1Schema, CrabboxResourceV1Schema, type CrabboxLaunchV1, type CrabboxResourceV1 } from './schemas.js';

export type CrabboxHttp = (url: string, init: RequestInit) => Promise<Response>;
export type CrabboxObservation = Readonly<{
    resource: CrabboxResourceV1;
    state: 'pending' | 'ended' | 'unknown';
    leaseState?: 'active' | 'pending' | 'released' | 'unknown';
    cleanup: 'confirmed' | 'pending' | 'unknown';
    expiresAt?: number;
    idleTimeoutSeconds?: number;
}>;
export type CrabboxAcquireResult = Readonly<{
    status: 'allocated' | 'unknown' | 'refused';
    resource: CrabboxResourceV1;
    observation?: CrabboxObservation;
    code?: string;
}>;

export class CrabboxNativeError extends Error {
    constructor(readonly code: 'native_identity_mismatch' | 'native_response_invalid' | 'native_connection_invalid' | 'native_route_unavailable' | 'native_lease_ended') {
        super(code);
        this.name = 'CrabboxNativeError';
    }
}

// External v0.71.0 CoordinatorLease decoding projects only consumed fields.
// Native labels, providerMetadata, SSH addresses and auth never enter public facts.
const CoordinatorLeaseSchema = z.object({
    id: z.string(), provider: z.string(), org: z.string(), state: z.string(),
    keep: z.optional(z.boolean()), cloudID: z.optional(z.string()), serverID: z.optional(z.number()),
    host: z.optional(z.string()), sshUser: z.optional(z.string()), sshPort: z.optional(z.string()),
    sshHostKey: z.optional(z.string()), providerAccessExpiresAt: z.optional(z.string()),
    tailscale: z.optional(z.unknown()), expiresAt: z.optional(z.string()),
    idleTimeoutSeconds: z.optional(z.int().check(z.nonnegative())),
    cleanupStatus: z.optional(z.string()), cleanupCompletedAt: z.optional(z.string()),
    cleanupError: z.optional(z.string()), cleanupRetryAt: z.optional(z.string()),
    releaseDeletesServer: z.optional(z.boolean()),
});
type CoordinatorLease = z.infer<typeof CoordinatorLeaseSchema>;

function timestamp(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function observe(resource: CrabboxResourceV1, lease: CoordinatorLease): CrabboxObservation {
    const instanceId = lease.cloudID || (lease.serverID ? String(lease.serverID) : undefined);
    if (resource.nativeInstanceId && instanceId !== resource.nativeInstanceId) throw new CrabboxNativeError('native_identity_mismatch');
    const completedAt = timestamp(lease.cleanupCompletedAt);
    // v0.71.0 docs/commands/inspect.md: released alone is not native absence.
    const confirmed = lease.state === 'released' && lease.cleanupStatus === 'complete' && completedAt !== undefined
        && !lease.cleanupError && !lease.cleanupRetryAt && lease.releaseDeletesServer !== false
        && !lease.host && lease.tailscale === undefined && lease.sshHostKey === undefined && lease.providerAccessExpiresAt === undefined;
    const state = lease.state === 'released' && confirmed ? 'ended'
        : ['pending', 'provisioning', 'creating'].includes(lease.state) ? 'pending' : 'unknown';
    const leaseState = lease.state === 'active' ? 'active' : lease.state === 'released' ? 'released'
        : ['pending', 'provisioning', 'creating'].includes(lease.state) ? 'pending' : 'unknown';
    return {
        resource: { ...resource, ...(instanceId ? { nativeInstanceId: instanceId } : {}) },
        state, leaseState, cleanup: confirmed ? 'confirmed' : lease.cleanupStatus === 'pending' ? 'pending' : 'unknown',
        ...(timestamp(lease.expiresAt) === undefined ? {} : { expiresAt: timestamp(lease.expiresAt) }),
        ...(lease.idleTimeoutSeconds === undefined ? {} : { idleTimeoutSeconds: lease.idleTimeoutSeconds }),
    };
}

export class CrabboxCoordinatorClient {
    private readonly endpoint: URL;
    constructor(private readonly connection: Readonly<{ endpoint: string; token: string; namespace: string }>, private readonly http: CrabboxHttp = fetch) {
        try {
            this.endpoint = new URL(connection.endpoint);
            // The native client supports explicit HTTP local coordinator routes.
            // Destination/credential admission belongs to the prepared connection owner.
            if (!['https:', 'http:'].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash
                || !connection.namespace || !connection.token || /[\r\n]/.test(connection.namespace + connection.token)) throw new Error();
        } catch { throw new CrabboxNativeError('native_connection_invalid'); }
    }

    async acquire(launch: CrabboxLaunchV1, resource: CrabboxResourceV1, sshPublicKey: string, signal?: AbortSignal): Promise<CrabboxAcquireResult> {
        launch = CrabboxLaunchV1Schema.parse(launch);
        this.assertResource(resource);
        if (launch.transport !== resource.transport || launch.namespace !== resource.namespace || launch.backendId !== resource.backendId
            || resource.nativeInstanceId) throw new CrabboxNativeError('native_identity_mismatch');
        // These coordinator SSH backends use fixed native admission. Local
        // containers and Blacksmith retain their separate native CLI routes.
        if (launch.backendId === 'local-container' || launch.backendId === 'blacksmith-testbox') return { status: 'refused', resource, code: 'native_route_unavailable' };
        // Host custody currently emits RSA; native SSH also accepts Ed25519.
        // This is only the public half. Private key material stays with the host.
        if (!/^(?:ssh-rsa|ssh-ed25519) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(sshPublicKey)) throw new CrabboxNativeError('native_response_invalid');
        const imageFields = launch.backendId === 'aws' ? { awsAMI: launch.nativeImageId }
            : launch.backendId === 'gcp' ? { gcpImage: launch.nativeImageId, gcpProject: launch.gcpProject, gcpZone: launch.gcpZone }
                : { image: launch.nativeImageId, location: launch.location };
        try {
            const lease = await this.request(resource, 'PUT', {
                leaseID: resource.leaseId, provider: resource.backendId, target: launch.target,
                ...imageFields, serverType: launch.nativeSizeId, serverTypeExplicit: true,
                ttlSeconds: launch.ttlSeconds, idleTimeoutSeconds: launch.idleTimeoutSeconds,
                sshPublicKey, keep: true,
            }, signal);
            if (!lease) return { status: 'unknown', resource, code: 'native_transport_unknown' };
            if (lease.state === 'released') return { status: 'refused', resource, code: 'native_lease_ended' };
            if (lease.keep !== true) return { status: 'unknown', resource, code: 'native_retention_unconfirmed' };
            const observation = observe(resource, lease);
            return { status: 'allocated', resource: observation.resource, observation };
        } catch (error) {
            return { status: error instanceof CrabboxNativeError && error.code === 'native_lease_ended' ? 'refused' : 'unknown', resource,
                code: error instanceof CrabboxNativeError ? error.code : 'native_transport_unknown' };
        }
    }
    async inspect(resource: CrabboxResourceV1, signal?: AbortSignal): Promise<CrabboxObservation> {
        const lease = await this.request(resource, 'GET', undefined, signal);
        return lease ? observe(resource, lease) : { resource, state: 'unknown', cleanup: 'unknown' };
    }
    async destroy(resource: CrabboxResourceV1, signal?: AbortSignal): Promise<CrabboxObservation> {
        const current = await this.request(resource, 'GET', undefined, signal);
        if (!current) return { resource, state: 'unknown', cleanup: 'unknown' };
        const before = observe(resource, current);
        if (before.cleanup === 'confirmed') return before;
        const lease = await this.request(before.resource, 'POST', { delete: true, expectedProvider: resource.backendId }, signal);
        return lease ? observe(before.resource, lease) : { resource: before.resource, state: 'unknown', cleanup: 'unknown' };
    }
    async privateSshEndpoint(resource: CrabboxResourceV1, signal?: AbortSignal): Promise<Readonly<{ host: string; port: number; user: string; hostKey: string }> | undefined> {
        const lease = await this.request(resource, 'GET', undefined, signal);
        if (!lease || lease.state !== 'active') return undefined;
        observe(resource, lease);
        const port = Number(lease.sshPort);
        if (!lease.host || !lease.sshUser || !lease.sshHostKey || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
        return { host: lease.host, port, user: lease.sshUser, hostKey: lease.sshHostKey };
    }

    private assertResource(resource: CrabboxResourceV1): void {
        CrabboxResourceV1Schema.parse(resource);
        if (resource.transport !== 'coordinator' || resource.namespace !== this.connection.namespace) throw new CrabboxNativeError('native_identity_mismatch');
    }

    private async request(resource: CrabboxResourceV1, method: 'GET' | 'PUT' | 'POST', body: unknown, signal: AbortSignal | undefined): Promise<CoordinatorLease | undefined> {
        this.assertResource(resource);
        if (signal?.aborted) return undefined;
        const path = `/v1/leases/${encodeURIComponent(resource.leaseId)}${method === 'POST' ? '/release' : ''}`;
        let response: Response;
        try {
            response = await this.http(this.endpoint.toString().replace(/\/+$/, '') + path, {
                method, signal, redirect: 'error',
                headers: { Authorization: `Bearer ${this.connection.token}`, 'X-Crabbox-Org': resource.namespace, 'Content-Type': 'application/json',
                    ...(method === 'PUT' ? { Prefer: 'respond-async' } : {}) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        } catch { return undefined; }
        if (!response.ok) {
            if (method === 'PUT' && response.status === 409) {
                const rejection = z.object({ error: z.string() }).safeParse(await response.json().catch(() => undefined));
                if (rejection.success && rejection.data.error === 'fixed_lease_terminal') throw new CrabboxNativeError('native_lease_ended');
            }
            return undefined;
        }
        let decoded: unknown;
        try { decoded = await response.json(); } catch { throw new CrabboxNativeError('native_response_invalid'); }
        const result = z.object({ lease: CoordinatorLeaseSchema }).safeParse(decoded);
        if (!result.success) throw new CrabboxNativeError('native_response_invalid');
        const lease = result.data.lease;
        if (lease.id !== resource.leaseId || lease.provider !== resource.backendId || lease.org !== resource.namespace) throw new CrabboxNativeError('native_identity_mismatch');
        return lease;
    }
}
