import { PluginHostedWebBridgeEnvelopeV1Schema as canonicalPluginHostedWebBridgeEnvelopeV1Schema } from '@happier-dev/protocol/plugins/ui/hostedWebBridge';
import { PluginHostedWebAccountDataBridgeOperationV1Schema as canonicalPluginHostedWebAccountDataBridgeOperationV1Schema, PluginHostedWebAccountDataBridgeResponseV1Schema as canonicalPluginHostedWebAccountDataBridgeResponseV1Schema } from '@happier-dev/protocol/plugins/data/hostedWebAccountDataBridgeV1';
import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebAccountDataBridgeChangeV1,
    PluginHostedWebAccountDataBridgeOperationV1,
    PluginHostedWebAccountDataBridgeResponseV1,
    PluginHostedWebContributionV1,
    PluginUiJsonObjectV1,
    PluginUiJsonValueV1,
    PluginUiSchema,
} from './publicContract.js';

export type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebAccountDataBridgeChangeV1,
    PluginHostedWebAccountDataBridgeOperationV1,
    PluginHostedWebAccountDataBridgeResponseV1,
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

export const PluginHostedWebAccountDataBridgeOperationV1Schema:
    PluginUiSchema<PluginHostedWebAccountDataBridgeOperationV1> =
    canonicalPluginHostedWebAccountDataBridgeOperationV1Schema;
export const PluginHostedWebAccountDataBridgeResponseV1Schema:
    PluginUiSchema<PluginHostedWebAccountDataBridgeResponseV1> =
    canonicalPluginHostedWebAccountDataBridgeResponseV1Schema;
export { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
export type { ArtifactHtmlBundleV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
export { buildArtifactHtmlDocumentV1, ARTIFACT_HTML_SANDBOX_V1, ARTIFACT_HTML_CONTENT_CSP_V1 } from '@happier-dev/protocol/artifacts/artifactHtmlDocumentV1';
