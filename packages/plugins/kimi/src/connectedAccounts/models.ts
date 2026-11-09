import { z } from 'zod';

const modelResponse = z.object({ data: z.array(z.object({
  id: z.string().min(1), limit: z.object({ context: z.coerce.number().int().positive() }),
  display_name: z.string().optional(), protocol: z.string().optional(),
  modalities: z.object({ input: z.array(z.string()).optional() }).optional(),
  supports_tool_use: z.boolean().optional(), tools: z.object({ dynamic_load: z.boolean().optional() }).optional(),
  reasoning: z.object({ type: z.string(), effort: z.object({ valid: z.array(z.string()).optional(), default: z.string().optional() }).optional() }).optional(),
})) });
export function modelSelectionRequired(): never {
  throw Object.assign(new Error('Choose a model available to the selected Kimi account.'), { code: 'model_selection_required' });
}
/** Model IDs and capabilities come from this credential's /models response, never another home. */
export function buildKimiSelectedModelConfig(value: unknown, apiBase: string, defaultModel?: string) {
  const parsed = modelResponse.safeParse(value);
  if (!parsed.success || !parsed.data.data.length) return modelSelectionRequired();
  const models: Record<string, Record<string, unknown>> = {};
  for (const model of parsed.data.data) {
    const capabilities: string[] = [];
    if (model.reasoning?.type === 'only' || model.reasoning?.type === 'both') capabilities.push('thinking');
    if (model.reasoning?.type === 'only') capabilities.push('always_thinking');
    if (model.modalities?.input?.includes('image')) capabilities.push('image_in');
    if (model.modalities?.input?.includes('video')) capabilities.push('video_in');
    if (model.supports_tool_use !== false) capabilities.push('tool_use');
    if (model.tools?.dynamic_load === true) capabilities.push('dynamically_loaded_tools');
    models[`kimi-code/${model.id}`] = { provider: 'happier:kimi-code', model: model.id,
      max_context_size: model.limit.context, capabilities,
      ...(model.display_name ? { display_name: model.display_name } : {}),
      ...(model.protocol === 'anthropic' ? { protocol: 'anthropic' } : model.protocol === 'response' ? { protocol: 'openai_responses' } : {}),
      ...(model.protocol === 'anthropic' ? { beta_api: true, ...(capabilities.includes('thinking') ? { adaptive_thinking: true } : {}) } : {}),
      ...(model.reasoning?.effort?.valid ? { support_efforts: model.reasoning.effort.valid } : {}),
      ...(model.reasoning?.effort?.default ? { default_effort: model.reasoning.effort.default } : {}),
    };
  }
  const selected = defaultModel ?? Object.keys(models)[0]!;
  if (!Object.hasOwn(models, selected)) return modelSelectionRequired();
  return { default_model: selected, models,
    providers: { 'happier:kimi-code': { type: 'kimi', base_url: apiBase, api_key_env: 'HAPPIER_KIMI_ACCESS_TOKEN' } } };
}
