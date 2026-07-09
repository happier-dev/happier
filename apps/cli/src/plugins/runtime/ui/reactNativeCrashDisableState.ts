import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { withPluginStoreLock } from '@/plugins/store/lock';
import { ensurePluginStoreDirectories, resolvePluginStorePaths, type PluginStorePaths } from '@/plugins/store/paths';

const REACT_NATIVE_CRASH_DISABLE_STATE_FILE_NAME = 'react-native-crash-disable-state.v1.json';
const REACT_NATIVE_CRASH_DISABLE_STATE_LOCK_NAME = 'react-native-crash-disable-state.v1.lock';

const ReactNativeCrashDisableReasonSchema = z.enum([
    'render_error_threshold',
    'startup_ack_timeout_threshold',
]);
export type ReactNativeCrashDisableReason = z.infer<typeof ReactNativeCrashDisableReasonSchema>;

export const ReactNativeCrashDisableRecordV1Schema = z.object({
    pluginId: z.string().min(1),
    contributionId: z.string().min(1),
    cacheKey: z.string().min(1),
    artifactDigest: z.string().min(1),
    crashCount: z.number().int().nonnegative(),
    startupFailureCount: z.number().int().nonnegative(),
    disabled: z.boolean(),
    disabledReason: ReactNativeCrashDisableReasonSchema.optional(),
    updatedAtMs: z.number().int().nonnegative(),
    disabledAtMs: z.number().int().nonnegative().optional(),
}).strict();
export type ReactNativeCrashDisableRecordV1 = z.infer<typeof ReactNativeCrashDisableRecordV1Schema>;

export const ReactNativeCrashDisableStateFileV1Schema = z.object({
    t: z.literal('happier_plugin_react_native_crash_disable_state_v1'),
    schemaVersion: z.literal(1),
    records: z.record(z.string(), ReactNativeCrashDisableRecordV1Schema),
}).strict();
export type ReactNativeCrashDisableStateFileV1 = z.infer<typeof ReactNativeCrashDisableStateFileV1Schema>;

export type ReactNativeCrashDisableStateStore = Readonly<{
    paths: PluginStorePaths;
    stateFilePath: string;
    read: () => Promise<ReactNativeCrashDisableStateFileV1>;
    write: (next: ReactNativeCrashDisableStateFileV1) => Promise<void>;
    update: (
        transform: (
            current: ReactNativeCrashDisableStateFileV1,
        ) => Promise<ReactNativeCrashDisableStateFileV1> | ReactNativeCrashDisableStateFileV1,
    ) => Promise<ReactNativeCrashDisableStateFileV1>;
}>;

export type ReactNativeCrashDisableCurrentCacheIdentity = Readonly<{
    cacheKey: string;
    artifactDigest?: string;
}>;

export type ReactNativeCrashDisableReportRecordInput = Readonly<{
    store: ReactNativeCrashDisableStateStore;
    pluginId: string;
    contributionId: string;
    cacheKey: string;
    artifactDigest: string;
    disabledReason: ReactNativeCrashDisableReason;
    crashCount: number;
    startupFailureCount: number;
    observedAtMs?: number;
}>;

export function createReactNativeCrashDisableContributionKey(input: Readonly<{
    pluginId: string;
    contributionId: string;
}>): string {
    return `${input.pluginId}:${input.contributionId}`;
}

export function createEmptyReactNativeCrashDisableState(): ReactNativeCrashDisableStateFileV1 {
    return {
        t: 'happier_plugin_react_native_crash_disable_state_v1',
        schemaVersion: 1,
        records: {},
    };
}

export async function recordReactNativeCrashDisableReport(
    input: ReactNativeCrashDisableReportRecordInput,
): Promise<ReactNativeCrashDisableStateFileV1> {
    const contributionKey = createReactNativeCrashDisableContributionKey(input);
    const observedAtMs = input.observedAtMs ?? Date.now();
    return await input.store.update((current) => {
        const previous = current.records[contributionKey];
        const previousMatchesCurrentArtifact = previous?.cacheKey === input.cacheKey
            && previous.artifactDigest === input.artifactDigest;
        return {
            ...current,
            records: {
                ...current.records,
                [contributionKey]: {
                    pluginId: input.pluginId,
                    contributionId: input.contributionId,
                    cacheKey: input.cacheKey,
                    artifactDigest: input.artifactDigest,
                    crashCount: Math.max(previousMatchesCurrentArtifact ? previous.crashCount : 0, input.crashCount),
                    startupFailureCount: Math.max(
                        previousMatchesCurrentArtifact ? previous.startupFailureCount : 0,
                        input.startupFailureCount,
                    ),
                    disabled: true,
                    disabledReason: input.disabledReason,
                    updatedAtMs: observedAtMs,
                    disabledAtMs: previousMatchesCurrentArtifact
                        ? previous.disabledAtMs ?? observedAtMs
                        : observedAtMs,
                },
            },
        };
    });
}

function resolveReactNativeCrashDisableStateFilePath(paths: PluginStorePaths): string {
    return join(paths.stateDir, REACT_NATIVE_CRASH_DISABLE_STATE_FILE_NAME);
}

export function resolveReactNativeCrashDisabledContributionIdsForProjection(params: Readonly<{
    state: ReactNativeCrashDisableStateFileV1;
    currentCacheKeysByContributionId: Readonly<Record<string, ReactNativeCrashDisableCurrentCacheIdentity | undefined>>;
}>): readonly string[] {
    const disabledContributionIds: string[] = [];
    for (const record of Object.values(params.state.records)) {
        if (!record.disabled) continue;

        const contributionKey = createReactNativeCrashDisableContributionKey(record);
        const currentIdentity = params.currentCacheKeysByContributionId[contributionKey]
            ?? params.currentCacheKeysByContributionId[record.contributionId];
        if (!currentIdentity) continue;
        if (currentIdentity.cacheKey !== record.cacheKey) continue;
        if (currentIdentity.artifactDigest && currentIdentity.artifactDigest !== record.artifactDigest) continue;

        disabledContributionIds.push(contributionKey);
    }
    return Object.freeze(disabledContributionIds.sort((left, right) => left.localeCompare(right)));
}

export function createReactNativeCrashDisableStateStore(params?: Readonly<{ happyHomeDir?: string }>): ReactNativeCrashDisableStateStore {
    const paths = resolvePluginStorePaths(params);
    const stateFilePath = resolveReactNativeCrashDisableStateFilePath(paths);

    async function readUnlocked(): Promise<ReactNativeCrashDisableStateFileV1> {
        try {
            const raw = await readFile(stateFilePath, 'utf8');
            const parsedJson = JSON.parse(raw) as unknown;
            const parsed = ReactNativeCrashDisableStateFileV1Schema.safeParse(parsedJson);
            if (!parsed.success) {
                throw new Error('Invalid React Native crash-disable state file');
            }
            return parsed.data;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | null)?.code;
            if (code === 'ENOENT') {
                return createEmptyReactNativeCrashDisableState();
            }
            if (error instanceof SyntaxError) {
                throw new Error('Invalid React Native crash-disable state file');
            }
            throw error;
        }
    }

    async function writeUnlocked(next: ReactNativeCrashDisableStateFileV1): Promise<void> {
        const parsed = ReactNativeCrashDisableStateFileV1Schema.parse(next);
        await ensurePluginStoreDirectories({ happyHomeDir: paths.happyHomeDir });
        await writeJsonAtomic(stateFilePath, parsed);
    }

    return {
        paths,
        stateFilePath,
        async read(): Promise<ReactNativeCrashDisableStateFileV1> {
            return await readUnlocked();
        },
        async write(next: ReactNativeCrashDisableStateFileV1): Promise<void> {
            await withPluginStoreLock({
                paths,
                lockName: REACT_NATIVE_CRASH_DISABLE_STATE_LOCK_NAME,
                fn: async () => {
                    await writeUnlocked(next);
                },
            });
        },
        async update(transform): Promise<ReactNativeCrashDisableStateFileV1> {
            return await withPluginStoreLock({
                paths,
                lockName: REACT_NATIVE_CRASH_DISABLE_STATE_LOCK_NAME,
                fn: async () => {
                    const current = await readUnlocked();
                    const next = ReactNativeCrashDisableStateFileV1Schema.parse(await transform(current));
                    await writeUnlocked(next);
                    return next;
                },
            });
        },
    };
}
