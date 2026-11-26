import type { AgentAcpModelControls } from '@happier-dev/plugin-sdk/agents/runtime';

/** Native `session/new` configOptions id for reasoning effort. */
export const ANTIGRAVITY_EFFORT_CONFIG_ID = 'thought_level';
const RETIRED_EFFORT_SUFFIX = /^(.+)-(low|medium|high|xhigh|max)$/u;

/**
 * Native agy advertises family models in its `model` config option and effort
 * in `thought_level`; the host projects both from that catalog. Saved choices
 * and Run configurations may still name the flat effort-suffixed ids
 * (`gemini-4-neon-medium`) of agy's legacy model list: select the advertised
 * family and apply its effort through `session/set_config_option`.
 */
export const antigravityModelControls: AgentAcpModelControls = {
  projectModel: (_raw, model) => model,
  resolveModelUpdate({ modelId, modelState }) {
    const models = modelState?.availableModels ?? [];
    if (models.some(model => model.id === modelId)) return null;
    const match = RETIRED_EFFORT_SUFFIX.exec(modelId);
    if (!match) return null;
    const [, familyId, effort] = match as unknown as [string, string, string];
    if (!models.some(model => model.id === familyId)) return null;
    const effortOption = models.flatMap(model => model.modelOptions ?? [])
      .find(option => option.id === ANTIGRAVITY_EFFORT_CONFIG_ID);
    if (!effortOption) return null;
    // Keep the current effort when this account's catalog lacks the saved level.
    const value = effortOption.options?.some(option => option.value === effort) ? effort : effortOption.currentValue;
    return { modelId: familyId, configOptions: { [ANTIGRAVITY_EFFORT_CONFIG_ID]: value } };
  },
};
