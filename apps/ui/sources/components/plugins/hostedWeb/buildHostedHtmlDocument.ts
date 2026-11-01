import { buildArtifactHtmlDocumentV1 } from '@happier-dev/protocol/artifacts/artifactHtmlDocumentV1';
import {
    UiSurfaceCapabilityRequestV1Schema,
    type UiSurfaceNetworkOriginV1,
} from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import type { PluginHostedHtmlSourceV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlSourceV1';
import { PluginHostedWebBridgeBootstrapConfigV1Schema, type PluginHostedWebBridgeBootstrapConfigV1 } from '@happier-dev/protocol/plugins/ui/hostedWebBridge';

/** Hosted and Artifact consumers share bundle resolution and sandbox policy. */
export async function buildHostedHtmlDocument(
    bundle: PluginHostedHtmlSourceV1,
    bootstrapConfig?: PluginHostedWebBridgeBootstrapConfigV1,
    isolation?: Readonly<{
        networkOrigins?: readonly UiSurfaceNetworkOriginV1[];
        network?: 'none' | 'open';
        externalHttpLinks?: boolean;
    }>,
): Promise<string> {
    const requestedCapabilities = UiSurfaceCapabilityRequestV1Schema.parse({
        ...(isolation?.network === undefined ? {} : { network: isolation.network }),
        ...(isolation?.networkOrigins === undefined ? {} : { networkOrigins: [...isolation.networkOrigins] }),
    });
    const parsedBootstrap = bootstrapConfig === undefined ? undefined : PluginHostedWebBridgeBootstrapConfigV1Schema.parse(bootstrapConfig);
    const guestBootstrapScript = parsedBootstrap === undefined ? undefined
        : (await import('./guestBootstrap.generated')).HOSTED_HTML_GUEST_BOOTSTRAP_SCRIPT;
    return buildArtifactHtmlDocumentV1(bundle, {
        bootstrapConfig: parsedBootstrap,
        guestBootstrapScript,
        externalHttpLinks: isolation?.externalHttpLinks,
        requestedCapabilities,
    });
}
