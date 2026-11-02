/** @moduleRealm any */
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginUiRendererChainBindingV1 } from '@happier-dev/protocol';

import type { TargetedContributionRendererDeclaration } from './targetedContributionAdmission.js';

export type PluginUiRendererChainResolution<TRenderer extends TargetedContributionRendererDeclaration> =
    | Readonly<{ ok: true; rendererChain: readonly TRenderer[] }>
    | Readonly<{ ok: false; code: 'renderer_not_found' }>;

/** Identifiers have already been admitted by manifest normalization. */
export function buildPluginUiRendererContributionKey(pluginId: string, localId: string): string {
    return buildQualifiedPluginContributionKey({ pluginId, localId });
}

/**
 * Resolves one manifest-declared renderer chain against the normalized
 * same-plugin renderer registry. Both target admission and Composer catalog
 * projection consume this owner so neither path can select a renderer by a
 * weaker local-id lookup.
 */
export function resolvePluginUiRendererChain<TRenderer extends TargetedContributionRendererDeclaration>(input: Readonly<{
    binding: PluginUiRendererChainBindingV1;
    contributorPluginId: string;
    renderersByQualifiedId: ReadonlyMap<string, TRenderer>;
}>): PluginUiRendererChainResolution<TRenderer> {
    const localIds = [input.binding.renderer, ...(input.binding.fallbackRenderers ?? [])];
    const rendererChain: TRenderer[] = [];
    for (const localId of localIds) {
        const renderer = input.renderersByQualifiedId.get(
            buildPluginUiRendererContributionKey(input.contributorPluginId, localId),
        );
        if (!renderer) return Object.freeze({ ok: false, code: 'renderer_not_found' });
        rendererChain.push(renderer);
    }
    return Object.freeze({ ok: true, rendererChain: Object.freeze(rendererChain) });
}
