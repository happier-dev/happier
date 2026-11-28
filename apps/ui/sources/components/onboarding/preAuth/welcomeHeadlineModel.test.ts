import { listSelectableBundledAgentExecutionTargets } from '@happier-dev/agents/definitions';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key: string, params?: Record<string, unknown>) =>
      params?.agent ? `${key}:${String(params.agent)}` : key,
  });
});

import {
  WELCOME_HEADLINE_FEATURE_IDS,
  composeWelcomeHeadlineOrder,
  readWelcomeHeadlineVisitOrder,
  translateWelcomeHeadline,
} from './welcomeHeadlineModel';

/** A seeded generator, so a case reads the same every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const catalogAgents = [
  ...new Set(
    listSelectableBundledAgentExecutionTargets().map((entry) => entry.agentId),
  ),
];

describe('the first Welcome headline order', () => {
  it.each([1, 7, 42, 1999])(
    'shows every supported Agent and every feature once, never more than two Agents in a row (seed %i)',
    (seed) => {
      const order = composeWelcomeHeadlineOrder({
        agentIds: catalogAgents,
        featureIds: WELCOME_HEADLINE_FEATURE_IDS,
        random: seeded(seed),
      });
      const agents = order.flatMap((entry) =>
        entry.kind === 'agent' ? [entry.agentId] : [],
      );
      const features = order.flatMap((entry) =>
        entry.kind === 'feature' ? [entry.featureId] : [],
      );
      expect([...agents].sort()).toEqual([...catalogAgents].sort());
      expect([...features].sort()).toEqual(
        [...WELCOME_HEADLINE_FEATURE_IDS].sort(),
      );
      // Wrapping around: the run that ends the cycle continues into the run that starts it.
      const kinds = [...order, ...order].map((entry) => entry.kind).join(' ');
      expect(kinds).not.toContain('agent agent agent');
      // The phrase every still presentation shows is a feature: one Agent's name alone reads as a single-Agent app.
      expect(order[0]?.kind).toBe('feature');
    },
  );

  it('starts on a feature even when the spread would open on an Agent', () => {
    // A phase near 1 puts an Agent in the spread's first slot.
    const order = composeWelcomeHeadlineOrder({
      agentIds: catalogAgents,
      featureIds: WELCOME_HEADLINE_FEATURE_IDS,
      random: () => 0.99,
    });
    expect(order[0]?.kind).toBe('feature');
    expect(order).toHaveLength(catalogAgents.length + WELCOME_HEADLINE_FEATURE_IDS.length);
    const kinds = [...order, ...order].map((entry) => entry.kind).join(' ');
    expect(kinds).not.toContain('agent agent agent');
  });

  it('chooses a different order on another visit', () => {
    const first = composeWelcomeHeadlineOrder({
      agentIds: catalogAgents,
      featureIds: WELCOME_HEADLINE_FEATURE_IDS,
      random: seeded(3),
    });
    const second = composeWelcomeHeadlineOrder({
      agentIds: catalogAgents,
      featureIds: WELCOME_HEADLINE_FEATURE_IDS,
      random: seeded(4),
    });
    expect(second).not.toEqual(first);
  });

  it('keeps one order for the whole visit, so every Welcome and the opening replica start on the same phrase', () => {
    expect(readWelcomeHeadlineVisitOrder()).toBe(
      readWelcomeHeadlineVisitOrder(),
    );
  });

  it('names each Agent by the Agent catalog and translates every phrase', () => {
    const headline = translateWelcomeHeadline([
      { kind: 'agent', agentId: 'codex' },
      { kind: 'feature', featureId: 'reviews' },
    ]);
    expect(headline.phrases).toEqual([
      {
        lead: 'welcome.headline.agentLead',
        vary: 'welcome.headline.agentVary:Codex',
      },
      {
        lead: 'welcome.headline.reviewsLead',
        vary: 'welcome.headline.reviewsVary',
      },
    ]);
    expect(headline.line2).toBe('welcome.headline.everywhere');
  });
});
