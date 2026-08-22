import { createHash } from 'node:crypto';
import {
    lstatSync,
    readdirSync,
} from 'node:fs';
import { join } from 'node:path';

import {
    managedServiceEndpointHostPolicyForMode,
    readManagedServiceEndpointUrl,
} from '@happier-dev/protocol';

import { readPrivateOwnerFileSync } from '@/daemon/privateBearerFile';

type ManagedServiceEndpointProjectionBaseV1 = Readonly<{
    v: 1;
    projectionToken: string;
    sessionId: string;
    pluginId: string;
    contributionId: string;
    operationClaimId?: string;
    serverId: string;
    instanceId: string;
    immutableGenerationId: string;
    custodyOwner: 'daemon' | 'sessionRunner';
    endpoint: Readonly<{
        baseUrl: string;
        /**
         * Loopback for a service this host spawned; the host the user declared
         * for a server they run themselves.
         */
        host: string;
        port: number;
    }>;
    createdAtMs: number;
}>;

export type ManagedServiceEndpointProjectionV1 =
    | (ManagedServiceEndpointProjectionBaseV1 & Readonly<{
        mode: 'managedSpawn';
        process: Readonly<{
            pid: number;
            startIdentity: string;
        }>;
    }>)
    | (ManagedServiceEndpointProjectionBaseV1 & Readonly<{
        mode: 'externalAttach';
        process: null;
    }>);

export type ManagedServiceEndpointProjectionInputV1 =
    ManagedServiceEndpointProjectionV1 extends infer Projection
        ? Projection extends ManagedServiceEndpointProjectionV1
            ? Omit<Projection, 'v' | 'projectionToken'>
            : never
        : never;

export type ManagedServiceEndpointProjectionResolveQuery = Readonly<{
    pluginId: string;
    sessionId?: string;
    contributionId?: string;
    immutableGenerationId?: string;
    selector:
        | Readonly<{ kind: 'baseUrl'; baseUrl: string }>
        | Readonly<{ kind: 'projectionToken'; projectionToken: string }>
        | Readonly<{ kind: 'currentContribution' }>;
}>;

const MAX_PROJECTION_RECORDS = 256;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_IDENTITY_LENGTH = 10_000;
const PROJECTION_KEYS = Object.freeze([
    'v',
    'projectionToken',
    'sessionId',
    'pluginId',
    'contributionId',
    'serverId',
    'instanceId',
    'immutableGenerationId',
    'custodyOwner',
    'mode',
    'endpoint',
    'process',
    'createdAtMs',
] as const);

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
    value: Readonly<Record<string, unknown>>,
    required: readonly string[],
    optional: readonly string[] = [],
): boolean {
    const allowed = new Set([...required, ...optional]);
    const keys = Object.keys(value);
    return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every((key) => allowed.has(key));
}

function readIdentity(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 && normalized.length <= MAX_IDENTITY_LENGTH
        ? normalized
        : null;
}

function isFingerprint(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function readPort(value: unknown): number | null {
    return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535
        ? value as number
        : null;
}

/**
 * The projected address is admitted under the same rule the supervisor used,
 * re-derived from the record's own `mode`: a spawned service's endpoint is a
 * loopback port this host allocated, while an attached service's endpoint is
 * wherever the user runs their own server. Both reject embedded credentials.
 */
function normalizeProjectedBaseUrl(
    value: unknown,
    mode: 'managedSpawn' | 'externalAttach',
): Readonly<{ baseUrl: string; host: string; port: number }> | null {
    if (typeof value !== 'string' || value.length > MAX_IDENTITY_LENGTH) return null;
    const read = readManagedServiceEndpointUrl(value, {
        hostPolicy: managedServiceEndpointHostPolicyForMode(mode),
    });
    if (!read.ok || readPort(read.endpoint.port) === null) return null;
    return read.endpoint;
}

function projectionIdentity(input: ManagedServiceEndpointProjectionInputV1): string {
    return JSON.stringify([
        input.sessionId,
        input.pluginId,
        input.contributionId,
        input.operationClaimId ?? null,
        input.serverId,
        input.instanceId,
        input.immutableGenerationId,
        input.custodyOwner,
        input.mode,
        input.endpoint.baseUrl,
        input.endpoint.host,
        input.endpoint.port,
        input.process?.pid ?? null,
        input.process?.startIdentity ?? null,
    ]);
}

export function createManagedServiceEndpointProjectionV1(
    input: ManagedServiceEndpointProjectionInputV1,
): ManagedServiceEndpointProjectionV1 {
    const candidate = {
        v: 1,
        projectionToken: digest(projectionIdentity(input)),
        ...input,
    };
    const parsed = parseManagedServiceEndpointProjectionV1(candidate);
    if (!parsed) {
        throw new TypeError('Managed server endpoint projection is invalid');
    }
    return parsed;
}

export function parseManagedServiceEndpointProjectionV1(
    raw: unknown,
): ManagedServiceEndpointProjectionV1 | null {
    if (!isRecord(raw)) return null;
    if (!hasExactKeys(raw, PROJECTION_KEYS, ['operationClaimId'])) return null;
    const sessionId = readIdentity(raw.sessionId);
    const pluginId = readIdentity(raw.pluginId);
    const contributionId = readIdentity(raw.contributionId);
    const operationClaimId = raw.operationClaimId === undefined
        ? null
        : readIdentity(raw.operationClaimId);
    const serverId = readIdentity(raw.serverId);
    const instanceId = readIdentity(raw.instanceId);
    const immutableGenerationId = readIdentity(raw.immutableGenerationId);
    const process = isRecord(raw.process) && hasExactKeys(raw.process, ['pid', 'startIdentity'])
        ? raw.process
        : null;
    const processStartIdentity = readIdentity(process?.startIdentity);
    const endpoint = isRecord(raw.endpoint) && hasExactKeys(raw.endpoint, ['baseUrl', 'host', 'port'])
        ? raw.endpoint
        : null;
    const normalizedEndpoint = raw.mode === 'managedSpawn' || raw.mode === 'externalAttach'
        ? normalizeProjectedBaseUrl(endpoint?.baseUrl, raw.mode)
        : null;
    if (
        raw.v !== 1
        || !isFingerprint(raw.projectionToken)
        || !sessionId
        || !pluginId
        || !contributionId
        || (raw.operationClaimId !== undefined && !operationClaimId)
        || !serverId
        || !instanceId
        || !immutableGenerationId
        || (raw.custodyOwner !== 'daemon' && raw.custodyOwner !== 'sessionRunner')
        || (raw.mode !== 'managedSpawn' && raw.mode !== 'externalAttach')
        || !normalizedEndpoint
        || endpoint?.host !== normalizedEndpoint.host
        || endpoint.port !== normalizedEndpoint.port
        || !Number.isSafeInteger(raw.createdAtMs)
        || (raw.createdAtMs as number) < 0
    ) return null;
    if (
        raw.mode === 'managedSpawn'
        && (
            !Number.isSafeInteger(process?.pid)
            || (process?.pid as number) <= 1
            || !processStartIdentity
        )
    ) return null;
    if (raw.mode === 'externalAttach' && raw.process !== null) return null;
    const common = {
        sessionId,
        pluginId,
        contributionId,
        ...(operationClaimId ? { operationClaimId } : {}),
        serverId,
        instanceId,
        immutableGenerationId,
        custodyOwner: raw.custodyOwner as 'daemon' | 'sessionRunner',
        endpoint: normalizedEndpoint,
        createdAtMs: raw.createdAtMs as number,
    };
    const parsed: ManagedServiceEndpointProjectionInputV1 = raw.mode === 'managedSpawn'
        ? Object.freeze({
            ...common,
            mode: 'managedSpawn',
            process: Object.freeze({
                pid: process!.pid as number,
                startIdentity: processStartIdentity!,
            }),
        })
        : Object.freeze({
            ...common,
            mode: 'externalAttach',
            process: null,
        });
    const expectedToken = digest(projectionIdentity(parsed));
    if (raw.projectionToken !== expectedToken) return null;
    return Object.freeze({
        v: 1,
        projectionToken: expectedToken,
        ...parsed,
    });
}

function readPrivateJsonFile(path: string): unknown {
    try {
        const facts = lstatSync(path);
        if (!facts.isFile() || facts.isSymbolicLink() || facts.size > MAX_RECORD_BYTES) return null;
        return JSON.parse(readPrivateOwnerFileSync(path)) as unknown;
    } catch {
        return null;
    }
}

export function readManagedServiceEndpointProjectionCandidates(
    rootDir: string,
): readonly ManagedServiceEndpointProjectionV1[] {
    try {
        const projectionDir = join(rootDir, 'endpoint-projections');
        const directoryFacts = lstatSync(projectionDir);
        if (!directoryFacts.isDirectory() || directoryFacts.isSymbolicLink()) return Object.freeze([]);
        const entries = readdirSync(projectionDir)
            .filter((entry) => /^[a-f0-9]{64}\.json$/u.test(entry))
            .sort()
            .slice(0, MAX_PROJECTION_RECORDS);
        const projections: ManagedServiceEndpointProjectionV1[] = [];
        for (const entry of entries) {
            const projection = parseManagedServiceEndpointProjectionV1(
                readPrivateJsonFile(join(projectionDir, entry)),
            );
            if (
                !projection
                || entry !== `${digest(projection.instanceId)}.json`
            ) continue;
            projections.push(projection);
        }
        return Object.freeze(projections);
    } catch {
        return Object.freeze([]);
    }
}

export function managedServiceEndpointProjectionFileName(instanceId: string): string {
    const normalized = readIdentity(instanceId);
    if (!normalized) throw new TypeError('Managed server instance identity is invalid');
    return `${digest(normalized)}.json`;
}
