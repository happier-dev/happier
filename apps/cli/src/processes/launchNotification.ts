import { z } from 'zod/mini';

export const PROCESS_LAUNCH_NOTIFICATION_PATH = '/processes/launch-notify';
export const ProcessLaunchNotificationRequestSchema = z.strictObject({});
export const ProcessLaunchNotificationResultSchema = z.strictObject({ accepted: z.literal(true) });

const listeners = new Set<() => void>();
/** What launch observation reads from a spawned child: its PID, else its `spawn` event. */
type LaunchedChild = Readonly<{ pid?: number; once(event: 'spawn', listener: () => void): unknown }>;
const observedChildren = new WeakSet<LaunchedChild>();

/** A launch invalidates discovery, never supplies process identity or ownership. */
export function invalidateProcessLaunchDiscovery(): void {
    for (const listener of listeners) listener();
}

export function subscribeProcessLaunchDiscovery(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Runners reach their daemon through its existing private authenticated control transport. */
export async function notifyProcessLaunch(): Promise<void> {
    // The daemon hosts the discovery view; its own launches invalidate it directly
    // instead of a loopback control request to itself (which also loaded a second HTTP stack).
    // Delivery stays asynchronous like the transport path: the launching caller
    // finishes recording its child before discovery reads it.
    if (listeners.size > 0) {
        await Promise.resolve();
        invalidateProcessLaunchDiscovery();
        return;
    }
    try {
        const { daemonPost } = await import('@/daemon/controlHttp');
        ProcessLaunchNotificationResultSchema.safeParse(await daemonPost(PROCESS_LAUNCH_NOTIFICATION_PATH,
            ProcessLaunchNotificationRequestSchema.parse({})));
    } catch {
        // An absent/older daemon keeps the existing demanded full-census backstop.
    }
}

export function observeProcessLaunch(child: LaunchedChild): void {
    if (observedChildren.has(child)) return;
    observedChildren.add(child);
    // A managed wrapper may be installed after its custody handshake, after the
    // spawn event. A native PID exists only after the OS accepted the spawn.
    if (typeof child.pid === 'number') void notifyProcessLaunch();
    else child.once('spawn', () => { void notifyProcessLaunch(); });
}
