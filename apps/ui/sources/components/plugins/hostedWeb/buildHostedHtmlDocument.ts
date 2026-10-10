import { buildArtifactHtmlDocumentV1 } from '@happier-dev/protocol/artifacts/artifactHtmlDocumentV1';
import {
    UiSurfaceNetworkOriginV1Schema,
    type UiSurfaceNetworkOriginV1,
} from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import type { PluginHostedHtmlSourceV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlSourceV1';
import { PluginHostedWebBridgeBootstrapConfigV1Schema, type PluginHostedWebBridgeBootstrapConfigV1 } from '@happier-dev/protocol/plugins/ui/hostedWebBridge';

/** Hosted and Artifact consumers share bundle resolution and sandbox policy. */
export function buildHostedHtmlDocument(
    bundle: PluginHostedHtmlSourceV1,
    bootstrapConfig?: PluginHostedWebBridgeBootstrapConfigV1,
    isolation?: Readonly<{
        networkOrigins?: readonly UiSurfaceNetworkOriginV1[];
        externalHttpLinks?: boolean;
    }>,
): string {
    // E3 owns admitted egress. A request alone cannot open network in E2.
    isolation?.networkOrigins?.forEach(origin => UiSurfaceNetworkOriginV1Schema.parse(origin));
    return buildArtifactHtmlDocumentV1(bundle, {
        bootstrapConfig: bootstrapConfig === undefined ? undefined : PluginHostedWebBridgeBootstrapConfigV1Schema.parse(bootstrapConfig),
        externalHttpLinks: isolation?.externalHttpLinks,
    });
}
