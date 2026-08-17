import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebBridgeResponseEnvelopeV1,
} from '@happier-dev/protocol';
import { readPluginHostedWebBridgeFrameOriginV1 } from '@happier-dev/protocol/plugins/ui';

import { validatePluginHostedWebBridgeMessage } from './bridge';

export type PluginHostedWebNativeBridgeConfig = Readonly<{
    expectedOrigin: string;
    expectedPluginId: string;
    expectedContributionId: string;
    expectedSurfaceId: string;
    expectedNonce: string;
    expectedSessionId?: string | null;
    allowedMessageKinds: ReadonlySet<string>;
    onMessage: (
        envelope: PluginHostedWebBridgeEnvelopeV1,
    ) => void | PluginHostedWebBridgeResponseEnvelopeV1 | Promise<PluginHostedWebBridgeResponseEnvelopeV1 | void>;
}>;

type NativeMessageEvent = Readonly<{
    nativeEvent?: Readonly<{
        data?: unknown;
        url?: unknown;
    }>;
}>;

function readFrameOrigin(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        return readPluginHostedWebBridgeFrameOriginV1(new URL(value));
    } catch {
        return null;
    }
}

/**
 * The one native inbound-bridge adapter shared by generic and Artifact-backed
 * frames. Protocol owns the exceptional iOS scheme grammar; this adapter only
 * parses the native event and delegates address and envelope authority there.
 */
export function createPluginHostedWebNativeMessageBridge(input: Readonly<{
    bridge: PluginHostedWebNativeBridgeConfig;
}>): (event: NativeMessageEvent) => void | PluginHostedWebBridgeResponseEnvelopeV1 | Promise<PluginHostedWebBridgeResponseEnvelopeV1 | void> {
    return (event) => {
        const rawData = event.nativeEvent?.data;
        if (typeof rawData !== 'string') return;
        let message: unknown;
        try {
            message = JSON.parse(rawData);
        } catch {
            return;
        }
        // Native transport sender evidence is mandatory. Desktop's exact
        // view-id owner injects its verified fact before this shared adapter.
        const messageOrigin = readFrameOrigin(event.nativeEvent?.url);
        if (!messageOrigin) return;
        const result = validatePluginHostedWebBridgeMessage({
            message,
            origin: messageOrigin,
            expectedOrigin: input.bridge.expectedOrigin,
            expectedPluginId: input.bridge.expectedPluginId,
            expectedContributionId: input.bridge.expectedContributionId,
            expectedSurfaceId: input.bridge.expectedSurfaceId,
            expectedNonce: input.bridge.expectedNonce,
            expectedSessionId: input.bridge.expectedSessionId,
            allowedMessageKinds: input.bridge.allowedMessageKinds,
        });
        return result.ok ? input.bridge.onMessage(result.envelope) : undefined;
    };
}
