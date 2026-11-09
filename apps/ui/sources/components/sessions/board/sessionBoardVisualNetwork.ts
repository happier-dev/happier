import type { SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';
import { persistSessionVisualEffectivePolicyV1, readSessionVisualCapabilitiesV1, readSessionVisualHtmlBodyV1 } from '@happier-dev/protocol/sessions/board';
import { normalizeUiSurfaceCapabilityRequestV1, UiSurfaceNetworkOriginV1Schema, type UiSurfaceNetworkRequestV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import { readWidgetDefinitionNetworkOverrideV1, type WidgetDefinitionV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

/** The three network choices an HTML visual can hold: none, exact origins, or open. */
export type SessionVisualNetworkChoice = Readonly<{ mode: 'none' | 'origins' | 'open'; origins: readonly string[] }>;

/**
 * The network this visual's stored policy holds, or `null` when the item is not an HTML visual or its
 * stored policy is malformed (a malformed policy is never shown as, or edited into, an open one).
 */
export function readSessionVisualNetworkChoice(item: SessionSurfaceItemV1): SessionVisualNetworkChoice | null {
    if (item.source.kind !== 'hostedHtml' && readSessionVisualHtmlBodyV1(item) === null) return null;
    const capabilities = readSessionVisualCapabilitiesV1(item);
    return capabilities ? { mode: capabilities.network, origins: capabilities.networkOrigins } : null;
}

/**
 * A placed HTML widget's network: the instance's own choice, else the one its saved definition captured
 * (the precedence its guest frame renders with). `null` when the widget holds no HTML or its policy is malformed.
 */
export function readWidgetInstanceNetworkChoice(instance: WidgetInstanceV1, definition: WidgetDefinitionV1 | undefined): SessionVisualNetworkChoice | null {
    if (definition?.body.kind !== 'html') return null;
    const policy = normalizeUiSurfaceCapabilityRequestV1(instance.networkOverride ?? readWidgetDefinitionNetworkOverrideV1(definition));
    return policy ? { mode: policy.network, origins: policy.networkOrigins } : null;
}

/** The stored network request for a choice: exact sites, or an explicit none or any site. */
export function sessionVisualNetworkRequest(choice: SessionVisualNetworkChoice): UiSurfaceNetworkRequestV1 {
    return choice.mode === 'origins' ? { networkOrigins: [...choice.origins] } : { network: choice.mode };
}

/** The same item with the chosen network, written through the protocol's one policy materialization. */
export function applySessionVisualNetworkChoice(item: SessionSurfaceItemV1, choice: SessionVisualNetworkChoice): SessionSurfaceItemV1 | null {
    const capabilities = readSessionVisualCapabilitiesV1(item);
    if (!capabilities) return null;
    // Exact sites are the alternative to an explicit `network` value, so the old explicit value goes first.
    const base = item.source.kind === 'hostedHtml' && item.source.requestedCapabilities
        ? { ...item, source: { ...item.source, requestedCapabilities: (({ network: _network, ...rest }) => rest)(item.source.requestedCapabilities) } }
        : item;
    return persistSessionVisualEffectivePolicyV1(base, { ...capabilities, network: choice.mode,
        networkOrigins: choice.mode === 'origins' ? [...choice.origins] : [] });
}

/** Sites typed one per line, or separated by commas or spaces: exact HTTPS origins, with the entries that are not one. */
export function parseSessionVisualNetworkOrigins(text: string): Readonly<{ origins: readonly string[]; invalid: readonly string[] }> {
    const entries = [...new Set(text.split(/[\s,]+/u).map(entry => entry.trim().replace(/\/+$/u, '')).filter(Boolean))];
    return {
        origins: entries.filter(entry => UiSurfaceNetworkOriginV1Schema.safeParse(entry).success),
        invalid: entries.filter(entry => !UiSurfaceNetworkOriginV1Schema.safeParse(entry).success),
    };
}
