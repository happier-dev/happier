import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionCapabilitiesGetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { SessionSkillPlanV1Schema } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

afterEach(() => {
  standardCleanup();
});

const { buildSessionCapabilitiesModel } =
  await import('./sessionCapabilitiesModel');
const { SessionCapabilitiesContent } =
  await import('./SessionCapabilitiesContent');
const { t } = await import('@/text');

const names = {
  machineName: () => 'nl2',
  projectName: () => 'happier',
  agentName: () => 'Claude',
  agentNames: (ids: readonly string[]) => ids.map(() => 'Claude'),
  folderLabel: () => '~/happier',
};

function view(serverIds: readonly string[]) {
  const parsed = SessionCapabilitiesGetOutputV1Schema.parse({
    ok: true,
    mcp: {
      items: serverIds.map((id) => ({
        kind: 'mcp_server',
        id,
        name: id,
        source: 'catalog',
        selectable: true,
        selected: true,
        reason: 'rule_on',
        sessionOverride: null,
        decidedBy: { ruleId: id, target: 'allMachines', agentQualified: false },
      })),
    },
    skills: {
      items: [],
      plan: SessionSkillPlanV1Schema.parse({
        plan: 'session_dir',
        items: [],
        nativeDisables: [],
        diagnostics: [],
      }),
    },
    pendingApply: { mcp: false, skills: false },
    applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } },
  });
  if (!parsed.ok) throw new Error('invalid fixture');
  return parsed;
}

describe('SessionCapabilitiesContent · On demand servers', () => {
  it('leads an On demand server’s line with the word and counts 0 toward the per-turn total', async () => {
    // What the cost owner reports (useSessionCapabilitiesDetail): an On demand server adds nothing to a turn.
    const costs = {
      docs: { onDemand: true, toolCount: 25, tokensPerTurn: 0 },
      fetch: { toolCount: 2, tokensPerTurn: 400 },
    } as const;
    const model = buildSessionCapabilitiesModel({
      view: view(['docs', 'fetch']),
      state: 'ready',
      readOnly: false,
      names,
      rules: (_kind, id) => [
        {
          id,
          target: { t: 'allMachines' },
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      mcpStatus: () => [],
      skillStatus: () => [],
      cost: (_kind, id) => costs[id as keyof typeof costs] ?? null,
    });
    const screen = await renderScreen(
      <SessionCapabilitiesContent
        model={model}
        onChange={async () => {}}
        onRetry={() => {}}
        machineName="nl2"
        testID="caps"
      />,
    );
    const text = screen.getTextContent();

    expect(text).toContain(t('capabilities.mcp.tools.loading.onDemand'));
    // Only the Every turn server is in the session's per-turn total.
    expect(model.costLine).toBe(
      t('capabilities.facts.tokensPerTurn', { count: '400' }),
    );
    expect(text).toContain(model.costLine);
    // The word says what a turn carries; no "0 tokens" fact repeats it.
    expect(text).not.toMatch(new RegExp(`(^|[^0-9.])${t('capabilities.facts.tokensPerTurn', { count: '0' })}`));
  });
});
