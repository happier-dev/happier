import { AGENT_DEFINITION } from '../definition.js';

export function getSuggestedGeminiModelsForUi(): readonly string[] {
  const seen = new Set<string>();
  return AGENT_DEFINITION.modelConfig.allowedModes
    .map((model) => model.trim())
    .filter((model) => {
      if (!model || seen.has(model)) return false;
      seen.add(model);
      return true;
    });
}
