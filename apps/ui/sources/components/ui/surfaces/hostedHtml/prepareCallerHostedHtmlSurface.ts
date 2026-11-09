import {
    admitCallerAuthoredUiSurfaceCapabilitiesV1,
    type NormalizedUiSurfaceCapabilityRequestV1,
} from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import {
    PluginHostedHtmlSourceV1Schema,
    type PluginHostedHtmlSourceV1,
} from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlSourceV1';
import type { PluginUiHostMethodV1 } from '@happier-dev/protocol/plugins/ui/hostApiDefinition';

export type PreparedCallerHostedHtmlSurface =
    | Readonly<{
        kind: 'admitted';
        /** Raw authored source for HostedFrameHost, which installs the shell once. */
        frameSource: Readonly<{
            bundle: PluginHostedHtmlSourceV1;
            networkOrigins: NormalizedUiSurfaceCapabilityRequestV1['networkOrigins'];
            network?: 'none' | 'open';
        }>;
        advertisedHostMethods: readonly PluginUiHostMethodV1[];
        /** The exact immutable mount input; outer Session authority binds refs. */
        capabilityManifest: Readonly<{
            version: 1;
            requested: NormalizedUiSurfaceCapabilityRequestV1;
            advertisedHostMethods: readonly PluginUiHostMethodV1[];
        }>;
    }>
    | Readonly<{
        kind: 'rejected';
        code:
            | 'source_invalid'
            | 'capability_request_invalid'
            | 'host_method_outside_caller_ceiling';
    }>;

/**
 * Prepares caller-authored by-value HTML at the Session authority boundary.
 *
 * Installed plugins do not enter this adapter: their independently admitted
 * public ABI and full trusted Host API continue through PluginSurfaceHost.
 * This adapter validates the caller ceiling. The physical frame's shared
 * document owner resolves local assets and builds the only rendered shell.
 */
export async function prepareCallerHostedHtmlSurface(input: Readonly<{
    source: unknown;
    requestedCapabilities?: unknown;
    admittedHostMethods: readonly PluginUiHostMethodV1[];
}>): Promise<PreparedCallerHostedHtmlSurface> {
    const source = PluginHostedHtmlSourceV1Schema.safeParse(input.source);
    if (!source.success) return Object.freeze({ kind: 'rejected', code: 'source_invalid' });
    const admission = admitCallerAuthoredUiSurfaceCapabilitiesV1({
        request: input.requestedCapabilities,
        admittedHostMethods: input.admittedHostMethods,
    });
    if (admission.kind === 'rejected') return admission;
    return Object.freeze({
        kind: 'admitted',
        frameSource: Object.freeze({
            bundle: source.data,
            networkOrigins: admission.capabilities.networkOrigins,
            network: admission.capabilities.network === 'origins' ? undefined : admission.capabilities.network,
        }),
        advertisedHostMethods: admission.advertisedHostMethods,
        capabilityManifest: Object.freeze({
            version: 1 as const,
            requested: admission.capabilities,
            advertisedHostMethods: admission.advertisedHostMethods,
        }),
    });
}
