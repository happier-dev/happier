import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { TokenStorage, isLegacyAuthCredentials, type RecoveryKeyReminderTarget } from '@/auth/storage/tokenStorage';
import { getCachedReadyServerFeatures, getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { fireAndForget } from '@/utils/system/fireAndForget';

type ReminderState = Readonly<{
    /** `null` until the device's stored answer is read. */
    dismissed: boolean | null;
    /** `null` until the server says whether it wants the reminder. */
    enabled: boolean | null;
    /** Hub setup tiles on screen now; while any is, it carries the step and the banner steps aside. */
    hubTiles: number;
}>;

function readEnabled(features: ReturnType<typeof getCachedReadyServerFeatures>): boolean | null {
    if (!features) return null;
    return features.features?.auth?.ui?.recoveryKeyReminder?.enabled === true;
}

// One state for every surface (the banner, the hubs' setup step), so handling it anywhere is done
// everywhere at once.
let state: ReminderState | null = null;
let loadStarted = false;
const listeners = new Set<() => void>();

function readState(): ReminderState {
    if (!state) {
        state = {
            dismissed: TokenStorage.getCachedRecoveryKeyReminderDismissed(),
            enabled: readEnabled(getCachedReadyServerFeatures()),
            hubTiles: 0,
        };
    }
    return state;
}

function publish(next: Partial<ReminderState>) {
    state = { ...readState(), ...next };
    for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function ensureLoaded() {
    if (loadStarted) return;
    loadStarted = true;
    fireAndForget((async () => {
        const [dismissed, features] = await Promise.all([
            TokenStorage.getRecoveryKeyReminderDismissed().catch(() => true),
            getReadyServerFeatures().catch(() => null),
        ]);
        publish({ dismissed, enabled: readEnabled(features) });
    })(), { tag: 'useRecoveryKeyReminder.load' });
}

export async function recordRecoveryKeyHandled(target?: RecoveryKeyReminderTarget): Promise<void> {
    if (!await TokenStorage.setRecoveryKeyReminderDismissed(true, target)) return;
    const active = TokenStorage.getCachedRecoveryKeyReminderDismissed();
    if (active !== null && active !== readState().dismissed) publish({ dismissed: active });
}

/**
 * A recovery key the person just typed or pasted on this device to sign in to `target` is evidence
 * they hold it, so its reminder is done, recorded with the same device-local evidence as saved or
 * dismissed. Only the active Home's reminder is on screen; another Home's is read when it is.
 */
export async function recordRecoveryKeyEntered(target: RecoveryKeyReminderTarget): Promise<void> {
    // The sign-in already committed; a device that cannot store this keeps offering the reminder.
    await recordRecoveryKeyHandled(target).catch(() => {});
}

/**
 * Where the step is offered. One message per state: the session-list banner (`banner`) shows only
 * while no hub setup tile (`hubTile`) is on screen, as on phones and narrow layouts.
 */
export type RecoveryKeyReminderSurface = 'banner' | 'hubTile' | 'status';

export type RecoveryKeyReminder = Readonly<{
    /** The key still needs saving: a legacy sign-in whose key was neither saved nor dismissed here. */
    needed: boolean;
    /**
     * The step as setup progress counts it: `pending` until saved or dismissed here, then `done`;
     * `null` while it does not apply or this device has not read its answer yet.
     */
    step: 'pending' | 'done' | null;
    /** Dismissed: the person chose to handle it themselves ("I've handled it"). */
    dismiss: () => Promise<void>;
}>;

/**
 * Whether this device's sign-in key still needs saving, for the banner and the hubs' setup step.
 * Saved or dismissed both count as done; the device remembers it. It reads the device flag and the
 * server's feature answer once per launch (no machine calls).
 */
export function useRecoveryKeyReminder(options?: Readonly<{ surface?: RecoveryKeyReminderSurface }>): RecoveryKeyReminder {
    const surface = options?.surface ?? 'status';
    const auth = useAuth();
    const current = React.useSyncExternalStore(subscribe, readState, readState);
    React.useEffect(() => {
        ensureLoaded();
    }, []);
    React.useEffect(() => {
        if (surface !== 'hubTile') return;
        publish({ hubTiles: readState().hubTiles + 1 });
        return () => publish({ hubTiles: readState().hubTiles - 1 });
    }, [surface]);
    const credentials = auth.credentials;
    const legacy = auth.isAuthenticated && credentials != null && isLegacyAuthCredentials(credentials);
    const needed = legacy && current.dismissed === false && current.enabled === true
        && !(surface === 'banner' && current.hubTiles > 0);
    const step = legacy && current.enabled === true && current.dismissed !== null
        ? (current.dismissed ? 'done' : 'pending')
        : null;
    return React.useMemo(() => ({
        needed,
        step,
        dismiss: recordRecoveryKeyHandled,
    }), [needed, step]);
}
