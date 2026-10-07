import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { readActiveServerTaskScope } from '@/sync/domains/server/activeServerTaskScope';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';

/**
 * The kinds hsetup parses with `parseDaemonServiceTaskParams`: the local background service, and
 * the PATH exposure the same setup run performs. One builder keeps a single owner for these params
 * rather than a second copy that can drift.
 */
type LocalDaemonServiceTaskKind =
    | 'daemon.service.status.v1'
    | 'daemon.service.start.v1'
    | 'daemon.service.stop.v1'
    | 'daemon.service.restart.v1'
    | 'cli.pathExposure.ensure.v1'
    | 'cli.pathExposure.remove.v1'
    /** R17 (K2): update the desktop-managed CLI of this channel in place, then restart its daemon. */
    | 'cli.update.v1'
    /** R15 c: stop serving a Home the app is forgetting (its desktop-managed service). Pass its scope. */
    | 'daemon.service.relay.disconnect.v1'
    /** R16 b: the one login-start setting, for every service the app manages here. Pass `{ autostart }`. */
    | 'daemon.service.autostart.set.v1';

const LOCAL_DAEMON_SERVICE_PARAMS = {
    target: { kind: 'local' as const },
    surface: 'desktop.ui' as const,
    mode: 'user' as const,
};

/** Which Home's daemon a task addresses: its URL and, when known, its server identity (RV-11). */
export type LocalDaemonServiceScope = Readonly<{
    relayUrl?: string | null;
    serverIdentityId?: string | null;
    /**
     * Address every service the app manages on this computer (bootstrap's aggregate: each is
     * attempted and every failure named) instead of one Home's — "Stop background services and quit".
     */
    allManagedServices?: boolean;
}>;

/**
 * "This computer", for this app, is the daemon serving the app's own active server — never
 * whichever server the terminal happens to follow (R10 D3; `readActiveServerTaskScope` is the one
 * rule). The daemon kinds are scoped to it unless the caller names another Home
 * (the Personal Home bootstrap names its own). PATH exposure manages command availability, not a
 * Home, so it stays unscoped.
 */
export function buildLocalDaemonServiceSystemTaskSpec(
    kind: LocalDaemonServiceTaskKind,
    scope: LocalDaemonServiceScope = {},
    extraParams: Readonly<Record<string, unknown>> = {},
): SystemTaskSpec {
    const channel = resolvePreferredPublicReleaseRingLabelForCurrentApp();
    // PATH exposure and the login-start setting (every service the app manages) address no single Home.
    const isUnscoped = kind === 'cli.pathExposure.ensure.v1'
        || kind === 'cli.pathExposure.remove.v1'
        || kind === 'daemon.service.autostart.set.v1';
    const target = isUnscoped || scope.allManagedServices === true ? {} : scope.relayUrl?.trim() ? scope : readActiveServerTaskScope();
    const relayUrl = target.relayUrl?.trim();
    const serverIdentityId = relayUrl ? target.serverIdentityId?.trim() : undefined;
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind,
        params: {
            ...LOCAL_DAEMON_SERVICE_PARAMS,
            channel,
            ...(relayUrl ? { relayUrl } : {}),
            ...(serverIdentityId ? { serverIdentityId } : {}),
            ...extraParams,
        },
    };
}
