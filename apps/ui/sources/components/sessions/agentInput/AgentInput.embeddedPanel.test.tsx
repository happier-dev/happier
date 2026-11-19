import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';
import type { AgentInputExtraActionChip } from './agentInputContracts';

installAgentInputCommonModuleMocks();
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
  ),
);
installDisconnectedServerSocketBoundary();
const { installSessionPaneRuntimeTestHarness } =
  await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness();
// The composer's first import is cold and slow; load it once before the harness's per-test setup runs.
beforeAll(async () => { await import('./AgentInput'); }, 300_000);

const INPUT = 'new-session-composer-input';
const PLUS = 'agent-input-action-menu-button';

/** A workflow step's own overflow control, so the composer's "+" has something to hold. */
const STEP_OPTIONS: AgentInputExtraActionChip = {
  key: 'workflow-step-options',
  controlId: 'shortcuts',
  placement: {
    id: 'shortcuts:workflow-step-options',
    title: 'Step options',
    defaultPlacement: 'overflow',
  },
  render: () => null,
  collapsedAction: ({ dismiss }) => ({
    id: 'workflow-step-options',
    testID: 'step-options-row',
    label: 'Step options',
    onPress: dismiss,
  }),
};

async function renderEditable(
  panelPresentation?: 'document' | 'embedded',
  props: Partial<React.ComponentProps<typeof import('./AgentInput').AgentInput>> = {},
) {
  const { AgentInput } = await import('./AgentInput');
  return renderScreen(
    <AgentInput
      value="Run the checks and find what broke."
      onChangeText={() => {}}
      placeholder="p"
      autocompleteKinds={[]}
      autocompleteSuggestions={async () => []}
      showAbortButton={false}
      extraActionChips={[STEP_OPTIONS]}
      {...(panelPresentation === undefined ? {} : { panelPresentation })}
      {...props}
    />,
    { wrapper: runtime.Wrapper },
  );
}

const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style)
    ? style.reduce<Record<string, unknown>>(
        (all, entry) => ({ ...all, ...flat(entry) }),
        {},
      )
    : style && typeof style === 'object'
      ? (style as Record<string, unknown>)
      : {};

const hostAncestors = (node: ReactTestInstance): ReactTestInstance[] => {
  const chain: ReactTestInstance[] = [];
  for (let at: ReactTestInstance | null = node; at !== null; at = at.parent) {
    if (typeof at.type === 'string') chain.push(at);
  }
  return chain;
};

/** The nearest host view holding both the prompt and its "+": the line, or the column, they share. */
function sharedContainer(screen: Awaited<ReturnType<typeof renderEditable>>) {
  const input = screen.findHostByTestId(INPUT)!;
  const plus = screen.findHostByTestId(PLUS)!;
  const plusChain = new Set(hostAncestors(plus));
  return hostAncestors(input).find((node) => plusChain.has(node))!;
}

describe('AgentInput embedded in a host card', () => {
  it('puts its "+" on the prompt\'s own line, so editing adds no row under the prompt', async () => {
    const screen = await renderEditable('embedded');
    expect(flat(sharedContainer(screen).props.style).flexDirection).toBe('row');
    // The prompt's tools ride the same line, beside the "+".
    expect(
      screen.findHostByTestId('agent-input-field-accessories'),
    ).not.toBeNull();
    // The "+" keeps its menu: the attachments and the step's own overflow stay one press away.
    await screen.pressByTestIdAsync(PLUS);
    expect(
      screen.findHostByTestId('agent-input-action-menu-overlay'),
    ).not.toBeNull();
    await screen.pressByTestIdAsync('step-options-row');
  });

  it("adds no vertical inset of its own: the host card's rhythm places the text, as it does at rest", async () => {
    const screen = await renderEditable('embedded');
    const panel = screen.findHostByTestId('agent-input-material-surface')!;
    const input = screen.findHostByTestId(INPUT)!;
    let inset = 0;
    for (const node of hostAncestors(input)) {
      const style = flat(node.props.style);
      inset +=
        Number(
          style.paddingTop ?? style.paddingVertical ?? style.padding ?? 0,
        ) +
        Number(
          style.paddingBottom ?? style.paddingVertical ?? style.padding ?? 0,
        );
      if (node === panel) break;
    }
    expect(inset).toBe(0);
  });

  it('gives the prompt every point its tools do not take: the field keeps no corner for them or the expand toggle', async () => {
    // A step's prompt clips like a Session's, so the expand toggle is configured (WorkflowStepPromptField).
    const screen = await renderEditable('embedded', {
      inputExpansion: { expanded: false, collapsedMaxHeight: 120, onToggle: () => {} },
    });
    const field = screen.findAll(
      (node) => node.props?.testID === INPUT && 'paddingRight' in node.props,
    )[0]!;
    expect(field.props.paddingRight ?? 0).toBe(0);
  });

  it.each([undefined, 'document'] as const)(
    'keeps the chip rail under the prompt for the %s presentation',
    async (presentation) => {
      const screen = await renderEditable(presentation);
      expect(flat(sharedContainer(screen).props.style).flexDirection).not.toBe(
        'row',
      );
      expect(screen.findHostByTestId(PLUS)).not.toBeNull();
    },
  );
});
