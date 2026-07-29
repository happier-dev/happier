import {
    PluginLocalServicesBridgeControlRequestV1Schema,
    PluginLocalServicesBridgeControlResponseV1Schema,
    type PluginLocalServicesBridgeControlRequestV1,
    type PluginLocalServicesBridgeControlResponseV1,
} from './pluginBridgeProtocol';
import type {
    PluginLocalServicesBridgeContext,
    PluginLocalServicesDaemonBridge,
} from './runtime';

export type PluginLocalServicesBridgeControlRoutes = Readonly<{
    dispatch(request: PluginLocalServicesBridgeControlRequestV1): Promise<PluginLocalServicesBridgeControlResponseV1>;
}>;

type PluginLocalServicesBridgeFactory = Readonly<{
    createPluginLocalServicesBridge(context: PluginLocalServicesBridgeContext): PluginLocalServicesDaemonBridge;
}>;

export function createPluginLocalServicesBridgeControlRoutes(
    input: PluginLocalServicesBridgeFactory,
): PluginLocalServicesBridgeControlRoutes {
    return Object.freeze({
        async dispatch(rawRequest) {
            const request = PluginLocalServicesBridgeControlRequestV1Schema.parse(rawRequest);
            const bridge = input.createPluginLocalServicesBridge(request.context);

            switch (request.operation.kind) {
                case 'declare': {
                    const snapshot = await bridge.declare?.(request.operation.declaration);
                    return PluginLocalServicesBridgeControlResponseV1Schema.parse(
                        snapshot ? { ok: true, snapshot } : { ok: true },
                    );
                }
                case 'start': {
                    const snapshot = await bridge.start(request.operation.declaration);
                    return PluginLocalServicesBridgeControlResponseV1Schema.parse({ ok: true, snapshot });
                }
                case 'get': {
                    const snapshot = await bridge.get?.(request.operation.serviceId) ?? null;
                    return PluginLocalServicesBridgeControlResponseV1Schema.parse({ ok: true, snapshot });
                }
                case 'stop': {
                    await bridge.stop?.(request.operation.serviceId);
                    return PluginLocalServicesBridgeControlResponseV1Schema.parse({ ok: true });
                }
            }
        },
    });
}
