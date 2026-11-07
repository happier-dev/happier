import { z } from 'zod';

export const CONNECTED_DEVICE_KEY_PREFIX = 'connectedDeviceV1_';
export const CONNECTED_DEVICE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const ConnectedDeviceSchema = z.object({
    name: z.string().nullable(),
    platform: z.enum(['android', 'ios', 'desktop', 'web']),
    appVersion: z.string().nullable(),
    lastSeen: z.number().finite().nonnegative().max(8.64e15),
});
export type ConnectedDevice = z.infer<typeof ConnectedDeviceSchema>;

export function listConnectedDevices(settings: unknown, now: number): ConnectedDevice[] {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return [];
    const devices: ConnectedDevice[] = [];
    for (const [key, value] of Object.entries(settings)) {
        if (!key.startsWith(CONNECTED_DEVICE_KEY_PREFIX) || key.length === CONNECTED_DEVICE_KEY_PREFIX.length) continue;
        const parsed = ConnectedDeviceSchema.safeParse(value);
        if (parsed.success && parsed.data.lastSeen >= now - CONNECTED_DEVICE_WINDOW_MS) devices.push(parsed.data);
    }
    return devices.sort((a, b) => b.lastSeen - a.lastSeen);
}
