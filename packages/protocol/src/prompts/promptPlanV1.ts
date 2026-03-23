export type PromptModalityV1 = 'coding' | 'voice';

export type PromptBlockScopeV1 =
  | 'session'
  | 'first_turn'
  | 'turn'
  | 'provider_behavior'
  | 'tool_delivery'
  | 'user_prompt'
  | 'bootstrap';

export type PromptBlockV1 = Readonly<{
  id: string;
  scope: PromptBlockScopeV1;
  text: string;
  enabled?: boolean;
}>;

export type PromptPlanV1 = Readonly<{
  modality: PromptModalityV1;
  blocks: readonly PromptBlockV1[];
}>;

function normalizePromptBlock(block: PromptBlockV1): PromptBlockV1 | null {
  if (!block || typeof block !== 'object') return null;
  if (block.enabled === false) return null;
  const id = typeof block.id === 'string' ? block.id.trim() : '';
  const text = typeof block.text === 'string' ? block.text.trim() : '';
  if (!id || !text) return null;
  return {
    id,
    scope: block.scope,
    text,
  };
}

export function dedupePromptBlocksV1(blocks: ReadonlyArray<PromptBlockV1 | null | undefined>): PromptBlockV1[] {
  const out: PromptBlockV1[] = [];
  const seen = new Set<string>();

  for (const candidate of blocks) {
    if (!candidate) continue;
    const normalized = normalizePromptBlock(candidate);
    if (!normalized) continue;
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }

  return out;
}

export function buildPromptPlanV1(args: Readonly<{
  modality: PromptModalityV1;
  blocks: ReadonlyArray<PromptBlockV1 | null | undefined>;
}>): PromptPlanV1 {
  return {
    modality: args.modality,
    blocks: dedupePromptBlocksV1(args.blocks),
  };
}

export function renderPromptBlocksV1(blocks: ReadonlyArray<PromptBlockV1 | null | undefined>): string {
  return dedupePromptBlocksV1(blocks)
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

export function renderPromptPlanV1(plan: PromptPlanV1): string {
  return renderPromptBlocksV1(plan.blocks);
}

export function buildPromptPlanDiagnosticsV1(plan: PromptPlanV1): Readonly<{
  modality: PromptModalityV1;
  blockIds: string[];
  scopes: PromptBlockScopeV1[];
}> {
  return {
    modality: plan.modality,
    blockIds: plan.blocks.map((block) => block.id),
    scopes: plan.blocks.map((block) => block.scope),
  };
}
