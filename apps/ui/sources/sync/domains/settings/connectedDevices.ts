import { z } from 'zod';

/**
 * Connected devices: each client's identity (name, platform, app version) is a synced account
 * setting that changes only when the identity changes. When a client was last seen is liveness,
 * not settings content: it comes from the relay's connected-client presence and is never written
 * into settings, so staying connected does not produce settings versions on every client.
 */
export const CONNECTED_DEVICE_KEY_PREFIX = 'connectedDeviceV1_';
export const CONNECTED_DEVICE_CLIENT_ID_KEY = 'connected-device-client-id-v1';
export const CONNECTED_DEVICE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const ConnectedDeviceSchema = z.object({
    name: z.string().nullable(),
    platform: z.enum(['android', 'ios', 'desktop', 'web']),
    appVersion: z.string().nullable(),
    /** Written by older builds only; read as a fallback when the relay has no presence for the client. */
    lastSeen: z.number().finite().nonnegative().max(8.64e15).optional(),
});
export type ConnectedDevice = z.infer<typeof ConnectedDeviceSchema>;
export type ConnectedDeviceIdentity = Readonly<Pick<ConnectedDevice, 'name' | 'platform' | 'appVersion'>>;
export type ListedConnectedDevice = ConnectedDeviceIdentity & Readonly<{ id: string; lastSeen: number }>;

/**
 * Devices seen in the last fourteen days. `lastSeenByClientId` is the relay's presence (client id →
 * epoch ms); a device without presence falls back to the last-seen time an older build stored.
 */
export function listConnectedDevices(
    settings: unknown,
    lastSeenByClientId: Readonly<Record<string, number>>,
    now: number,
): ListedConnectedDevice[] {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return [];
    const devices: ListedConnectedDevice[] = [];
    for (const [key, value] of Object.entries(settings)) {
        if (!key.startsWith(CONNECTED_DEVICE_KEY_PREFIX) || key.length === CONNECTED_DEVICE_KEY_PREFIX.length) continue;
        const parsed = ConnectedDeviceSchema.safeParse(value);
        if (!parsed.success) continue;
        const lastSeen = lastSeenByClientId[key.slice(CONNECTED_DEVICE_KEY_PREFIX.length)] ?? parsed.data.lastSeen;
        if (lastSeen === undefined || lastSeen < now - CONNECTED_DEVICE_WINDOW_MS) continue;
        const { name, platform, appVersion } = parsed.data;
        devices.push({ name, platform, appVersion, lastSeen, id: key.slice(CONNECTED_DEVICE_KEY_PREFIX.length) });
    }
    return devices.sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * The settings delta that records this client's identity, or null when the synced entry already
 * holds exactly this identity. An entry still carrying an older build's `lastSeen` is replaced once.
 */
export function planConnectedDeviceIdentityUpdate(
    settings: unknown,
    clientId: string,
    identity: ConnectedDeviceIdentity,
): Record<string, ConnectedDeviceIdentity> | null {
    const key = `${CONNECTED_DEVICE_KEY_PREFIX}${clientId}`;
    const current = settings && typeof settings === 'object' ? (settings as Record<string, unknown>)[key] : undefined;
    const parsed = ConnectedDeviceSchema.safeParse(current);
    if (
        parsed.success
        && parsed.data.lastSeen === undefined
        && parsed.data.name === identity.name
        && parsed.data.platform === identity.platform
        && parsed.data.appVersion === identity.appVersion
    ) {
        return null;
    }
    return { [key]: { name: identity.name, platform: identity.platform, appVersion: identity.appVersion } };
}
