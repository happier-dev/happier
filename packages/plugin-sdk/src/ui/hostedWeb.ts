import {
    PluginHostedWebBridgeEnvelopeV1Schema as canonicalPluginHostedWebBridgeEnvelopeV1Schema,
    PluginHostedWebCollectionUiQueryBridgeOperationV1Schema as canonicalPluginHostedWebCollectionUiQueryBridgeOperationV1Schema,
    PluginHostedWebCollectionUiQueryBridgeResponseV1Schema as canonicalPluginHostedWebCollectionUiQueryBridgeResponseV1Schema,
} from '@happier-dev/protocol/plugins/ui/client';
import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebCollectionUiQueryBridgeChangeV1,
    PluginHostedWebCollectionUiQueryBridgeOperationV1,
    PluginHostedWebCollectionUiQueryBridgeResponseV1,
    PluginHostedWebContributionV1,
    PluginUiJsonObjectV1,
    PluginUiJsonValueV1,
    PluginUiSchema,
} from './publicContract.js';

export type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebCollectionUiQueryBridgeChangeV1,
    PluginHostedWebCollectionUiQueryBridgeOperationV1,
    PluginHostedWebCollectionUiQueryBridgeResponseV1,
    PluginHostedWebContributionV1,
    PluginUiJsonObjectV1,
    PluginUiJsonValueV1,
} from './publicContract.js';

export function defineHostedWebBridgeMessage<const TMessage extends PluginHostedWebBridgeEnvelopeV1>(
    message: TMessage,
): TMessage;
export function defineHostedWebBridgeMessage(
    message: PluginHostedWebBridgeEnvelopeV1,
): PluginHostedWebBridgeEnvelopeV1 {
    return canonicalPluginHostedWebBridgeEnvelopeV1Schema.parse(message);
}

export const PluginHostedWebCollectionUiQueryBridgeOperationV1Schema:
    PluginUiSchema<PluginHostedWebCollectionUiQueryBridgeOperationV1> =
    canonicalPluginHostedWebCollectionUiQueryBridgeOperationV1Schema;
export const PluginHostedWebCollectionUiQueryBridgeResponseV1Schema:
    PluginUiSchema<PluginHostedWebCollectionUiQueryBridgeResponseV1> =
    canonicalPluginHostedWebCollectionUiQueryBridgeResponseV1Schema;
