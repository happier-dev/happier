import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
    DaemonPluginReactNativeCrashBindingTokenV1Schema,
    DaemonPluginReactNativeCrashFailureOccurrenceIdV1Schema,
    DaemonPluginReactNativeCrashFailureV1Schema,
    deriveDaemonPluginReactNativeCrashMountKeyV1,
    isSameDaemonPluginReactNativeCrashBindingTokenV1,
    type DaemonPluginReactNativeCrashBindingTokenV1,
    type DaemonPluginReactNativeCrashMountV1,
    type DaemonPluginReactNativeCrashFailureV1,
} from '@happier-dev/protocol';
import { z } from 'zod';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { withPluginStoreLock } from '@/plugins/store/lock';
import { ensurePluginStoreDirectories, resolvePluginStorePaths, type PluginStorePaths } from '@/plugins/store/paths';

const REACT_NATIVE_CRASH_STATE_FILE_NAME = 'react-native-crash-state.v3.json';
const REACT_NATIVE_CRASH_STATE_LOCK_NAME = 'react-native-crash-state.v3.lock';

const REACT_NATIVE_CRASH_FAILURE_THRESHOLD = 2;

export const ReactNativeCrashStateRecordV3Schema = z.object({
    token: DaemonPluginReactNativeCrashBindingTokenV1Schema,
    renderFailureCount: z.number().int().nonnegative(),
    disabled: z.boolean(),
    failureOccurrences: z.record(
        DaemonPluginReactNativeCrashFailureOccurrenceIdV1Schema,
        DaemonPluginReactNativeCrashFailureV1Schema,
    ),
}).strict();
export type ReactNativeCrashStateRecordV3 = z.infer<typeof ReactNativeCrashStateRecordV3Schema>;

export const ReactNativeCrashStateFileV3Schema = z.object({
    t: z.literal('happier_plugin_react_native_crash_state_v3'),
    schemaVersion: z.literal(3),
    records: z.record(z.string(), ReactNativeCrashStateRecordV3Schema),
}).strict();
export type ReactNativeCrashStateFileV3 = z.infer<typeof ReactNativeCrashStateFileV3Schema>;

export type ReactNativeCrashStateStore = Readonly<{
    paths: PluginStorePaths;
    stateFilePath: string;
    read: () => Promise<ReactNativeCrashStateFileV3>;
    update: (
        transform: (
            current: ReactNativeCrashStateFileV3,
        ) => Promise<ReactNativeCrashStateFileV3> | ReactNativeCrashStateFileV3,
    ) => Promise<ReactNativeCrashStateFileV3>;
}>;

export type ReactNativeCrashStateBinding = Readonly<{
    mount: DaemonPluginReactNativeCrashBindingTokenV1['mount'];
    renderer: DaemonPluginReactNativeCrashBindingTokenV1['renderer'];
    artifactDigest: DaemonPluginReactNativeCrashBindingTokenV1['artifactDigest'];
}>;

export type ReactNativeCrashStateProjection = Readonly<{
    token: DaemonPluginReactNativeCrashBindingTokenV1;
    disabled: boolean;
}>;

export type ReactNativeCrashStateReconciliation = Readonly<{
    state: ReactNativeCrashStateFileV3;
    statesByBindingKey: Readonly<Record<string, ReactNativeCrashStateProjection | undefined>>;
}>;

export type ReactNativeCrashFailureRecordResult = Readonly<{
    state: ReactNativeCrashStateFileV3;
    status: 'recorded' | 'rejoined' | 'failure_occurrence_conflict' | 'binding_token_mismatch' | 'ignored_disabled';
    disabled: boolean;
}>;

export type ReactNativeCrashResetResult = Readonly<{
    state: ReactNativeCrashStateFileV3;
    status: 'reset' | 'binding_token_mismatch';
    token?: DaemonPluginReactNativeCrashBindingTokenV1;
}>;

function cloneToken(token: DaemonPluginReactNativeCrashBindingTokenV1): DaemonPluginReactNativeCrashBindingTokenV1 {
    return {
        mount: cloneMount(token.mount),
        renderer: { ...token.renderer },
        artifactDigest: token.artifactDigest,
        crashStateEpoch: token.crashStateEpoch,
    };
}

function sameQualifiedIdentity(
    left: Readonly<{ pluginId: string; localId: string }>,
    right: Readonly<{ pluginId: string; localId: string }>,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function cloneMount(mount: DaemonPluginReactNativeCrashMountV1): DaemonPluginReactNativeCrashMountV1 {
    if (mount.kind === 'destination') {
        return {
            kind: 'destination',
            destination: { ...mount.destination },
        };
    }
    if (mount.kind === 'inline') {
        return {
            kind: 'inline',
            surface: { ...mount.surface },
            role: mount.role,
        };
    }
    if (mount.kind === 'composer') {
        return {
            kind: 'composer',
            contribution: { ...mount.contribution },
            immutableGenerationId: mount.immutableGenerationId,
            role: mount.role,
        };
    }
    if (mount.kind === 'automationEventSetupSurface') {
        return {
            kind: 'automationEventSetupSurface',
            contribution: { ...mount.contribution },
            immutableGenerationId: mount.immutableGenerationId,
        };
    }
    return {
            kind: 'targetedSurface',
            target: { ...mount.target },
            point: {
                pointId: mount.point.pointId,
                protocol: { ...mount.point.protocol },
            },
            contributor: { ...mount.contributor },
            role: mount.role,
            presentation: mount.presentation,
    };
}

function sameMount(
    left: DaemonPluginReactNativeCrashMountV1,
    right: DaemonPluginReactNativeCrashMountV1,
): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === 'destination' && right.kind === 'destination') {
        return sameQualifiedIdentity(left.destination, right.destination);
    }
    if (left.kind === 'inline' && right.kind === 'inline') {
        return sameQualifiedIdentity(left.surface, right.surface)
            && left.role === right.role;
    }
    if (left.kind === 'composer' && right.kind === 'composer') {
        return sameQualifiedIdentity(left.contribution, right.contribution)
            && left.immutableGenerationId === right.immutableGenerationId
            && left.role === right.role;
    }
    if (left.kind === 'automationEventSetupSurface' && right.kind === 'automationEventSetupSurface') {
        return sameQualifiedIdentity(left.contribution, right.contribution)
            && left.immutableGenerationId === right.immutableGenerationId;
    }
    if (left.kind !== 'targetedSurface' || right.kind !== 'targetedSurface') return false;
    return left.target.pluginId === right.target.pluginId
        && left.target.immutableGenerationId === right.target.immutableGenerationId
        && left.point.pointId === right.point.pointId
        && left.point.protocol.id === right.point.protocol.id
        && left.point.protocol.version === right.point.protocol.version
        && left.contributor.pluginId === right.contributor.pluginId
        && left.contributor.contributionId === right.contributor.contributionId
        && left.contributor.immutableGenerationId === right.contributor.immutableGenerationId
        && left.role === right.role
        && left.presentation === right.presentation;
}

function createRecord(binding: ReactNativeCrashStateBinding, crashStateEpoch: number): ReactNativeCrashStateRecordV3 {
    return {
        token: {
            mount: cloneMount(binding.mount),
            renderer: { ...binding.renderer },
            artifactDigest: binding.artifactDigest,
            crashStateEpoch,
        },
        renderFailureCount: 0,
        disabled: false,
        failureOccurrences: {},
    };
}

function toProjection(record: ReactNativeCrashStateRecordV3): ReactNativeCrashStateProjection {
    return Object.freeze({
        token: Object.freeze(cloneToken(record.token)),
        disabled: record.disabled,
    });
}

function normalizeBindings(bindings: readonly ReactNativeCrashStateBinding[]): readonly ReactNativeCrashStateBinding[] {
    const bindingsByKey = new Map<string, ReactNativeCrashStateBinding>();
    for (const binding of bindings) {
        const key = createReactNativeCrashStateBindingKey(binding);
        const previous = bindingsByKey.get(key);
        if (previous && previous.artifactDigest !== binding.artifactDigest) {
            throw new Error('React Native crash-state reconciliation received conflicting current artifact digests');
        }
        bindingsByKey.set(key, binding);
    }
    return Object.freeze([...bindingsByKey.values()]);
}

export function createReactNativeCrashStateBindingKey(input: Readonly<{
    mount: DaemonPluginReactNativeCrashBindingTokenV1['mount'];
    renderer: DaemonPluginReactNativeCrashBindingTokenV1['renderer'];
}>): string {
    return JSON.stringify([
        deriveDaemonPluginReactNativeCrashMountKeyV1(input.mount),
        input.renderer.pluginId,
        input.renderer.localId,
    ]);
}

function createEmptyReactNativeCrashState(): ReactNativeCrashStateFileV3 {
    return {
        t: 'happier_plugin_react_native_crash_state_v3',
        schemaVersion: 3,
        records: {},
    };
}

/**
 * The daemon creates/refreshes the one current binding state before projecting
 * it. Artifact replacement is the only automatic reset: it advances the epoch
 * and clears counts, disablement, and retained occurrence IDs together.
 */
export async function reconcileReactNativeCrashStateBindings(input: Readonly<{
    store: ReactNativeCrashStateStore;
    bindings: readonly ReactNativeCrashStateBinding[];
}>): Promise<ReactNativeCrashStateReconciliation> {
    const bindings = normalizeBindings(input.bindings);
    const state = await input.store.update((current) => {
        let records = current.records;
        let changed = false;

        for (const binding of bindings) {
            const bindingKey = createReactNativeCrashStateBindingKey(binding);
            const previous = records[bindingKey];
            if (!previous) {
                if (!changed) records = { ...records };
                records[bindingKey] = createRecord(binding, 0);
                changed = true;
                continue;
            }
            // A targeted mount's durable slot deliberately survives immutable
            // generation changes. Its exact admitted target/contributor facts
            // still fence the live token, so replacing either generation must
            // reset the slot even when the generated bytes are unchanged.
            if (
                sameMount(previous.token.mount, binding.mount)
                && previous.token.artifactDigest === binding.artifactDigest
            ) {
                continue;
            }
            if (previous.token.crashStateEpoch >= Number.MAX_SAFE_INTEGER) {
                throw new Error('React Native crash-state epoch exhausted');
            }
            if (!changed) records = { ...records };
            records[bindingKey] = createRecord(binding, previous.token.crashStateEpoch + 1);
            changed = true;
        }

        return changed ? { ...current, records } : current;
    });

    const statesByBindingKey: Record<string, ReactNativeCrashStateProjection | undefined> = {};
    for (const binding of bindings) {
        const bindingKey = createReactNativeCrashStateBindingKey(binding);
        const record = state.records[bindingKey];
        if (record) statesByBindingKey[bindingKey] = toProjection(record);
    }
    return Object.freeze({
        state,
        statesByBindingKey: Object.freeze(statesByBindingKey),
    });
}

/**
 * Reconciles one UI-created failure occurrence under the daemon lock. The
 * occurrence mapping is bounded naturally by the disable threshold: once the
 * binding is disabled, new occurrence IDs do not change state.
 */
export async function recordReactNativeCrashFailure(input: Readonly<{
    store: ReactNativeCrashStateStore;
    token: DaemonPluginReactNativeCrashBindingTokenV1;
    failureOccurrenceId: string;
    failure: DaemonPluginReactNativeCrashFailureV1;
}>): Promise<ReactNativeCrashFailureRecordResult> {
    const occurrenceId = DaemonPluginReactNativeCrashFailureOccurrenceIdV1Schema.parse(input.failureOccurrenceId);
    const failure = DaemonPluginReactNativeCrashFailureV1Schema.parse(input.failure);
    const bindingKey = createReactNativeCrashStateBindingKey(input.token);
    let status: ReactNativeCrashFailureRecordResult['status'] = 'binding_token_mismatch';
    let disabled = false;

    const state = await input.store.update((current) => {
        const previous = current.records[bindingKey];
        if (!previous || !isSameDaemonPluginReactNativeCrashBindingTokenV1(previous.token, input.token)) return current;

        const existingFailure = previous.failureOccurrences[occurrenceId];
        if (existingFailure !== undefined) {
            status = existingFailure === failure ? 'rejoined' : 'failure_occurrence_conflict';
            disabled = previous.disabled;
            return current;
        }
        if (previous.disabled) {
            status = 'ignored_disabled';
            disabled = true;
            return current;
        }

        const next: ReactNativeCrashStateRecordV3 = {
            ...previous,
            renderFailureCount: previous.renderFailureCount + 1,
            failureOccurrences: {
                ...previous.failureOccurrences,
                [occurrenceId]: failure,
            },
        };
        next.disabled = next.renderFailureCount >= REACT_NATIVE_CRASH_FAILURE_THRESHOLD;
        status = 'recorded';
        disabled = next.disabled;
        return {
            ...current,
            records: {
                ...current.records,
                [bindingKey]: next,
            },
        };
    });

    return Object.freeze({ state, status, disabled });
}

/**
 * Same-digest recovery is a daemon-owned operation. Mount-local Retry never
 * calls this function.
 */
export async function resetReactNativeCrashState(input: Readonly<{
    store: ReactNativeCrashStateStore;
    token: DaemonPluginReactNativeCrashBindingTokenV1;
}>): Promise<ReactNativeCrashResetResult> {
    const bindingKey = createReactNativeCrashStateBindingKey(input.token);
    let resetToken: DaemonPluginReactNativeCrashBindingTokenV1 | undefined;

    const state = await input.store.update((current) => {
        const previous = current.records[bindingKey];
        if (!previous || !isSameDaemonPluginReactNativeCrashBindingTokenV1(previous.token, input.token)) return current;
        if (previous.token.crashStateEpoch >= Number.MAX_SAFE_INTEGER) {
            throw new Error('React Native crash-state epoch exhausted');
        }
        const next = createRecord({
            mount: previous.token.mount,
            renderer: previous.token.renderer,
            artifactDigest: previous.token.artifactDigest,
        }, previous.token.crashStateEpoch + 1);
        resetToken = cloneToken(next.token);
        return {
            ...current,
            records: {
                ...current.records,
                [bindingKey]: next,
            },
        };
    });

    return Object.freeze(resetToken
        ? { state, status: 'reset' as const, token: resetToken }
        : { state, status: 'binding_token_mismatch' as const });
}

function resolveReactNativeCrashStateFilePath(paths: PluginStorePaths): string {
    return join(paths.stateDir, REACT_NATIVE_CRASH_STATE_FILE_NAME);
}

export function createReactNativeCrashStateStore(params?: Readonly<{ happyHomeDir?: string }>): ReactNativeCrashStateStore {
    const paths = resolvePluginStorePaths(params);
    const stateFilePath = resolveReactNativeCrashStateFilePath(paths);

    async function readUnlocked(): Promise<ReactNativeCrashStateFileV3> {
        try {
            const raw = await readFile(stateFilePath, 'utf8');
            const parsedJson = JSON.parse(raw) as unknown;
            const parsed = ReactNativeCrashStateFileV3Schema.safeParse(parsedJson);
            if (!parsed.success) {
                throw new Error('Invalid React Native crash-state file');
            }
            return parsed.data;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | null)?.code;
            if (code === 'ENOENT') return createEmptyReactNativeCrashState();
            if (error instanceof SyntaxError) throw new Error('Invalid React Native crash-state file');
            throw error;
        }
    }

    async function writeUnlocked(next: ReactNativeCrashStateFileV3): Promise<void> {
        const parsed = ReactNativeCrashStateFileV3Schema.parse(next);
        await ensurePluginStoreDirectories({ happyHomeDir: paths.happyHomeDir });
        await writeJsonAtomic(stateFilePath, parsed);
    }

    return {
        paths,
        stateFilePath,
        async read(): Promise<ReactNativeCrashStateFileV3> {
            return await readUnlocked();
        },
        async update(transform): Promise<ReactNativeCrashStateFileV3> {
            return await withPluginStoreLock({
                paths,
                lockName: REACT_NATIVE_CRASH_STATE_LOCK_NAME,
                fn: async () => {
                    const current = await readUnlocked();
                    const next = ReactNativeCrashStateFileV3Schema.parse(await transform(current));
                    await writeUnlocked(next);
                    return next;
                },
            });
        },
    };
}
