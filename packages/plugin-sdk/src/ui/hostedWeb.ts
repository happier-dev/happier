import {
    PluginHostedWebBridgeEnvelopeV1Schema,
    PluginHostedWebContributionV1Schema,
    type PluginHostedWebBridgeEnvelopeV1,
    type PluginHostedWebContributionV1,
} from '@happier-dev/protocol';

export function defineHostedWebUi<const TContribution extends PluginHostedWebContributionV1>(
    contribution: TContribution,
): TContribution {
    return PluginHostedWebContributionV1Schema.parse(contribution) as TContribution;
}

export function defineHostedWebBridgeMessage<const TMessage extends PluginHostedWebBridgeEnvelopeV1>(
    message: TMessage,
): TMessage {
    return PluginHostedWebBridgeEnvelopeV1Schema.parse(message) as TMessage;
}

export type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebContributionV1,
} from '@happier-dev/protocol';
