/**
 * GENERATED FILE CONTRACT (A.16y.4-agent-runtime-codegen-and-prompt-assets-cleanup)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import type { PluginPromptAssetAdapterDescriptor } from '../pluginPromptAssetAdapterDescriptor';
import { PLUGIN_PROMPT_ASSET_DESCRIPTORS as CLAUDE_PROMPT_ASSET_DESCRIPTORS } from '@happier-dev/plugins-claude/agent/promptAssets';
import { PLUGIN_PROMPT_ASSET_DESCRIPTORS as COPILOT_PROMPT_ASSET_DESCRIPTORS } from '@happier-dev/plugins-copilot/agent/promptAssets';
import { PLUGIN_PROMPT_ASSET_DESCRIPTORS as GEMINI_PROMPT_ASSET_DESCRIPTORS } from '@happier-dev/plugins-gemini/agent/promptAssets';

export const BUNDLED_FIRST_PARTY_PLUGIN_PROMPT_ASSET_DESCRIPTORS: readonly PluginPromptAssetAdapterDescriptor[] = Object.freeze([
  ...CLAUDE_PROMPT_ASSET_DESCRIPTORS,
  ...COPILOT_PROMPT_ASSET_DESCRIPTORS,
  ...GEMINI_PROMPT_ASSET_DESCRIPTORS,
]);
