import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    PluginUiRendererChainBindingV1Schema,
    type PluginUiRendererChainBindingV1,
} from '@happier-dev/protocol';

import type { ResolvedUiRendererV2Contribution } from './types';

export type PluginUiRendererChainResolution =
    | Readonly<{ ok: true; rendererChain: readonly ResolvedUiRendererV2Contribution[] }>
    | Readonly<{ ok: false; code: 'renderer_not_found' | 'renderer_chain_invalid' }>;

export function buildPluginUiRendererContributionKey(pluginId: string, localId: string): string {
    return buildQualifiedPluginContributionKey(createPluginContributionIdentity({ pluginId, localId }));
}

/**
 * Resolves one manifest-declared renderer chain against the normalized
 * same-plugin renderer registry. Both target admission and Composer catalog
 * projection consume this owner so neither path can select a renderer by a
 * weaker local-id lookup.
 */
export function resolvePluginUiRendererChain(input: Readonly<{
    binding: PluginUiRendererChainBindingV1;
    contributorPluginId: string;
    renderersByQualifiedId: ReadonlyMap<string, ResolvedUiRendererV2Contribution>;
}>): PluginUiRendererChainResolution {
    const binding = PluginUiRendererChainBindingV1Schema.safeParse(input.binding);
    if (!binding.success) {
        return Object.freeze({ ok: false, code: 'renderer_chain_invalid' });
    }
    const localIds = [binding.data.renderer, ...(binding.data.fallbackRenderers ?? [])];
    const rendererChain: ResolvedUiRendererV2Contribution[] = [];
    for (const localId of localIds) {
        const renderer = input.renderersByQualifiedId.get(
            buildPluginUiRendererContributionKey(input.contributorPluginId, localId),
        );
        if (!renderer) return Object.freeze({ ok: false, code: 'renderer_not_found' });
        if (renderer.pluginId !== input.contributorPluginId
            || renderer.identity.pluginId !== input.contributorPluginId
            || renderer.identity.localId !== localId
            || renderer.definition.id !== localId) {
            return Object.freeze({ ok: false, code: 'renderer_chain_invalid' });
        }
        rendererChain.push(renderer);
    }
    return Object.freeze({ ok: true, rendererChain: Object.freeze(rendererChain) });
}
