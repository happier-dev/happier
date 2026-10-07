import { IrohError, normalizeIrohNativeError, type IrohHomeTunnelLease, type IrohHomeTunnelRequest, type IrohObservedPath } from '@happier-dev/iroh-native';
import { isLiteralLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';

import { desktopHostKind, invokeDesktopHost } from '@/utils/platform/desktopHost';

import type { IrohNativeLifecycleModule } from './supervisor';

/**
 * Desktop lifecycle bridge for the native Iroh Home tunnel.
 *
 * Both shipping desktop shells (Tauri and Electron) expose the one shared
 * `desktopHost` command bridge, so this module is the single renderer-side
 * lifecycle module for both shells: `ensureHomeTunnel`/`releaseHomeTunnel`
 * map onto the two host commands below, and each host composes those onto the
 * same shared `happier-iroh-native` JSON lifecycle. Lifecycle/status only —
 * no tunnel payload byte ever crosses the invoke boundary, and the endpoint
 * identity stays host-owned: this bridge carries descriptor-derived facts
 * only, never a key path or secret material.
 */
export const IROH_DESKTOP_START_COMMAND = 'iroh_ensure_home_tunnel';
export const IROH_DESKTOP_STOP_COMMAND = 'iroh_release_home_tunnel';
export const IROH_DESKTOP_STATUS_COMMAND = 'iroh_get_tunnel_status';

/** Exact lease shape the desktop hosts return; host-owned endpoint handles are stripped host-side. */
type DesktopIrohNativeLease = Omit<IrohHomeTunnelLease, 'release'>;

function toIrohError(error: unknown): IrohError {
    const message = error instanceof Error ? error.message : String(error);
    const unavailable = message.startsWith('HAPPIER_DESKTOP_NOT_IMPLEMENTED:');
    return normalizeIrohNativeError(error, unavailable ? 'unavailable' : 'unknown');
}

function readLoopbackRuntimeOrigin(record: Record<string, unknown>): string {
    const value = readNonEmptyString(record, 'runtimeOrigin');
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new IrohError('unknown', 'Desktop Iroh host lease field runtimeOrigin is invalid');
    }
    if (
        parsed.protocol !== 'http:'
        || !isLiteralLoopbackHostname(parsed.hostname)
        || parsed.port.length === 0
        || parsed.username.length > 0
        || parsed.password.length > 0
        || parsed.pathname !== '/'
        || parsed.search.length > 0
        || parsed.hash.length > 0
    ) {
        throw new IrohError('unknown', 'Desktop Iroh host lease field runtimeOrigin is not a fixed loopback origin');
    }
    return parsed.origin;
}

function readNonEmptyString(record: Record<string, unknown>, field: string): string {
    const value = record[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new IrohError('unknown', `Desktop Iroh host lease field ${field} is missing`);
    }
    return value;
}

function readObservedPath(value: unknown): IrohObservedPath {
    if (value === 'direct' || value === 'relay' || value === 'unknown') return value;
    throw new IrohError('unknown', 'Desktop Iroh host lease field observedPath is invalid');
}

/** Fails closed on a malformed host lease instead of adopting it. */
function parseDesktopLease(value: unknown): DesktopIrohNativeLease {
    if (typeof value !== 'object' || value === null) {
        throw new IrohError('unknown', 'Desktop Iroh host returned no lease');
    }
    const record = value as Record<string, unknown>;
    const startedAtMs = record.startedAtMs;
    if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) {
        throw new IrohError('unknown', 'Desktop Iroh host lease field startedAtMs is invalid');
    }
    if (readNonEmptyString(record, 'carrier') !== 'iroh') {
        throw new IrohError('unknown', 'Desktop Iroh host lease field carrier is invalid');
    }
    return {
        leaseId: readNonEmptyString(record, 'leaseId'),
        homeServerIdentityId: readNonEmptyString(record, 'homeServerIdentityId'),
        homeEndpointId: readNonEmptyString(record, 'homeEndpointId'),
        runtimeOrigin: readLoopbackRuntimeOrigin(record),
        carrier: 'iroh',
        observedPath: readObservedPath(record.observedPath),
        startedAtMs,
    };
}

/**
 * Returns the desktop lifecycle module only when this renderer actually runs
 * in a desktop shell; a browser/native runtime keeps the existing mobile
 * (optional Expo module) resolution and never gains a host command carrier.
 */
export function createDesktopIrohLifecycleModule(): IrohNativeLifecycleModule | null {
    if (desktopHostKind() === null) return null;
    return {
        async ensureHomeTunnel(input: IrohHomeTunnelRequest): Promise<DesktopIrohNativeLease> {
            try {
                // Descriptor-derived facts only. There is deliberately no key
                // path or secret field: the desktop host injects its canonical
                // persistent endpoint identity itself.
                return parseDesktopLease(await invokeDesktopHost<unknown>(IROH_DESKTOP_START_COMMAND, {
                    request: {
                        homeServerIdentityId: input.homeServerIdentityId,
                        endpointId: input.endpointId,
                        policy: input.policy,
                        ...(input.relayUrls === undefined ? {} : { relayUrls: input.relayUrls }),
                        ...(input.directAddresses === undefined ? {} : { directAddresses: input.directAddresses }),
                    },
                }));
            } catch (error) {
                throw toIrohError(error);
            }
        },
        async releaseHomeTunnel(leaseId: string): Promise<void> {
            try {
                await invokeDesktopHost(IROH_DESKTOP_STOP_COMMAND, { leaseId });
            } catch (error) {
                throw toIrohError(error);
            }
        },
        async getTunnelStatus(tunnelId: string): Promise<Record<string, unknown> | null> {
            try {
                const value = await invokeDesktopHost<unknown>(IROH_DESKTOP_STATUS_COMMAND, { leaseId: tunnelId });
                if (value === null) return null;
                if (typeof value !== 'object') {
                    throw new IrohError('unknown', 'Desktop Iroh host returned malformed tunnel status');
                }
                return value as Record<string, unknown>;
            } catch (error) {
                throw toIrohError(error);
            }
        },
    };
}
