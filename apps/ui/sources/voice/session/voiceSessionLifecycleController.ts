import { getVoiceAdapterRegistry } from './voiceAdapterRegistry';
import { getVoiceSessionSnapshot } from './voiceSessionStore';
import type { VoiceAdapterController, VoiceAdapterId, VoiceSessionSnapshot } from './types';

export type VoiceSessionLifecycleController = Readonly<{
    dispose: () => void;
    getSnapshot: () => VoiceSessionSnapshot;
    interrupt: (sessionId: string) => Promise<void>;
    sendContextUpdate: (sessionId: string, update: string) => void;
    setConfiguredProviderId: (providerId: VoiceAdapterId | 'off' | null) => void;
    setMuted: (sessionId: string, muted: boolean) => Promise<void>;
    stop: (sessionId: string) => Promise<void>;
    subscribe: (listener: () => void) => () => void;
    toggle: (sessionId: string) => Promise<void>;
}>;

type PendingAdapterSwitch = Readonly<{
    sourceAdapterId: string;
    sessionId: string;
    targetAdapterId: string | null;
    startRequested: boolean;
    sourceDisconnectObserved: boolean;
}>;

function createDisconnectedSnapshot(): VoiceSessionSnapshot {
    return {
        adapterId: null,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
    };
}

function matchesCurrentOwner(current: VoiceSessionSnapshot, candidate: VoiceSessionSnapshot): boolean {
    if (current.status === 'disconnected' || !current.adapterId) return false;
    if (candidate.status === 'disconnected') return false;
    if (candidate.adapterId !== current.adapterId) return false;
    if (current.sessionId) {
        return candidate.sessionId === current.sessionId;
    }
    return true;
}

export function createVoiceSessionLifecycleController(deps?: Readonly<{
    getRegistry?: () => ReturnType<typeof getVoiceAdapterRegistry>;
}>): VoiceSessionLifecycleController {
    const getRegistry = deps?.getRegistry ?? getVoiceAdapterRegistry;
    let configuredProviderId: VoiceAdapterId | 'off' | null = null;
    let publishedSnapshot = getVoiceSessionSnapshot();
    let pendingAdapterSwitch: PendingAdapterSwitch | null = null;
    let disposed = false;
    const listeners = new Set<() => void>();
    const adapterUnsubs: Array<() => void> = [];

    const emitChange = () => {
        if (disposed) {
            return;
        }
        for (const listener of listeners) {
            listener();
        }
    };

    const resolveConfiguredAdapter = (): VoiceAdapterController | null => {
        if (disposed) {
            return null;
        }
        if (configuredProviderId === null || configuredProviderId === 'off') {
            return null;
        }
        return getRegistry().get(configuredProviderId);
    };

    const resolveOwnedAdapter = (): Readonly<{
        adapter: VoiceAdapterController;
        snapshot: VoiceSessionSnapshot;
    }> | null => {
        if (disposed) {
            return null;
        }
        const snapshot = publishedSnapshot;
        if (snapshot.status === 'disconnected' || !snapshot.adapterId) {
            return null;
        }

        const adapter = getRegistry().get(snapshot.adapterId);
        if (!adapter) {
            return null;
        }

        return {
            adapter,
            snapshot,
        };
    };

    const computeSnapshot = (): VoiceSessionSnapshot => {
        if (disposed) {
            return publishedSnapshot;
        }
        const registry = getRegistry();
        const adapters = registry.list();
        const snapshots = adapters.map((adapter) => adapter.getSnapshot());
        if (configuredProviderId === null) {
            return createDisconnectedSnapshot();
        }

        const pending = pendingAdapterSwitch;
        if (pending) {
            const sourceSnapshot = snapshots.find((snapshot) => snapshot.adapterId === pending.sourceAdapterId) ?? null;
            const targetSnapshot =
                pending.targetAdapterId !== null
                    ? snapshots.find((snapshot) => snapshot.adapterId === pending.targetAdapterId) ?? null
                    : null;

            if (pending.startRequested) {
                if (targetSnapshot && targetSnapshot.status !== 'disconnected') {
                    return targetSnapshot;
                }
                return createDisconnectedSnapshot();
            }

            if (!pending.sourceDisconnectObserved) {
                if (sourceSnapshot && sourceSnapshot.status !== 'disconnected') {
                    return sourceSnapshot;
                }
                pendingAdapterSwitch = {
                    ...pending,
                    sourceDisconnectObserved: true,
                };
            }

            return targetSnapshot ?? createDisconnectedSnapshot();
        }

        const owned = snapshots.find((snapshot) => matchesCurrentOwner(publishedSnapshot, snapshot)) ?? null;
        if (owned) {
            return owned;
        }

        if (configuredProviderId === 'off') {
            return createDisconnectedSnapshot();
        }

        // Only the configured provider may surface as active. The machine now
        // carries its owning adapterId, so non-owning adapters already project a
        // disconnected snapshot; a blind `find(status !== 'disconnected')`
        // fallback would let a stale/non-configured adapter snapshot (or a
        // lingering error) hijack the published session — so it is removed.
        const preferred = snapshots.find(
            (snapshot) => snapshot.adapterId === configuredProviderId && snapshot.status !== 'disconnected',
        );
        return preferred ?? createDisconnectedSnapshot();
    };

    const reconcilePendingSwitch = () => {
        if (disposed) {
            pendingAdapterSwitch = null;
            return;
        }
        const pending = pendingAdapterSwitch;
        if (pending) {
            if (
                pending.targetAdapterId
                && pending.startRequested
                && publishedSnapshot.adapterId === pending.targetAdapterId
                && publishedSnapshot.status !== 'disconnected'
            ) {
                pendingAdapterSwitch = null;
                return;
            }

            const sourceStillOwnsSession =
                publishedSnapshot.adapterId === pending.sourceAdapterId && publishedSnapshot.status !== 'disconnected';
            if (sourceStillOwnsSession) {
                return;
            }

            if (pending.startRequested) {
                return;
            }

            const targetAdapterId = configuredProviderId === 'off' ? null : configuredProviderId;
            if (!targetAdapterId || targetAdapterId === pending.sourceAdapterId) {
                pendingAdapterSwitch = null;
                return;
            }

            const targetAdapter = getRegistry().get(targetAdapterId);
            if (!targetAdapter) {
                pendingAdapterSwitch = null;
                return;
            }

            const startedSwitch: PendingAdapterSwitch = {
                ...pending,
                targetAdapterId,
                startRequested: true,
            };
            pendingAdapterSwitch = startedSwitch;
            void targetAdapter
                .start({ sessionId: pending.sessionId })
                .catch(() => {
                    // A failed target start must not leave a dangling pending
                    // switch pinning the published snapshot to `disconnected`
                    // forever; clear it if it is still ours.
                    if (pendingAdapterSwitch === startedSwitch) {
                        pendingAdapterSwitch = null;
                    }
                })
                .finally(() => {
                    publishSnapshot();
                    // If the target start settled without ever reaching a
                    // connected snapshot (rejected, or resolved without
                    // connecting), drop the dangling switch and republish a
                    // clean disconnected snapshot. A successful connect already
                    // cleared `pendingAdapterSwitch` via reconcilePendingSwitch.
                    if (pendingAdapterSwitch === startedSwitch && publishedSnapshot.status === 'disconnected') {
                        pendingAdapterSwitch = null;
                        publishSnapshot();
                    }
                });
            return;
        }

        if (
            configuredProviderId === null
            || publishedSnapshot.status === 'disconnected'
            || !publishedSnapshot.adapterId
            || publishedSnapshot.adapterId === configuredProviderId
            || !publishedSnapshot.sessionId
        ) {
            return;
        }

        const sourceAdapter = getRegistry().get(publishedSnapshot.adapterId);
        if (!sourceAdapter) {
            return;
        }

        pendingAdapterSwitch = {
            sourceAdapterId: publishedSnapshot.adapterId,
            sessionId: publishedSnapshot.sessionId,
            targetAdapterId: null,
            startRequested: false,
            sourceDisconnectObserved: false,
        };

        void sourceAdapter.stop({ sessionId: publishedSnapshot.sessionId }).finally(() => {
            publishSnapshot();
        });
    };

    const publishSnapshot = () => {
        if (disposed) {
            return publishedSnapshot;
        }
        publishedSnapshot = computeSnapshot();
        emitChange();
        reconcilePendingSwitch();
        return publishedSnapshot;
    };

    for (const adapter of getRegistry().list()) {
        const unsub = adapter.subscribe?.(() => {
            publishSnapshot();
        });
        if (typeof unsub === 'function') {
            adapterUnsubs.push(unsub);
        }
    }

    return {
        dispose: () => {
            disposed = true;
            pendingAdapterSwitch = null;
            for (const unsub of adapterUnsubs.splice(0)) {
                try {
                    unsub();
                } catch {
                    // ignore unsubscribe failures during teardown
                }
            }
            listeners.clear();
        },
        getSnapshot: () => publishedSnapshot,
        interrupt: async (sessionId) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (!owned) return;
            await owned.adapter.interrupt({ sessionId: owned.snapshot.sessionId ?? sessionId });
        },
        sendContextUpdate: (sessionId, update) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (owned) {
                owned.adapter.sendContextUpdate({ sessionId: owned.snapshot.sessionId ?? sessionId, update });
                return;
            }

            const adapter = resolveConfiguredAdapter();
            if (!adapter) return;
            adapter.sendContextUpdate({ sessionId, update });
        },
        setConfiguredProviderId: (providerId) => {
            if (disposed) return;
            configuredProviderId = providerId;
            publishSnapshot();
        },
        setMuted: async (sessionId, muted) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (!owned) return;
            await owned.adapter.setMuted({ sessionId: owned.snapshot.sessionId ?? sessionId, muted });
        },
        stop: async (sessionId) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (!owned) return;
            await owned.adapter.stop({ sessionId: owned.snapshot.sessionId ?? sessionId });
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        toggle: async (sessionId) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (owned) {
                await owned.adapter.stop({ sessionId: owned.snapshot.sessionId ?? sessionId });
                return;
            }

            const adapter = resolveConfiguredAdapter();
            if (!adapter) return;
            await adapter.start({ sessionId });
        },
    };
}
