import {
    PluginHostedWebBridgeEnvelopeV1Schema,
    type PluginHostedWebBridgeEnvelopeV1,
} from '@happier-dev/protocol';

export function defineHostedWebBridgeMessage<const TMessage extends PluginHostedWebBridgeEnvelopeV1>(
    message: TMessage,
): TMessage {
    return PluginHostedWebBridgeEnvelopeV1Schema.parse(message) as TMessage;
}

export type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebContributionV1,
} from '@happier-dev/protocol';
