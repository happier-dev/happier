import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import { asProtocolZod } from "../../actions/internalProtocolZodAdapter.js";

/** The one bounded renderer-chain contract shared by every embedded UI surface. */
export const PLUGIN_UI_MAX_RENDERER_CHAIN_LENGTH = 8;

export const PluginUiRendererChainBindingV1Schema = lazyZodSchema(() => z.strictObject({
  renderer: asProtocolZod(PluginContributionLocalIdSchema),
  fallbackRenderers: z.optional(z.array(asProtocolZod(PluginContributionLocalIdSchema)).check(z.maxLength(PLUGIN_UI_MAX_RENDERER_CHAIN_LENGTH - 1))),
}).check(z.superRefine((binding, context) => {
  const seen = new Set<string>();
  for (const [index, renderer] of [binding.renderer, ...(binding.fallbackRenderers ?? [])].entries()) {
    if (seen.has(renderer)) {
      context.addIssue({
        code: "custom",
        path: index === 0 ? ['renderer'] : ['fallbackRenderers', index - 1],
        message: 'Plugin UI renderer chains must not repeat a renderer.',
      });
    }
    seen.add(renderer);
  }
})));
export type PluginUiRendererChainBindingV1 = z.infer<typeof PluginUiRendererChainBindingV1Schema>;
export type PluginUiRendererChainBindingV1ParseResult = z.core.util.SafeParseResult<
  PluginUiRendererChainBindingV1
>;

/**
 * Validates a flat renderer/fallback pair without inventing another wire
 * shape. `ui.views` keeps its incumbent flat spelling while every other
 * declaration carries the canonical binding object.
 */
export function validatePluginUiRendererChainFieldsV1(
  input: Readonly<{ renderer: unknown; fallbackRenderers?: unknown }>,
): PluginUiRendererChainBindingV1ParseResult {
  return PluginUiRendererChainBindingV1Schema.safeParse(input);
}
