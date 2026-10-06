import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
    resolveManagedServerLightPathEnvValue,
    resolvePersonalHomeRuntimeLayout,
    replacePersonalHomeFileDurably,
} from '@happier-dev/cli-common/firstPartyRuntime/server';
import {
    IrohEndpointIdV1Schema,
    type HomeConnectionEndpointV1,
} from '@happier-dev/protocol';
import { compareAndSetSimpleCache, compareAndSetSimpleCacheInTx, readFromSimpleCache } from '@/storage/cache/simpleCache';
import type { Tx } from '@/storage/inTx';
import { isPersonalHomeRuntimePurpose } from '@/app/runtime/personalHomeRuntimePurpose';

export type HomeConnectionDescriptorContinuity = Readonly<{
    revision: number;
    contentKey: string;
    /** Last durably published native/service EndpointId, retained across explicit retirement. */
    irohEndpointId?: string;
}>;

export type HomeConnectionDescriptorContinuityStore = Readonly<{
    read: (tx?: Tx) => Promise<HomeConnectionDescriptorContinuity | null>;
    write: (continuity: HomeConnectionDescriptorContinuity, tx?: Tx) => Promise<HomeConnectionDescriptorContinuityWriteResult>;
}>;

export type HomeConnectionDescriptorContinuityWriteResult = Readonly<{
    status: 'committed' | 'unchanged' | 'superseded';
    continuity: HomeConnectionDescriptorContinuity;
}>;

export class HomeConnectionDescriptorContinuityMalformedError extends Error {
    constructor() {
        super('Home connection descriptor continuity is malformed');
        this.name = 'HomeConnectionDescriptorContinuityMalformedError';
    }
}

export const HOME_CONNECTION_DESCRIPTOR_CONTINUITY_CACHE_KEY = 'home.connection-descriptor.continuity.v1';

export function resolveHomeConnectionDescriptorContinuityPath(irohEndpointKeyPath: string): string {
    return join(dirname(irohEndpointKeyPath), 'home.descriptor.json');
}

/**
 * Selects the server lifecycle's durable descriptor-continuity path once at
 * startup. Managed Personal Home consumes its canonical runtime layout and a
 * general file-backed server uses its already-owned light data directory.
 * Full PostgreSQL/MySQL servers use the existing namespaced `simpleCache`
 * owner, so the same full relay can publish as both Home and Account Service
 * without fabricating Personal Home filesystem state.
 */
type HomeConnectionDescriptorContinuityStoreDependencies = Readonly<{
    readSimpleCache: (key: string, tx?: Tx) => Promise<string | null>;
    compareAndSetSimpleCache: (key: string, expectedValue: string | null, nextValue: string, tx?: Tx) => Promise<boolean>;
}>;

const defaultStoreDependencies: HomeConnectionDescriptorContinuityStoreDependencies = {
    readSimpleCache: (key, tx) => readFromSimpleCache(key, tx),
    compareAndSetSimpleCache: (key, expectedValue, nextValue, tx) => tx
        ? compareAndSetSimpleCacheInTx(tx, key, expectedValue, nextValue)
        : compareAndSetSimpleCache(key, expectedValue, nextValue),
};

export function createHomeConnectionDescriptorContinuityStoreForServer(
    env: NodeJS.ProcessEnv,
    dependencies: HomeConnectionDescriptorContinuityStoreDependencies = defaultStoreDependencies,
): HomeConnectionDescriptorContinuityStore | null {
    const managedPurpose = String(env.HAPPIER_MANAGED_RELAY_PURPOSE ?? '').trim();
    if (isPersonalHomeRuntimePurpose(managedPurpose)) {
        return createFileHomeConnectionDescriptorContinuityStore(
            resolveHomeConnectionDescriptorContinuityPath(
                resolvePersonalHomeRuntimeLayout({ env }).irohEndpointKeyPath,
            ),
        );
    }

    const dbProvider = String(env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER ?? '').trim();
    if (dbProvider === 'postgres' || dbProvider === 'mysql') {
        return createSimpleCacheHomeConnectionDescriptorContinuityStore(dependencies);
    }
    if (dbProvider === 'sqlite' || dbProvider === 'pglite') {
        const dataDir = resolveManagedServerLightPathEnvValue(
            env,
            'HAPPIER_SERVER_LIGHT_DATA_DIR',
            'HAPPY_SERVER_LIGHT_DATA_DIR',
        ).trim();
        if (!dataDir) return null;
        return createFileHomeConnectionDescriptorContinuityStore(
            join(dataDir, 'runtime', 'home.descriptor.json'),
        );
    }
    return null;
}

const CONTENT_KEY_PATTERN = /^v1:([in]):([0-9a-f]{64})$/;
const SIMPLE_CACHE_VALUE_MAX_LENGTH = 191;

export function createHomeConnectionDescriptorContentKey(params: Readonly<{
    homeServerIdentityId: string;
    canonicalServerUrl: string;
    endpoints: readonly HomeConnectionEndpointV1[];
}>): string {
    const canonicalContent = JSON.stringify([
        params.homeServerIdentityId,
        params.canonicalServerUrl,
        params.endpoints,
    ]);
    const irohMarker = params.endpoints.some((endpoint) => endpoint.kind === 'iroh') ? 'i' : 'n';
    return `v1:${irohMarker}:${createHash('sha256').update(canonicalContent).digest('hex')}`;
}

export function homeConnectionDescriptorContentKeyCarriesIroh(contentKey: string | undefined): boolean {
    return contentKey?.startsWith('v1:i:') === true && CONTENT_KEY_PATTERN.test(contentKey);
}

function parseHomeConnectionDescriptorContinuity(value: unknown): HomeConnectionDescriptorContinuity {
    if (!value || typeof value !== 'object') {
        throw new HomeConnectionDescriptorContinuityMalformedError();
    }
    const record = value as Record<string, unknown>;
    // Strict persisted shape: the only writer is this module's serializer and
    // it always emits `v1:[in]:[64 hex]` (compatibility confirmation for
    // Lane 06 A9 found no released or predecessor JSON-array producer).
    const contentKey = typeof record.contentKey === 'string' && CONTENT_KEY_PATTERN.test(record.contentKey)
        ? record.contentKey
        : null;
    const irohEndpointId = record.irohEndpointId === undefined
        ? undefined
        : IrohEndpointIdV1Schema.safeParse(record.irohEndpointId);
    const continuity = Number.isSafeInteger(record.revision) && Number(record.revision) > 0
        && contentKey !== null
        && (irohEndpointId === undefined || irohEndpointId.success)
        ? {
            revision: Number(record.revision),
            contentKey,
            ...(irohEndpointId === undefined ? {} : { irohEndpointId: irohEndpointId.data }),
        }
        : null;
    if (!continuity) throw new HomeConnectionDescriptorContinuityMalformedError();
    return continuity;
}

function parseSerializedContinuity(raw: string): HomeConnectionDescriptorContinuity {
    try {
        return parseHomeConnectionDescriptorContinuity(JSON.parse(raw));
    } catch (error) {
        if (error instanceof HomeConnectionDescriptorContinuityMalformedError) throw error;
        throw new HomeConnectionDescriptorContinuityMalformedError();
    }
}

function serializeContinuity(continuity: HomeConnectionDescriptorContinuity): string {
    const normalized = parseHomeConnectionDescriptorContinuity(continuity);
    if (normalized.contentKey !== continuity.contentKey) {
        throw new HomeConnectionDescriptorContinuityMalformedError();
    }
    const serialized = JSON.stringify(normalized);
    if (serialized.length > SIMPLE_CACHE_VALUE_MAX_LENGTH) {
        throw new HomeConnectionDescriptorContinuityMalformedError();
    }
    return serialized;
}

function sameContinuity(
    a: HomeConnectionDescriptorContinuity,
    b: HomeConnectionDescriptorContinuity,
): boolean {
    return a.revision === b.revision
        && a.contentKey === b.contentKey
        && a.irohEndpointId === b.irohEndpointId;
}

function sameDescriptorGeneration(
    a: HomeConnectionDescriptorContinuity,
    b: HomeConnectionDescriptorContinuity,
): boolean {
    return a.revision === b.revision && a.contentKey === b.contentKey;
}

function resolveSameGenerationResult(
    current: HomeConnectionDescriptorContinuity,
    candidate: HomeConnectionDescriptorContinuity,
): HomeConnectionDescriptorContinuityWriteResult | null {
    if (!sameDescriptorGeneration(current, candidate)) return null;
    if (sameContinuity(current, candidate)) {
        return { status: 'unchanged', continuity: current };
    }
    // An A10 continuity record may predate the A12 EndpointId field. Enriching
    // that same descriptor generation is the only allowed equal-revision write.
    if (current.irohEndpointId === undefined && candidate.irohEndpointId !== undefined) {
        return null;
    }
    // Never erase or replace an already-pinned EndpointId at the same
    // generation. The publication owner will fail a live mismatch closed.
    return { status: current.irohEndpointId === candidate.irohEndpointId ? 'unchanged' : 'superseded', continuity: current };
}

export function createFileHomeConnectionDescriptorContinuityStore(
    path: string,
): HomeConnectionDescriptorContinuityStore {
    return {
        read: async () => await readHomeConnectionDescriptorContinuity(path),
        write: async (continuity) => {
            const normalized = parseHomeConnectionDescriptorContinuity(continuity);
            const current = await readHomeConnectionDescriptorContinuity(path);
            if (current) {
                const sameGenerationResult = resolveSameGenerationResult(current, normalized);
                if (sameGenerationResult) return sameGenerationResult;
            }
            if (current && current.revision >= normalized.revision
                && !sameDescriptorGeneration(current, normalized)) {
                return { status: 'superseded', continuity: current };
            }
            await writeHomeConnectionDescriptorContinuity(path, normalized);
            return { status: 'committed', continuity: normalized };
        },
    };
}

export function createSimpleCacheHomeConnectionDescriptorContinuityStore(
    dependencies: HomeConnectionDescriptorContinuityStoreDependencies = defaultStoreDependencies,
): HomeConnectionDescriptorContinuityStore {
    return {
        read: async (tx) => {
            const raw = await dependencies.readSimpleCache(HOME_CONNECTION_DESCRIPTOR_CONTINUITY_CACHE_KEY, tx);
            return raw === null ? null : parseSerializedContinuity(raw);
        },
        write: async (continuity, tx) => {
            const normalized = parseHomeConnectionDescriptorContinuity(continuity);
            const nextValue = serializeContinuity(normalized);
            while (true) {
                const observedRaw = await dependencies.readSimpleCache(HOME_CONNECTION_DESCRIPTOR_CONTINUITY_CACHE_KEY, tx);
                const observed = observedRaw === null ? null : parseSerializedContinuity(observedRaw);
                if (observed) {
                    const sameGenerationResult = resolveSameGenerationResult(observed, normalized);
                    if (sameGenerationResult?.status === 'unchanged') {
                        if (observedRaw === nextValue) return sameGenerationResult;
                        if (await dependencies.compareAndSetSimpleCache(
                            HOME_CONNECTION_DESCRIPTOR_CONTINUITY_CACHE_KEY,
                            observedRaw,
                            serializeContinuity(sameGenerationResult.continuity),
                            tx,
                        )) {
                            return sameGenerationResult;
                        }
                        continue;
                    }
                    if (sameGenerationResult?.status === 'superseded') return sameGenerationResult;
                }
                if (observed && observed.revision >= normalized.revision
                    && !sameDescriptorGeneration(observed, normalized)) {
                    return { status: 'superseded', continuity: observed };
                }
                if (await dependencies.compareAndSetSimpleCache(
                    HOME_CONNECTION_DESCRIPTOR_CONTINUITY_CACHE_KEY,
                    observedRaw,
                    nextValue,
                    tx,
                )) {
                    return { status: 'committed', continuity: normalized };
                }
            }
        },
    };
}

export async function readHomeConnectionDescriptorContinuity(
    path: string,
): Promise<HomeConnectionDescriptorContinuity | null> {
    try {
        return parseSerializedContinuity(await readFile(path, 'utf8'));
    } catch (error) {
        if (
            error !== null
            && typeof error === 'object'
            && 'code' in error
            && error.code === 'ENOENT'
        ) {
            return null;
        }
        throw error;
    }
}

export async function writeHomeConnectionDescriptorContinuity(
    path: string,
    continuity: HomeConnectionDescriptorContinuity,
): Promise<void> {
    const serialized = serializeContinuity(continuity);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, `${serialized}\n`, { encoding: 'utf8', mode: 0o600 });
        await replacePersonalHomeFileDurably(temporaryPath, path);
    } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}
