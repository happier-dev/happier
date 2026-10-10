import { createHmac, randomBytes } from 'node:crypto';
import type { PromptPlanV1, ProviderBoundModelRef } from '@happier-dev/protocol';
import type { UsagePromptCompositionComponent } from '@happier-dev/protocol/usage/coach/usagePromptComposition';

/** Private to this host preparation lifetime; no labels, text or hash key cross the Session boundary. */
export function createPromptCompositionScope() {
  const key = randomBytes(32);
  const hash = (domain: string, value: string) => createHmac('sha256', key).update(`${domain}\0`).update(value).digest('hex');
  return {
    identifyRequest(value: string, selection: ProviderBoundModelRef) {
      return { scopeKey: hash('request-scope', ''), digest: hash('host-request', value), selection };
    },
    measure(source: string, text: string, kind: UsagePromptCompositionComponent['kind'],
      location: UsagePromptCompositionComponent['location'], overlap: UsagePromptCompositionComponent['overlap']): UsagePromptCompositionComponent {
      return { sourceId: hash('source', source), digest: hash('content', text), kind, location,
        byteLength: Buffer.byteLength(text, 'utf8'), tokenCount: null, tokenizerId: null,
        cacheClass: 'unknown', overlap };
    },
  };
}
export type PromptCompositionScope = ReturnType<typeof createPromptCompositionScope>;
export type PromptPlanComposition = Readonly<{ components: readonly UsagePromptCompositionComponent[] }>;

/** The plan is already normalized/deduplicated by its canonical producer, not reinterpreted here. */
export function measurePromptPlanComposition(plan: PromptPlanV1, scope: PromptCompositionScope): PromptPlanComposition {
  return { components: plan.blocks.map(block => scope.measure(block.id, block.text.normalize('NFC'),
    block.scope === 'tool_delivery' || block.id.startsWith('plugin_tool_prompt.') ? 'tool_guidance' : 'instructions',
    'user', 'none')) };
}
