import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import type { AgentInputComposerDecoration } from './agentInputContracts';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

installAgentInputCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();

function flattenStyle(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (Array.isArray(value)) {
    return value.reduce<Record<string, unknown>>(
      (result, entry) => ({ ...result, ...flattenStyle(entry) }),
      {},
    );
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function findNode(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  hostType: string,
  testID: string,
) {
  const nodes = screen.findAll((node) => String(node.type) === hostType && node.props?.testID === testID);
  expect(nodes.length).toBe(1);
  return nodes[0]!;
}

const DECORATION_ID = 'acme.fixture:mounted-1:references';

const decorations = [{
  id: DECORATION_ID,
  key: 'references',
  decorations: {
    revision: 1,
    ranges: [
      {
        range: { start: 0, end: 5 },
        treatment: { kind: 'link' as const, url: 'https://example.com/first' },
        label: 'First reference',
      },
      {
        range: { start: 6, end: 12 },
        treatment: { kind: 'link' as const, url: 'https://example.com/second' },
        label: 'Second reference',
      },
      {
        range: { start: 13, end: 19 },
        treatment: 'warning' as const,
        label: 'Heads up',
      },
    ],
  },
}] satisfies readonly AgentInputComposerDecoration[];

async function renderComposerWithDecorations() {
  const { AgentInput } = await import('./AgentInput');
  return renderScreen(
    <AgentInput
      value="alpha bravo charlie"
      onChangeText={() => {}}
      placeholder="p"
      onSend={() => {}}
      autocompleteKinds={[]}
      autocompleteSuggestions={async () => []}
      disabled={false}
      showAbortButton={false}
      composerDecorations={decorations}
    />,
    { wrapper: runtime.Wrapper },
  );
}

describe('AgentInput composer decoration interactive targets', () => {
  it('gives composer link decorations the canonical minimum target without overlapping their stacked neighbour', async () => {
    const screen = await renderComposerWithDecorations();
    const expectedMinimum = resolveMinimumInteractiveTargetSize('web');

    for (const index of [0, 1]) {
      const link = findNode(screen, 'Pressable', `agent-input-composer-decoration:${DECORATION_ID}:${index}`);
      const style = flattenStyle(
        typeof link.props.style === 'function' ? link.props.style({ pressed: false }) : link.props.style,
      );
      expect(style.minWidth).toBeGreaterThanOrEqual(expectedMinimum);
      expect(style.minHeight).toBeGreaterThanOrEqual(expectedMinimum);

      // The decoration row stacks its entries with a small gap. A hit-slop
      // floor would expand each target past that gap and into its neighbour,
      // trading one accessibility defect for another; a layout floor cannot.
      expect(link.props.hitSlop ?? null).toBeNull();
    }

    // The floor belongs to interactive treatments only: a presentational
    // decoration keeps its compact composer-feedback size.
    const nonInteractive = findNode(screen, 'View', `agent-input-composer-decoration:${DECORATION_ID}:2`);
    const nonInteractiveStyle = flattenStyle(nonInteractive.props.style);
    expect(nonInteractiveStyle.minWidth).toBeUndefined();
    expect(nonInteractiveStyle.minHeight).toBeUndefined();
  });
});
