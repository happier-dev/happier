import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import { UsageEventIngestRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { estimateUsageModelCost } from '@happier-dev/protocol/usage/usageCost';
import { resolveUsageTokenCategories } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildUsageEventIngestRequest } from '@/usage/buildUsageEventIngestRequest';
import { buildNativeAgentUsageAccountingMetadata, toNativeAgentUsageObservation } from '@/usage/nativeAgentUsageObservation';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';

it.each(['nativeDefault', 'selected'] as const)('retains the catalog-qualified model from %s native usage through ingest and pricing', async selection => {
  // Captured MSP shape: tokenUsage has a bare modelId; contextUsage has neither
  // modelId nor paid counters. Substitute the model witnessed in r197 only.
  const captured = await readFile(new URL('./testkit/fixtures/login-smoke.json', import.meta.url), 'utf8');
  const recording = JSON.parse(captured.replaceAll('muse-wonder-1.0', 'muse-spark-1.3-contributor'));
  const fixture = await createAdmittedMuseSessionFixture({ native: { recording } });
  const events = createAgentSessionRuntimeHarness();
  try {
    const session = await fixture.open({ kind: 'create', sessionId: fixture.context.session.id, cwd: process.cwd(),
      ...(selection === 'selected' ? { modelSelection: { modelId: 'meta/muse-spark-1.3-contributor' } } : {}),
    });
    session.watch(events.recordRuntimeEvent);
    await session.send({ inputIds: ['priced-input'], input: { text: 'Reply with exactly PEBBLE. Do not use tools.' },
      delivery: { kind: 'newTurn', turnId: 'priced-turn' } });
    await events.until('turn-complete', { signal: fixture.context.signal });
    const usage = events.canonicalEvents().filter(event => event.kind === 'usage-observed');
    const measured = usage.find(event => event.tokens);
    if (!measured) throw new Error('Expected the captured measured inference');
    const request = UsageEventIngestRequestSchema.parse(buildUsageEventIngestRequest({
      sessionId: fixture.context.session.id, observedAt: measured.emittedAtMs,
      observation: toNativeAgentUsageObservation(measured, 'muse'),
      metadata: buildNativeAgentUsageAccountingMetadata(measured),
    }));
    expect(request.modelId).toBe('meta/muse-spark-1.3-contributor');
    const categories = resolveUsageTokenCategories(request.tokens, measured.accounting);
    expect(categories).toEqual({ input: 28177, output: 12, reasoning: 10, cacheRead: 0, cacheWrite: 0, total: 28199 });
    expect(estimateUsageModelCost(request.modelId, categories)?.estimatedUsd).toBeGreaterThan(0);
    const context = usage.find(event => event.context);
    expect(context).toMatchObject({ context: { modelId: null, usedTokens: 28446, windowTokens: 1007997 } });
    expect(context?.modelId).toBeUndefined();
    expect(context?.tokens).toBeUndefined();
    events.expectAllEventsValidated();
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    // Qualification consumes the existing catalog/session observation, with no
    // model inventory RPC per token notification or extra inference.
    expect(audit.methods.filter(method => method === 'model/list')).toHaveLength(selection === 'selected' ? 1 : 0);
    expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(1);
  } finally { events.dispose(); await fixture.dispose(); }
});
