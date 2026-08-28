import {
    DaemonPluginReactNativeCrashBindingTokenV1Schema,
    DaemonPluginReactNativeCrashFailureOccurrenceIdV1Schema,
    DaemonPluginReactNativeCrashFailureV1Schema,
    isSameDaemonPluginReactNativeCrashBindingV1,
    isSameDaemonPluginReactNativeCrashBindingTokenV1,
    type DaemonPluginReactNativeCrashBindingTokenV1,
    type DaemonPluginReactNativeCrashFailureV1,
} from '@happier-dev/protocol';

import { randomUUID } from '@/platform/randomUUID';

/**
 * The UI owns only failures it recorded locally while it cannot yet know
 * whether the daemon accepted the report. Counts, thresholds, disablement, and
 * reset remain daemon-owned state.
 */
export type PluginReactNativePendingFailure = Readonly<{
    token: DaemonPluginReactNativeCrashBindingTokenV1;
    failureOccurrenceId: string;
    failure: DaemonPluginReactNativeCrashFailureV1;
}>;

/**
 * The exact host-selected server/machine/Account target that owns a local
 * pending occurrence. It never travels to the daemon; the daemon token stays
 * the sole mutation fence and containment identity.
 */
type PluginReactNativePersistedPendingFailure = PluginReactNativePendingFailure & Readonly<{
    scopeKey: string;
}>;

export type PluginReactNativeWatchdog = Readonly<{
    /** Persist a new real failure once, before it can be reported. */
    recordFailure: (input: Readonly<{
        token: DaemonPluginReactNativeCrashBindingTokenV1;
        scopeKey: string;
        failure: DaemonPluginReactNativeCrashFailureV1;
    }>) => PluginReactNativePendingFailure;
    /** Removes exactly the occurrence whose daemon receipt was accepted. */
    acknowledgeReportedFailure: (input: Readonly<{
        token: DaemonPluginReactNativeCrashBindingTokenV1;
        scopeKey: string;
        failureOccurrenceId: string;
    }>) => void;
    readPending: (input: Readonly<{
        token: DaemonPluginReactNativeCrashBindingTokenV1;
        scopeKey: string;
    }>) => readonly PluginReactNativePendingFailure[];
}>;

/** Stored bytes this store holds, or `null` when it holds or can offer none. */
export type PluginReactNativeWatchdogSnapshotRead = Readonly<{ snapshot: unknown }> | null;

/**
 * Best-effort durable storage for the unreported-failure outbox. Reads and
 * writes may fail; an unreachable store only means this launch cannot carry an
 * unreported occurrence forward, never that a plugin must be held back.
 */
export type PluginReactNativeWatchdogPersistence = Readonly<{
    readSnapshot: () => PluginReactNativeWatchdogSnapshotRead;
    writeSnapshot: (snapshot: PluginReactNativeWatchdogSnapshot) => void;
}>;

export type PluginReactNativeWatchdogSnapshot = Readonly<{
    v: 3;
    pending: readonly PluginReactNativePersistedPendingFailure[];
}>;

function cloneToken(token: DaemonPluginReactNativeCrashBindingTokenV1): DaemonPluginReactNativeCrashBindingTokenV1 {
    return Object.freeze({
        mount: token.mount.kind === 'destination'
            ? Object.freeze({
                kind: 'destination' as const,
                destination: Object.freeze({ ...token.mount.destination }),
            })
            : token.mount.kind === 'inline'
                ? Object.freeze({
                    kind: 'inline' as const,
                    surface: Object.freeze({ ...token.mount.surface }),
                    role: token.mount.role,
                })
            : token.mount.kind === 'targetedSurface'
                ? Object.freeze({
                    kind: 'targetedSurface' as const,
                    target: Object.freeze({ ...token.mount.target }),
                    point: Object.freeze({
                        pointId: token.mount.point.pointId,
                        protocol: Object.freeze({ ...token.mount.point.protocol }),
                    }),
                    contributor: Object.freeze({ ...token.mount.contributor }),
                    role: token.mount.role,
                    presentation: token.mount.presentation,
                })
            : token.mount.kind === 'automationEventSetupSurface'
                ? Object.freeze({
                    kind: 'automationEventSetupSurface' as const,
                    contribution: Object.freeze({ ...token.mount.contribution }),
                    immutableGenerationId: token.mount.immutableGenerationId,
                })
                : Object.freeze({
                    kind: 'composer' as const,
                    contribution: Object.freeze({ ...token.mount.contribution }),
                    immutableGenerationId: token.mount.immutableGenerationId,
                    role: token.mount.role,
                }),
        renderer: Object.freeze({ ...token.renderer }),
        artifactDigest: token.artifactDigest,
        crashStateEpoch: token.crashStateEpoch,
    });
}

function freezePendingFailure(input: Readonly<{
    token: DaemonPluginReactNativeCrashBindingTokenV1;
    failureOccurrenceId: string;
    failure: DaemonPluginReactNativeCrashFailureV1;
}>): PluginReactNativePendingFailure {
    return Object.freeze({
        token: cloneToken(input.token),
        failureOccurrenceId: input.failureOccurrenceId,
        failure: input.failure,
    });
}

function freezePersistedPendingFailure(input: Readonly<{
    token: DaemonPluginReactNativeCrashBindingTokenV1;
    scopeKey: string;
    failureOccurrenceId: string;
    failure: DaemonPluginReactNativeCrashFailureV1;
}>): PluginReactNativePersistedPendingFailure {
    return Object.freeze({
        ...freezePendingFailure(input),
        scopeKey: input.scopeKey,
    });
}

/**
 * New daemon-issued tokens establish a new current epoch/artifact for one
 * binding. The UI can therefore forget its older local quarantine; it never
 * treats a mount-local retry as a reset because that uses the same token.
 */
function removeSupersededPendingFailures(
    pendingFailures: PluginReactNativePersistedPendingFailure[],
    scopeKey: string,
    token: DaemonPluginReactNativeCrashBindingTokenV1,
): boolean {
    let writeIndex = 0;
    let changed = false;
    for (const pending of pendingFailures) {
        if (
            pending.scopeKey === scopeKey
            &&
            isSameDaemonPluginReactNativeCrashBindingV1(pending.token, token)
            && !isSameDaemonPluginReactNativeCrashBindingTokenV1(pending.token, token)
        ) {
            changed = true;
            continue;
        }
        pendingFailures[writeIndex] = pending;
        writeIndex += 1;
    }
    if (changed) {
        pendingFailures.length = writeIndex;
    }
    return changed;
}

const NO_RESTORED_PENDING: readonly PluginReactNativePersistedPendingFailure[] = Object.freeze([]);

/**
 * Restores only occurrences this version can still report. A missing adapter,
 * an unreadable store, or a row from another snapshot shape yields no
 * restorable occurrence; it never becomes containment of its own.
 */
function readPersistedSnapshot(
    persistence: PluginReactNativeWatchdogPersistence | undefined,
): readonly PluginReactNativePersistedPendingFailure[] {
    if (!persistence) {
        return NO_RESTORED_PENDING;
    }
    let read: PluginReactNativeWatchdogSnapshotRead;
    try {
        read = persistence.readSnapshot();
    } catch {
        return NO_RESTORED_PENDING;
    }
    const snapshot = read?.snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        return NO_RESTORED_PENDING;
    }
    const record = snapshot as Readonly<Record<string, unknown>>;
    if (record.v !== 3 || !Array.isArray(record.pending)) {
        return NO_RESTORED_PENDING;
    }

    const pendingByOccurrence = new Map<string, PluginReactNativePersistedPendingFailure>();
    for (const entry of record.pending) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            continue;
        }
        const candidate = entry as Readonly<Record<string, unknown>>;
        const scopeKey = typeof candidate.scopeKey === 'string' && candidate.scopeKey.trim().length > 0
            ? candidate.scopeKey
            : null;
        const token = DaemonPluginReactNativeCrashBindingTokenV1Schema.safeParse(candidate.token);
        const occurrenceId = DaemonPluginReactNativeCrashFailureOccurrenceIdV1Schema.safeParse(candidate.failureOccurrenceId);
        const failure = DaemonPluginReactNativeCrashFailureV1Schema.safeParse(candidate.failure);
        if (!scopeKey || !token.success || !occurrenceId.success || !failure.success) {
            continue;
        }
        const pending = freezePersistedPendingFailure({
            token: token.data,
            scopeKey,
            failureOccurrenceId: occurrenceId.data,
            failure: failure.data,
        });
        const key = JSON.stringify([pending.scopeKey, pending.token, pending.failureOccurrenceId]);
        // A duplicated persisted entry cannot turn into a second report. Keep
        // the first exact entry; the daemon is still authoritative for a
        // same-ID/different-failure conflict.
        if (!pendingByOccurrence.has(key)) {
            pendingByOccurrence.set(key, pending);
        }
    }
    return Object.freeze([...pendingByOccurrence.values()]);
}

export function createPluginReactNativeWatchdog(options: Readonly<{
    persistence?: PluginReactNativeWatchdogPersistence;
    createFailureOccurrenceId?: () => string;
}>): PluginReactNativeWatchdog {
    const pendingFailures = [...readPersistedSnapshot(options.persistence)];
    const createFailureOccurrenceId = options.createFailureOccurrenceId ?? randomUUID;

    function persistSnapshot(): void {
        if (!options.persistence) {
            return;
        }
        // Persistence only carries an unreported occurrence across a restart so
        // the daemon still hears about it. A refused write costs that report,
        // not the running mount, which stays contained in memory by the failure
        // it actually recorded.
        try {
            options.persistence.writeSnapshot(Object.freeze({
                v: 3 as const,
                pending: Object.freeze([...pendingFailures]),
            }));
        } catch {
            // Best effort: the daemon remains the durable owner of crash state.
        }
    }

    function recordFailure(input: Readonly<{
        token: DaemonPluginReactNativeCrashBindingTokenV1;
        scopeKey: string;
        failure: DaemonPluginReactNativeCrashFailureV1;
    }>): PluginReactNativePendingFailure {
        pruneSupersededToken(input);
        const failureOccurrenceId = DaemonPluginReactNativeCrashFailureOccurrenceIdV1Schema.parse(
            createFailureOccurrenceId(),
        );
        const failure = DaemonPluginReactNativeCrashFailureV1Schema.parse(input.failure);
        const pending = freezePendingFailure({
            token: input.token,
            failureOccurrenceId,
            failure,
        });
        pendingFailures.push(freezePersistedPendingFailure({
            ...pending,
            scopeKey: input.scopeKey,
        }));
        persistSnapshot();
        return pending;
    }

    function pruneSupersededToken(input: Readonly<{
        token: DaemonPluginReactNativeCrashBindingTokenV1;
        scopeKey: string;
    }>): void {
        if (removeSupersededPendingFailures(pendingFailures, input.scopeKey, input.token)) {
            persistSnapshot();
        }
    }

    return Object.freeze({
        recordFailure,
        acknowledgeReportedFailure: (input) => {
            const occurrenceId = DaemonPluginReactNativeCrashFailureOccurrenceIdV1Schema.parse(
                input.failureOccurrenceId,
            );
            const index = pendingFailures.findIndex((pending) => (
                pending.scopeKey === input.scopeKey
                &&
                pending.failureOccurrenceId === occurrenceId
                && isSameDaemonPluginReactNativeCrashBindingTokenV1(pending.token, input.token)
            ));
            if (index < 0) {
                return;
            }
            pendingFailures.splice(index, 1);
            persistSnapshot();
        },
        readPending: (input) => Object.freeze(pendingFailures
            .filter((pending) => (
                pending.scopeKey === input.scopeKey
                && isSameDaemonPluginReactNativeCrashBindingTokenV1(pending.token, input.token)
            ))
            .map((pending) => freezePendingFailure(pending))),
    });
}
