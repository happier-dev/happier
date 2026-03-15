import { getAgentModelConfig } from '@happier-dev/agents';

export function getSuggestedGeminiModelsForUi(): string[] {
  const cfg = getAgentModelConfig('gemini');
  const raw = Array.isArray(cfg.allowedModes) ? cfg.allowedModes : [];
  const cleaned = raw.map((m) => (typeof m === 'string' ? m.trim() : '')).filter(Boolean);
  const seen = new Set<string>();
  return cleaned.filter((m) => {
    if (seen.has(m)) return false;
    seen.add(m);
    return true;
  });
}

