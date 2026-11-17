import { PluginUiJsonValueV1Schema, type PluginUiDeviceStateRequestV1, type PluginUiDeviceStateResultV1 } from '@happier-dev/protocol/plugins/ui';
export type PluginDeviceStorage = Readonly<{ getString(key: string): string | undefined; set(key: string, value: string): void; delete(key: string): void }>;
export function createPluginDeviceState(storage: PluginDeviceStorage, namespace: readonly string[]) {
    return (request: PluginUiDeviceStateRequestV1): PluginUiDeviceStateResultV1 => {
        const key = `plugin-device-state:${JSON.stringify([...namespace, request.key])}`;
        if (request.operation === 'write') storage.set(key, JSON.stringify(request.value));
        else if (request.operation === 'remove') storage.delete(key);
        else {
            const saved = storage.getString(key);
            return { status: 'ready', value: saved === undefined ? null : PluginUiJsonValueV1Schema.parse(JSON.parse(saved)) };
        }
        return { status: 'ready', value: null };
    };
}
