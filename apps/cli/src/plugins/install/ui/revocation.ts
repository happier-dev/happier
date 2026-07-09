import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import {
    verifyPluginUiArtifactRevocationFeedV1,
    type PluginUiArtifactRevocationFeedEnvelopeV1,
    type PluginUiArtifactTrustRootV1,
    PluginUiArtifactRevocationV1Schema,
    type PluginUiArtifactRevocationV1,
} from '@happier-dev/protocol';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { withPluginStoreLock } from '@/plugins/store/lock';
import { ensurePluginStoreDirectories, resolvePluginStorePaths, type PluginStorePaths } from '@/plugins/store/paths';

const PLUGIN_UI_ARTIFACT_REVOCATION_FEED_FILE_NAME = 'plugin-ui-artifact-revocations.v1.json';
const PLUGIN_UI_ARTIFACT_REVOCATION_FEED_LOCK_NAME = 'plugin-ui-artifact-revocations.v1.lock';

export type PluginUiArtifactRevocationState = Readonly<{
    generation: number;
    revokedDigests: ReadonlySet<string>;
    revocations: readonly PluginUiArtifactRevocationV1[];
}>;

export type PluginUiArtifactRevocationCandidate = Readonly<{
    pluginId: string;
    contributionId: string;
    digest: string;
    signingKeyId?: string;
    trustRootId?: string;
    installSourceId?: string;
}>;

export const PluginUiArtifactRevocationFeedFileV1Schema = z.object({
    t: z.literal('happier_plugin_ui_artifact_revocation_feed_v1'),
    schemaVersion: z.literal(1),
    generation: z.number().int().nonnegative(),
    revocations: z.record(z.string(), PluginUiArtifactRevocationV1Schema),
}).strict();
export type PluginUiArtifactRevocationFeedFileV1 = z.infer<typeof PluginUiArtifactRevocationFeedFileV1Schema>;

export type PluginUiArtifactRevocationFeedStore = Readonly<{
    paths: PluginStorePaths;
    stateFilePath: string;
    read: () => Promise<PluginUiArtifactRevocationFeedFileV1>;
    write: (next: PluginUiArtifactRevocationFeedFileV1) => Promise<void>;
    update: (
        transform: (
            current: PluginUiArtifactRevocationFeedFileV1,
        ) => Promise<PluginUiArtifactRevocationFeedFileV1> | PluginUiArtifactRevocationFeedFileV1,
    ) => Promise<PluginUiArtifactRevocationFeedFileV1>;
}>;

export function createPluginUiArtifactRevocationState(params: Readonly<{
    generation?: number;
    revokedDigests?: ReadonlySet<string>;
    revocations?: readonly PluginUiArtifactRevocationV1[];
}> = {}): PluginUiArtifactRevocationState {
    return Object.freeze({
        generation: params.generation ?? 0,
        revokedDigests: params.revokedDigests ?? new Set<string>(),
        revocations: Object.freeze([...(params.revocations ?? [])]),
    });
}

export function createEmptyPluginUiArtifactRevocationState(): PluginUiArtifactRevocationState {
    return createPluginUiArtifactRevocationState();
}

export function mergePluginUiArtifactRevocationStates(
    ...states: readonly PluginUiArtifactRevocationState[]
): PluginUiArtifactRevocationState {
    const revokedDigests = new Set<string>();
    const revocationsById = new Map<string, PluginUiArtifactRevocationV1>();
    let generation = 0;
    for (const state of states) {
        generation = Math.max(generation, state.generation);
        for (const digest of state.revokedDigests) {
            revokedDigests.add(digest);
        }
        for (const revocation of state.revocations) {
            revocationsById.set(revocation.id, revocation);
        }
    }
    return createPluginUiArtifactRevocationState({
        generation,
        revokedDigests,
        revocations: [...revocationsById.values()],
    });
}

function createEmptyPluginUiArtifactRevocationFeedFile(): PluginUiArtifactRevocationFeedFileV1 {
    return {
        t: 'happier_plugin_ui_artifact_revocation_feed_v1',
        schemaVersion: 1,
        generation: 0,
        revocations: {},
    };
}

function resolvePluginUiArtifactRevocationFeedFilePath(paths: PluginStorePaths): string {
    return join(paths.stateDir, PLUGIN_UI_ARTIFACT_REVOCATION_FEED_FILE_NAME);
}

export function resolvePluginUiArtifactRevocationStateFromFeed(
    feed: PluginUiArtifactRevocationFeedFileV1,
): PluginUiArtifactRevocationState {
    return createPluginUiArtifactRevocationState({
        generation: feed.generation,
        revocations: Object.values(feed.revocations),
    });
}

export async function recordPluginUiArtifactRevocations(input: Readonly<{
    store: PluginUiArtifactRevocationFeedStore;
    generation: number;
    revocations: readonly PluginUiArtifactRevocationV1[];
}>): Promise<PluginUiArtifactRevocationFeedFileV1> {
    return await input.store.update((current) => {
        const nextRevocations = { ...current.revocations };
        for (const revocation of input.revocations) {
            nextRevocations[revocation.id] = revocation;
        }
        return {
            ...current,
            generation: Math.max(current.generation, input.generation),
            revocations: nextRevocations,
        };
    });
}

export type RecordSignedPluginUiArtifactRevocationFeedResult =
    | Readonly<{ ok: true; feed: PluginUiArtifactRevocationFeedFileV1 }>
    | Readonly<{ ok: false; code: 'revocation_feed_invalid' | 'revocation_feed_stale' }>;

export async function recordSignedPluginUiArtifactRevocationFeed(input: Readonly<{
    store: PluginUiArtifactRevocationFeedStore;
    envelope: PluginUiArtifactRevocationFeedEnvelopeV1;
    trustRoots: readonly PluginUiArtifactTrustRootV1[];
}>): Promise<RecordSignedPluginUiArtifactRevocationFeedResult> {
    let result: RecordSignedPluginUiArtifactRevocationFeedResult | undefined;
    await input.store.update((current) => {
        const verification = verifyPluginUiArtifactRevocationFeedV1({
            envelope: input.envelope,
            trustRoots: input.trustRoots,
            minGeneration: current.generation + 1,
        });
        if (!verification.valid) {
            result = Object.freeze({
                ok: false,
                code: verification.reasonCode === 'stale_generation'
                    ? 'revocation_feed_stale'
                    : 'revocation_feed_invalid',
            });
            return current;
        }

        const nextRevocations = { ...current.revocations };
        for (const revocation of verification.body.revocations) {
            nextRevocations[revocation.id] = revocation;
        }
        const feed = {
            ...current,
            generation: verification.body.generation,
            revocations: nextRevocations,
        };
        result = Object.freeze({ ok: true, feed });
        return feed;
    });
    return result ?? Object.freeze({ ok: false, code: 'revocation_feed_invalid' });
}

export function createPluginUiArtifactRevocationFeedStore(params?: Readonly<{ happyHomeDir?: string }>): PluginUiArtifactRevocationFeedStore {
    const paths = resolvePluginStorePaths(params);
    const stateFilePath = resolvePluginUiArtifactRevocationFeedFilePath(paths);

    async function readUnlocked(): Promise<PluginUiArtifactRevocationFeedFileV1> {
        try {
            const raw = await readFile(stateFilePath, 'utf8');
            const parsedJson = JSON.parse(raw) as unknown;
            const parsed = PluginUiArtifactRevocationFeedFileV1Schema.safeParse(parsedJson);
            if (!parsed.success) {
                throw new Error('Invalid plugin UI artifact revocation feed file');
            }
            return parsed.data;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | null)?.code;
            if (code === 'ENOENT') {
                return createEmptyPluginUiArtifactRevocationFeedFile();
            }
            if (error instanceof SyntaxError) {
                throw new Error('Invalid plugin UI artifact revocation feed file');
            }
            throw error;
        }
    }

    async function writeUnlocked(next: PluginUiArtifactRevocationFeedFileV1): Promise<void> {
        const parsed = PluginUiArtifactRevocationFeedFileV1Schema.parse(next);
        await ensurePluginStoreDirectories({ happyHomeDir: paths.happyHomeDir });
        await writeJsonAtomic(stateFilePath, parsed);
    }

    return {
        paths,
        stateFilePath,
        async read(): Promise<PluginUiArtifactRevocationFeedFileV1> {
            return await readUnlocked();
        },
        async write(next: PluginUiArtifactRevocationFeedFileV1): Promise<void> {
            await withPluginStoreLock({
                paths,
                lockName: PLUGIN_UI_ARTIFACT_REVOCATION_FEED_LOCK_NAME,
                fn: async () => {
                    await writeUnlocked(next);
                },
            });
        },
        async update(transform): Promise<PluginUiArtifactRevocationFeedFileV1> {
            return await withPluginStoreLock({
                paths,
                lockName: PLUGIN_UI_ARTIFACT_REVOCATION_FEED_LOCK_NAME,
                fn: async () => {
                    const current = await readUnlocked();
                    const next = PluginUiArtifactRevocationFeedFileV1Schema.parse(await transform(current));
                    await writeUnlocked(next);
                    return next;
                },
            });
        },
    };
}

export function isPluginUiArtifactRevoked(
    candidate: PluginUiArtifactRevocationCandidate,
    state: PluginUiArtifactRevocationState,
): boolean {
    const revokedDigests = state.revokedDigests ?? new Set<string>();
    if (revokedDigests.has(candidate.digest)) {
        return true;
    }

    return (state.revocations ?? []).some((revocation) => {
        const scope = revocation.scope;
        switch (scope.kind) {
            case 'plugin':
                return scope.pluginId === candidate.pluginId;
            case 'contribution':
                return scope.pluginId === candidate.pluginId
                    && scope.contributionId === candidate.contributionId;
            case 'digest':
                return scope.digest === candidate.digest;
            case 'signingKey':
                return candidate.signingKeyId === scope.signingKeyId;
            case 'trustRoot':
                return candidate.trustRootId === scope.trustRootId;
            case 'installSource':
                return candidate.installSourceId === scope.sourceId;
            default:
                return false;
        }
    });
}
