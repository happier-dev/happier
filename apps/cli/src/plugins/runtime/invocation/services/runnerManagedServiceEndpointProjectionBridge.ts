import {
    createManagedServiceEndpointProjectionV1,
    type ManagedServiceEndpointProjectionInputV1,
} from './managedServiceEndpointProjection';

const PROJECTION_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

export type RunnerManagedServiceEndpointProjectionBridgeOperation =
    | Readonly<{
        kind: 'managed_server_endpoint_publish';
        projection: ManagedServiceEndpointProjectionInputV1;
    }>
    | Readonly<{
        kind: 'managed_server_endpoint_release';
        instanceId: string;
        projectionToken: string;
    }>;

export type RunnerManagedServiceEndpointProjectionBridgeResult =
    | Readonly<{
        kind: 'managed_server_endpoint_published';
        projectionToken: string;
    }>
    | Readonly<{
        kind: 'managed_server_endpoint_released';
        released: boolean;
    }>;

export type RunnerManagedServiceEndpointProjectionOwner = Readonly<{
    publishEndpointProjection(
        projection: ManagedServiceEndpointProjectionInputV1,
    ): Promise<string>;
    releaseEndpointProjection(input: Readonly<{
        sessionId: string;
        pluginId: string;
        instanceId: string;
        projectionToken: string;
    }>): Promise<boolean>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
    value: Readonly<Record<string, unknown>>,
    keys: readonly string[],
): boolean {
    const actual = Object.keys(value);
    return actual.length === keys.length
        && keys.every((key) =>
            Object.prototype.hasOwnProperty.call(value, key)
        );
}

function readIdentity(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 && normalized.length <= 10_000
        ? normalized
        : null;
}

export function parseRunnerManagedServiceEndpointProjectionBridgeOperation(
    raw: unknown,
): RunnerManagedServiceEndpointProjectionBridgeOperation | null {
    if (!isRecord(raw) || typeof raw.kind !== 'string') return null;
    if (raw.kind === 'managed_server_endpoint_publish') {
        if (!hasExactKeys(raw, ['kind', 'projection'])) return null;
        try {
            const projection = createManagedServiceEndpointProjectionV1(
                raw.projection as ManagedServiceEndpointProjectionInputV1,
            );
            if (projection.custodyOwner !== 'sessionRunner') return null;
            const { v: _v, projectionToken: _token, ...input } = projection;
            return Object.freeze({
                kind: raw.kind,
                projection: Object.freeze(input),
            });
        } catch {
            return null;
        }
    }
    if (raw.kind === 'managed_server_endpoint_release') {
        if (
            !hasExactKeys(raw, [
                'kind',
                'instanceId',
                'projectionToken',
            ])
        ) return null;
        const instanceId = readIdentity(raw.instanceId);
        if (
            !instanceId
            || typeof raw.projectionToken !== 'string'
            || !PROJECTION_TOKEN_PATTERN.test(raw.projectionToken)
        ) return null;
        return Object.freeze({
            kind: raw.kind,
            instanceId,
            projectionToken: raw.projectionToken,
        });
    }
    return null;
}

export async function executeRunnerManagedServiceEndpointProjectionBridgeOperation(
    params: Readonly<{
        authority: Readonly<{
            sessionId: string;
            pluginId: string;
        }>;
        operation: RunnerManagedServiceEndpointProjectionBridgeOperation;
        owner: RunnerManagedServiceEndpointProjectionOwner;
    }>,
): Promise<RunnerManagedServiceEndpointProjectionBridgeResult> {
    if (params.operation.kind === 'managed_server_endpoint_publish') {
        if (
            params.operation.projection.sessionId !== params.authority.sessionId
            || params.operation.projection.pluginId !== params.authority.pluginId
        ) {
            throw Object.assign(
                new Error(
                    'Managed server endpoint projection does not match the authenticated runner authority',
                ),
                {
                    code:
                        'runner_managed_server_projection_authority_mismatch',
                },
            );
        }
        return Object.freeze({
            kind: 'managed_server_endpoint_published',
            projectionToken:
                await params.owner.publishEndpointProjection(
                    params.operation.projection,
                ),
        });
    }
    return Object.freeze({
        kind: 'managed_server_endpoint_released',
        released: await params.owner.releaseEndpointProjection({
            sessionId: params.authority.sessionId,
            pluginId: params.authority.pluginId,
            instanceId: params.operation.instanceId,
            projectionToken: params.operation.projectionToken,
        }),
    });
}
