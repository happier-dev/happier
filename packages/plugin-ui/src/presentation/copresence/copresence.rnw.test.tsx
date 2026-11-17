import { act, useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import type { HappierCapsuleColors, HappierCapsuleHost } from '../status/capsuleHost.js';
import { HappierIdentityCapsule, HappierStatusCapsule } from '../status/StatusCapsule.js';
import {
  HAPPIER_INSTANT_AGENT_CURSOR_MOTION,
  HappierAgentCursor,
  resolveHappierAgentCursorPlacement,
  type HappierAgentCursorMotion,
  type HappierAgentCursorMotionDriver,
  type HappierAgentPoint,
  type HappierAgentTarget,
} from './AgentCursor.js';
import { HappierPresenceCapsule, type HappierPresence, type HappierPresenceCapsuleCopy } from './PresenceCapsule.js';
import { PresenceCapsule } from '../../components/Copresence.js';
import { PluginUiHostPresentationScope } from '../../components/PluginUiProvider.js';
import { projectHappierUiEnvironment } from '../../environment/projectEnvironment.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';

const COLORS: HappierCapsuleColors = {
  text: 'black',
  secondaryText: 'gray',
  warning: 'orange',
  stripBackground: 'white',
  stripBorder: 'silver',
};

const COPY: HappierPresenceCapsuleCopy = {
  agentTitle: 'Claude is browsing',
  agentDetail: 'Clicking “Sign in”',
  stopping: 'Stopping Claude…',
  stoppingDetail: 'Finishing its last step',
  humanTitle: 'You have control',
  humanDetail: null,
  pausedUntilHandBack: 'Claude is paused until you hand back',
  stopUnconfirmed: 'Couldn’t confirm the stop',
  lastActionMayHaveLanded: 'Claude’s last action may have landed',
  takeControl: 'Take control',
  handBack: 'Hand back',
  checkAgain: 'Check again',
  watch: 'Watch',
};

/** A host whose dock keeps a leaving capsule mounted until `settle()` is called, as a real exit does. */
function createHost(): Readonly<{ host: HappierCapsuleHost; settle: () => void }> {
  let settle = () => {};
  const host: HappierCapsuleHost = {
    Surface: (props) => <div data-testid={props.testID} data-elevation={props.elevation}>{props.children}</div>,
    Text: (props) => <span data-lines={props.numberOfLines}>{props.children}</span>,
    Button: (props) => (
      <button type="button" data-testid={props.testID} data-icon-only={String(props.iconOnly === true)} aria-label={props.iconOnly ? props.title : undefined}
        onClick={props.onPress} disabled={props.disabled} title={props.accessibilityHint}>{props.iconOnly ? props.leading : props.title}</button>
    ),
    Spinner: () => <span data-testid="spinner" />,
    renderGlyph: (glyph) => <span data-glyph={glyph} />,
    Dock: function Dock(props) {
      const [present, setPresent] = useStateForDock(props.visible);
      settle = () => setPresent(false);
      if (!present) return null;
      return <div data-leaving={String(!props.visible)}>{props.children(!props.visible)}</div>;
    },
  };
  return { host, settle: () => act(() => settle()) };
}


function useStateForDock(visible: boolean): [boolean, (value: boolean) => void] {
  const [present, setPresent] = useState(visible);
  useEffect(() => {
    if (visible) setPresent(true);
  }, [visible]);
  return [present || visible, setPresent];
}

const byTestId = (container: HTMLElement, testID: string) => container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);

async function click(element: HTMLElement | null): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('HappierPresenceCapsule', () => {
  it('lets the curated themed capsule recompose at its available width and restore its words', async () => {
    const { host } = createHost();
    const environment = projectHappierUiEnvironment(createSurfaceContext());
    const render = (availableWidth: number) => (
      <PluginUiHostPresentationScope environment={environment} presentationHost={{ capsuleHost: host }}>
        <PresenceCapsule presence={{ kind: 'agent', controlEpoch: 1 }} agentName="Claude" agentTitle={COPY.agentTitle}
          agentDetail={COPY.agentDetail ?? undefined} onTakeControl={() => undefined}
          availableWidth={availableWidth} placement="inline" testID="curated" />
      </PluginUiHostPresentationScope>
    );
    const mounted = mountThroughReactNativeWeb(render(115));
    try {
      const words = byTestId(mounted.container, 'curated-text');
      const handler = (words as unknown as { __reactLayoutHandler?: (event: unknown) => void }).__reactLayoutHandler;
      act(() => handler?.({ nativeEvent: { layout: { x: 0, y: 0, width: 4, height: 30 } } }));
      expect(byTestId(mounted.container, 'curated-text')).toBeNull();
      const take = byTestId(mounted.container, 'curated-take-control')!;
      expect(take.dataset.iconOnly).toBe('true');
      expect(take.getAttribute('aria-label')).toBe(COPY.takeControl);
      expect(byTestId(mounted.container, 'curated-agent')!.getAttribute('aria-label')).toContain(COPY.agentTitle);

      await mounted.render(render(400));
      expect(mounted.container.textContent).toContain(COPY.agentTitle);
      expect(byTestId(mounted.container, 'curated-take-control')!.dataset.iconOnly).toBe('false');
    } finally { mounted.unmount(); }
  });

  it('recomposes to the mark and an icon-only action when the frame is narrower than the words need, and restores when it grows', async () => {
    const { host } = createHost();
    const render = (availableWidth: number) => (
      <HappierPresenceCapsule presence={{ kind: 'agent', controlEpoch: 1 }} copy={COPY} colors={COLORS} host={host}
        onTakeControl={() => undefined} availableWidth={availableWidth} placement="inline" testID="p" />
    );
    const layout = (node: Element, width: number) => {
      const handler = (node as unknown as { __reactLayoutHandler?: (event: unknown) => void }).__reactLayoutHandler;
      expect(handler, 'the capsule measures its words').toBeDefined();
      act(() => handler!({ nativeEvent: { layout: { x: 0, y: 0, width, height: 30 } } }));
    };
    const mounted = mountThroughReactNativeWeb(render(115));
    try {
      // The words are squeezed to a sliver: nothing may be clipped, so the words give way.
      layout(byTestId(mounted.container, 'p-text')!, 4);
      expect(byTestId(mounted.container, 'p-text')).toBeNull();
      expect(mounted.container.textContent).not.toContain(COPY.agentTitle);
      const take = byTestId(mounted.container, 'p-take-control')!;
      expect(take.dataset.iconOnly).toBe('true');
      expect(take.getAttribute('aria-label')).toBe(COPY.takeControl);
      expect(byTestId(mounted.container, 'p-agent')!.getAttribute('aria-label')).toContain(COPY.agentTitle);

      // A frame wide enough for the words again gets them back, at the same state.
      await mounted.render(render(400));
      expect(byTestId(mounted.container, 'p-text')).toBeTruthy();
      expect(byTestId(mounted.container, 'p-take-control')!.dataset.iconOnly).toBe('false');
    } finally {
      mounted.unmount();
    }
  });

  it('keeps the words and the labelled action while there is room for them', async () => {
    const { host } = createHost();
    const mounted = mountThroughReactNativeWeb(
      <HappierPresenceCapsule presence={{ kind: 'agent', controlEpoch: 1 }} copy={COPY} colors={COLORS} host={host}
        onTakeControl={() => undefined} availableWidth={420} placement="inline" testID="p" />,
    );
    try {
      const handler = (byTestId(mounted.container, 'p-text') as unknown as { __reactLayoutHandler?: (event: unknown) => void }).__reactLayoutHandler;
      act(() => handler?.({ nativeEvent: { layout: { x: 0, y: 0, width: 220, height: 30 } } }));
      expect(mounted.container.textContent).toContain(COPY.agentTitle);
      expect(byTestId(mounted.container, 'p-take-control')!.dataset.iconOnly).toBe('false');
    } finally {
      mounted.unmount();
    }
  });

  it('keeps a strip\'s sentence on one line, and moves its buttons beneath it where the column would squeeze the words', async () => {
    const base = createHost().host;
    // The host's text reports the wrap the capsule asks for.
    const host: HappierCapsuleHost = {
      ...base,
      Text: (props) => (
        <span data-text-wrap={String((props.style as { textWrap?: string } | undefined)?.textWrap ?? '')}>{props.children}</span>
      ),
    };
    const render = (availableWidth: number) => (
      <HappierPresenceCapsule presence={{ kind: 'agent', controlEpoch: 1 }} copy={COPY} colors={COLORS} host={host}
        onWatch={() => undefined} onTakeControl={() => undefined} availableWidth={availableWidth} placement="strip" testID="p" />
    );
    const mounted = mountThroughReactNativeWeb(render(220));
    try {
      // One line: the title never balances itself across lines (that wrapped it one syllable per line).
      const title = [...mounted.container.querySelectorAll('span')].find((node) => node.textContent === COPY.agentTitle)!;
      expect(title.dataset.textWrap).not.toBe('balance');
      const words = byTestId(mounted.container, 'p-text')!;
      const handler = (words as unknown as { __reactLayoutHandler?: (event: unknown) => void }).__reactLayoutHandler;
      expect(handler, 'the strip measures its words').toBeDefined();
      act(() => handler!({ nativeEvent: { layout: { x: 0, y: 0, width: 24, height: 20 } } }));
      // Squeezed: the words keep the row, Watch and Take control (still labelled) move beneath them.
      const actions = byTestId(mounted.container, 'p-actions-beneath');
      expect(actions).toBeTruthy();
      expect(actions!.contains(byTestId(mounted.container, 'p-watch'))).toBe(true);
      expect(byTestId(mounted.container, 'p-take-control')!.dataset.iconOnly).toBe('false');
      expect(mounted.container.textContent).toContain(COPY.agentTitle);
      await mounted.render(render(600));
      expect(byTestId(mounted.container, 'p-actions-beneath')).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it('keeps an unavailable Watch visible and explains why it cannot open', async () => {
    const { host } = createHost();
    const onWatch = vi.fn();
    const mounted = mountThroughReactNativeWeb(
      <HappierPresenceCapsule presence={{ kind: 'agent', controlEpoch: 1 }} copy={COPY} colors={COLORS}
        host={host} onWatch={onWatch} watchDisabledReason="Machine is not answering" compact placement="strip" testID="p" />,
    );
    try {
      const watch = byTestId(mounted.container, 'p-watch') as HTMLButtonElement;
      expect(watch).toBeTruthy();
      expect(watch.disabled).toBe(true);
      expect(watch.title).toBe('Machine is not answering');
      await act(async () => { watch.click(); });
      expect(onWatch).not.toHaveBeenCalled();
    } finally { mounted.unmount(); }
  });

  it('keeps Watch reachable in a compact strip without requesting control', async () => {
    const { host } = createHost();
    let watching = false;
    const onTakeControl = vi.fn();
    const onWatch = () => { watching = true; };
    const render = (presence: HappierPresence) => (
      <HappierPresenceCapsule presence={presence} copy={COPY} colors={COLORS} host={host}
        compact placement="strip" onWatch={onWatch} onTakeControl={onTakeControl}
        onCheckAgain={() => undefined} testID="p" />
    );
    const mounted = mountThroughReactNativeWeb(render({ kind: 'agent', controlEpoch: 1 }));
    try {
      await click(byTestId(mounted.container, 'p-watch'));
      expect(watching).toBe(true);
      expect(onTakeControl).not.toHaveBeenCalled();
      // A source with no Watch operation must still offer no dead button.
      await mounted.render(<HappierPresenceCapsule presence={{ kind: 'agent', controlEpoch: 1 }}
        copy={COPY} colors={COLORS} host={host} compact placement="strip" testID="p" />);
      expect(byTestId(mounted.container, 'p-watch')).toBeNull();
      await mounted.render(render({ kind: 'unconfirmed', controlEpoch: 2 }));
      expect(byTestId(mounted.container, 'p-watch')).toBeNull();
      expect(byTestId(mounted.container, 'p-check-again')).toBeTruthy();
    } finally {
      mounted.unmount();
    }
  });

  it('does not mistake command acceptance for authoritative human control', async () => {
    const { host } = createHost();
    const mounted = mountThroughReactNativeWeb(
      <HappierPresenceCapsule presence={{ kind: 'agent', controlEpoch: 4 }} copy={COPY} colors={COLORS}
        host={host} onTakeControl={async () => ({ status: 'accepted' })} testID="p" />,
    );
    try {
      await click(byTestId(mounted.container, 'p-take-control'));
      expect(byTestId(mounted.container, 'p-stopping')).toBeTruthy();
      expect(byTestId(mounted.container, 'p-take-control')).toBeNull();
      expect(mounted.container.textContent).not.toContain(COPY.humanTitle);
    } finally {
      mounted.unmount();
    }
  });

  it.each(['failed', 'unknown'] as const)('offers Take control again after a %s result without inventing human control', async (status) => {
    const { host } = createHost();
    let answer!: (result: { status: 'failed' | 'unknown' }) => void;
    const onTakeControl = vi.fn(() => new Promise<{ status: 'failed' | 'unknown' }>((resolve) => { answer = resolve; }));
    const render = (presence: HappierPresence) => (
      <HappierPresenceCapsule presence={presence} copy={COPY} colors={COLORS} host={host}
        onTakeControl={onTakeControl} onHandBack={() => undefined} testID="p" />
    );
    const mounted = mountThroughReactNativeWeb(render({ kind: 'agent', controlEpoch: 4 }));
    try {
      await click(byTestId(mounted.container, 'p-take-control'));
      expect(byTestId(mounted.container, 'spinner')).toBeTruthy();
      await act(async () => { answer({ status }); });
      expect(byTestId(mounted.container, 'spinner')).toBeNull();
      expect(mounted.container.textContent).toContain(COPY.stopUnconfirmed);
      expect(mounted.container.textContent).not.toContain(COPY.humanTitle);
      expect(byTestId(mounted.container, 'p-hand-back')).toBeNull();
      await click(byTestId(mounted.container, 'p-take-control'));
      expect(onTakeControl).toHaveBeenCalledTimes(2);

      // A delayed transport answer cannot overrule a later authoritative controller event.
      await mounted.render(render({ kind: 'human', controlEpoch: 5, interruptedCompletion: null }));
      await act(async () => { answer({ status }); });
      expect(byTestId(mounted.container, 'p-human')).toBeTruthy();
      expect(byTestId(mounted.container, 'spinner')).toBeNull();
      expect(byTestId(mounted.container, 'p-hand-back')).toBeTruthy();
    } finally {
      mounted.unmount();
    }
  });

  it('recovers from a rejected takeover without a timer or an unhandled rejection', async () => {
    const { host } = createHost();
    const mounted = mountThroughReactNativeWeb(
      <HappierPresenceCapsule presence={{ kind: 'agent', controlEpoch: 4 }} copy={COPY} colors={COLORS}
        host={host} onTakeControl={() => Promise.reject(new Error('connection lost'))} testID="p" />,
    );
    try {
      await click(byTestId(mounted.container, 'p-take-control'));
      expect(byTestId(mounted.container, 'spinner')).toBeNull();
      expect(byTestId(mounted.container, 'p-take-control')).toBeTruthy();
      expect(mounted.container.textContent).not.toContain(COPY.humanTitle);
    } finally {
      mounted.unmount();
    }
  });

  it('ignores an old failure after a new controller epoch and a second takeover', async () => {
    const { host } = createHost();
    const answers: ((result: { status: 'failed' }) => void)[] = [];
    const onTakeControl = () => new Promise<{ status: 'failed' }>((resolve) => { answers.push(resolve); });
    const render = (controlEpoch: number) => (
      <HappierPresenceCapsule presence={{ kind: 'agent', controlEpoch }} copy={COPY} colors={COLORS}
        host={host} onTakeControl={onTakeControl} testID="p" />
    );
    const mounted = mountThroughReactNativeWeb(render(4));
    try {
      await click(byTestId(mounted.container, 'p-take-control'));
      await mounted.render(render(5));
      await click(byTestId(mounted.container, 'p-take-control'));
      await act(async () => { answers[0]!({ status: 'failed' }); });
      expect(byTestId(mounted.container, 'p-stopping')).toBeTruthy();
      expect(byTestId(mounted.container, 'p-take-control')).toBeNull();
      await act(async () => { answers[1]!({ status: 'failed' }); });
      expect(byTestId(mounted.container, 'p-take-control')).toBeTruthy();
    } finally {
      mounted.unmount();
    }
  });

  it('says stopping after Take control until the owner moves the control epoch, then offers Hand back', async () => {
    const { host } = createHost();
    const onTakeControl = vi.fn();
    const render = (presence: HappierPresence) => (
      <HappierPresenceCapsule
        presence={presence}
        copy={COPY}
        colors={COLORS}
        host={host}
        onTakeControl={onTakeControl}
        onHandBack={() => undefined}
        testID="p"
      />
    );
    const mounted = mountThroughReactNativeWeb(render({ kind: 'agent', controlEpoch: 4 }));
    try {
      expect(mounted.container.textContent).toContain('Clicking “Sign in”');
      await click(byTestId(mounted.container, 'p-take-control'));
      expect(onTakeControl).toHaveBeenCalledTimes(1);
      expect(byTestId(mounted.container, 'p-stopping')).toBeTruthy();
      expect(byTestId(mounted.container, 'p-take-control')).toBeNull();

      await mounted.render(render({ kind: 'human', controlEpoch: 5, interruptedCompletion: null }));
      expect(byTestId(mounted.container, 'p-human')).toBeTruthy();
      expect(byTestId(mounted.container, 'p-hand-back')).toBeTruthy();
      expect(mounted.container.textContent).toContain('Claude is paused until you hand back');
    } finally {
      mounted.unmount();
    }
  });

  it('never says you have control when the stop is unconfirmed, and offers the fresh look that confirms it', async () => {
    const { host } = createHost();
    const onCheckAgain = vi.fn();
    const mounted = mountThroughReactNativeWeb(
      <HappierPresenceCapsule
        presence={{ kind: 'unconfirmed', controlEpoch: 2 }}
        copy={COPY}
        colors={COLORS}
        host={host}
        onHandBack={() => undefined}
        onCheckAgain={onCheckAgain}
        testID="p"
      />,
    );
    try {
      expect(byTestId(mounted.container, 'p-unconfirmed')).toBeTruthy();
      expect(mounted.container.textContent).not.toContain('You have control');
      expect(mounted.container.textContent).toContain('Claude’s last action may have landed');
      await click(byTestId(mounted.container, 'p-check-again'));
      expect(onCheckAgain).toHaveBeenCalledTimes(1);
      expect(byTestId(mounted.container, 'p-hand-back')).toBeTruthy();
    } finally {
      mounted.unmount();
    }
  });

  it('lets the sentence that names the Machine wrap instead of clipping the name', () => {
    const { host } = createHost();
    const mounted = mountThroughReactNativeWeb(
      <HappierPresenceCapsule presence={{ kind: 'agent', controlEpoch: 1 }} copy={{ ...COPY, agentTitle: 'Claude is working on fly-bot-1' }}
        colors={COLORS} host={host} onTakeControl={async () => ({ status: 'accepted' })} placement="inline" testID="p" />,
    );
    try {
      const title = [...mounted.container.querySelectorAll('span')].find((node) => node.textContent === 'Claude is working on fly-bot-1');
      expect(title?.getAttribute('data-lines')).toBe('2');
    } finally {
      mounted.unmount();
    }
  });

  it('offers no control it cannot honour', () => {
    const { host } = createHost();
    const mounted = mountThroughReactNativeWeb(
      <HappierPresenceCapsule presence={{ kind: 'human', controlEpoch: 1 }} copy={COPY} colors={COLORS} host={host} testID="p" />,
    );
    try {
      expect(byTestId(mounted.container, 'p-hand-back')).toBeNull();
      expect(mounted.container.textContent).not.toContain('until you hand back');
    } finally {
      mounted.unmount();
    }
  });

  it('keeps its last words while a docked capsule leaves, and takes no Take control while leaving', async () => {
    const { host, settle } = createHost();
    const render = (presence: HappierPresence) => (
      <HappierPresenceCapsule presence={presence} copy={COPY} colors={COLORS} host={host} onTakeControl={() => undefined} testID="p" />
    );
    const mounted = mountThroughReactNativeWeb(render({ kind: 'agent', controlEpoch: 1 }));
    try {
      await mounted.render(render({ kind: 'idle', controlEpoch: 1 }));
      expect(byTestId(mounted.container, 'p-leaving-agent')).toBeTruthy();
      expect(mounted.container.textContent).toContain('Claude is browsing');
      await settle();
      expect(mounted.container.textContent).toBe('');
    } finally {
      mounted.unmount();
    }
  });

  it('renders nothing while nobody drives the surface and no dock holds it', () => {
    const { host } = createHost();
    const mounted = mountThroughReactNativeWeb(
      <HappierPresenceCapsule presence={{ kind: 'idle', controlEpoch: 0 }} copy={COPY} colors={COLORS} host={{ ...host, Dock: undefined }} testID="p" />,
    );
    try {
      expect(mounted.container.textContent).toBe('');
    } finally {
      mounted.unmount();
    }
  });
});

describe('HappierStatusCapsule', () => {
  it('keeps its sentence while it leaves through the host dock, then unmounts', async () => {
    const { host, settle } = createHost();
    const render = (visible: boolean, text: string) => (
      <HappierStatusCapsule visible={visible} text={text} busy colors={COLORS} host={host} testID="s" />
    );
    const mounted = mountThroughReactNativeWeb(render(true, 'Showing the last frame · reconnecting'));
    try {
      expect(byTestId(mounted.container, 'spinner')).toBeTruthy();
      await mounted.render(render(false, 'ignored while leaving'));
      expect(byTestId(mounted.container, 's-leaving')).toBeTruthy();
      expect(mounted.container.textContent).toContain('Showing the last frame · reconnecting');
      await settle();
      expect(byTestId(mounted.container, 's-leaving')).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it('announces its sentence as a status, not an unnamed region (C77)', () => {
    // Simulator stream at 1440 (11-17): RNW drew the capsule's `summary` role as <section role="region">, which axe
    // rejects (aria-allowed-role). A polite live sentence over a page is a status.
    const { host } = createHost();
    const mounted = mountThroughReactNativeWeb(
      <HappierStatusCapsule text="Reconnecting…" busy colors={COLORS} host={host} testID="s" />,
    );
    try {
      expect(mounted.container.querySelector('[role="region"]')).toBeNull();
      expect(mounted.container.querySelector('[role="status"]')?.textContent).toContain('Reconnecting…');
    } finally {
      mounted.unmount();
    }
  });

  it('offers its one way out beside the sentence', async () => {
    const { host } = createHost();
    const onPress = vi.fn();
    const mounted = mountThroughReactNativeWeb(
      <HappierStatusCapsule text="This page is taking a while" action={{ label: 'Open in your browser', onPress }} colors={COLORS} host={host} testID="s" />,
    );
    try {
      await click(byTestId(mounted.container, 's-action'));
      expect(onPress).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it('names an identity in flow with its leading mark, never through the dock and never as a live region', () => {
    const { host } = createHost();
    const mounted = mountThroughReactNativeWeb(
      <div data-testid="row">
        <HappierIdentityCapsule name="fly-bot-1" leading={<span data-testid="dot" />}
          colors={COLORS} host={host} testID="s" />
      </div>,
    );
    try {
      const capsule = byTestId(mounted.container, 's')!;
      expect(capsule.textContent).toBe('fly-bot-1');
      expect(capsule.contains(byTestId(mounted.container, 'dot'))).toBe(true);
      // In flow: no docked (leaving-aware) wrapper and no absolute dock positioning.
      expect(mounted.container.querySelector('[data-leaving]')).toBeNull();
      expect(capsule.parentElement?.getAttribute('data-testid')).toBe('row');
      // A name is not an event: assistive technology is not interrupted when it renders.
      expect(mounted.container.querySelector('[aria-live]')).toBeNull();
    } finally {
      mounted.unmount();
    }
  });
});

describe('HappierAgentCursor', () => {
  it('rings the target inside the drawn page, not the whole letterboxed surface', () => {
    // A 1280 × 800 page fitted into a 600 × 700 surface is drawn 600 × 375, 162.5 px from the top.
    const placement = resolveHappierAgentCursorPlacement(
      { x: 0.5, y: 0.25, width: 0.2, height: 0.1 },
      { x: 0, y: 162.5, width: 600, height: 375 },
    );
    expect(placement.point).toEqual({ x: 300, y: 256.25 });
    // The ring sits 3 px outside the element.
    expect(placement.ring?.top).toBeCloseTo(234.5);
    expect(placement.ring?.left).toBeCloseTo(237);
    expect(placement.ring?.height).toBeCloseTo(43.5);
  });

  it('mounts no hand until the agent acts, and stays out of the accessibility tree', () => {
    const render = (target: { x: number; y: number } | null) => (
      <HappierAgentCursor
        target={target}
        pageRect={{ x: 0, y: 0, width: 400, height: 300 }}
        renderGlyph={(glyph) => <span data-glyph={glyph} />}
        colors={{ line: 'black', casing: 'white' }}
        reducedMotion
        motion={HAPPIER_INSTANT_AGENT_CURSOR_MOTION}
        testID="c"
      />
    );
    const mounted = mountThroughReactNativeWeb(render(null));
    try {
      expect(byTestId(mounted.container, 'c-pointer')).toBeNull();
      expect(byTestId(mounted.container, 'c')?.getAttribute('aria-hidden')).toBe('true');
    } finally {
      mounted.unmount();
    }
  });
});

/** A host whose fades run until the test says they landed, as a real fast duration does. */
function createRecordingCursorMotion() {
  const calls: string[] = [];
  const landings = new Map<string, () => void>();
  const motion: HappierAgentCursorMotion = {
    set: (channel, value) => { calls.push(`set ${channel} ${value}`); },
    travel: (channel, value) => { calls.push(`travel ${channel} ${value}`); },
    setOpacity: (layer, value) => { calls.push(`opacity ${layer} ${value}`); },
    fade: (layer, to, _curve, onDone) => {
      calls.push(`fade ${layer} ${to}`);
      if (onDone) landings.set(`${layer} ${to}`, onDone); else landings.delete(`${layer} ${to}`);
    },
    ringOpacity: () => 0,
  };
  const driver: HappierAgentCursorMotionDriver = {
    useMotion: () => motion,
    Pointer: (props) => <div data-testid={props.testID}>{props.children}</div>,
    Ring: (props) => <div data-testid={props.testID}>{props.children}</div>,
  };
  return {
    driver,
    calls,
    land: (layer: 'pointer' | 'ring', to: number) => act(() => { landings.get(`${layer} ${to}`)?.(); }),
  };
}

const PAGE = { x: 0, y: 0, width: 400, height: 300 };
const NOTES: HappierAgentTarget = { x: 0.5, y: 0.5, width: 0.2, height: 0.1 };

describe('HappierAgentCursor point', () => {
  const renderCursor = (
    driver: HappierAgentCursorMotionDriver,
    props: Readonly<{ target: HappierAgentTarget | null; point?: HappierAgentPoint | null; reducedMotion?: boolean }>,
  ) => (
    <HappierAgentCursor
      target={props.target}
      point={props.point}
      pageRect={PAGE}
      renderGlyph={(glyph) => <span data-glyph={glyph} />}
      colors={{ line: 'black', casing: 'white' }}
      reducedMotion={props.reducedMotion ?? false}
      motion={driver}
      testID="c"
    />
  );

  it('shows an action whose target and end arrive in one render: arrives fully, then leaves once', async () => {
    const motion = createRecordingCursorMotion();
    const mounted = mountThroughReactNativeWeb(renderCursor(motion.driver, { target: null }));
    try {
      motion.calls.length = 0; // the idle mount's own hide is not under test
      expect(byTestId(mounted.container, 'c-pointer')).toBeNull();
      // The producer's target and its terminal state were applied in the same batch: this render never
      // saw a live target, only the retained point.
      await mounted.render(renderCursor(motion.driver, { target: null, point: { id: 'click-1', target: NOTES } }));
      expect(byTestId(mounted.container, 'c-pointer')).not.toBeNull();
      expect(byTestId(mounted.container, 'c-ring')).not.toBeNull();
      expect(motion.calls).toContain('set x 200');
      expect(motion.calls).toContain('fade pointer 1');
      // It has not started leaving: the hand must land before it goes.
      expect(motion.calls).not.toContain('fade pointer 0');
      motion.land('pointer', 1);
      expect(motion.calls).toContain('fade pointer 0');
      expect(motion.calls).toContain('fade ring 0');
    } finally {
      mounted.unmount();
    }
  });

  it('holds a landed point while its target is still live, and leaves when the target ends', async () => {
    const motion = createRecordingCursorMotion();
    const point = { id: 'click-1', target: NOTES };
    const mounted = mountThroughReactNativeWeb(renderCursor(motion.driver, { target: null }));
    try {
      motion.calls.length = 0; // the idle mount's own hide is not under test
      await mounted.render(renderCursor(motion.driver, { target: NOTES, point }));
      motion.land('pointer', 1);
      expect(motion.calls).not.toContain('fade pointer 0');
      await mounted.render(renderCursor(motion.driver, { target: null, point }));
      expect(motion.calls).toContain('fade pointer 0');
    } finally {
      mounted.unmount();
    }
  });

  it('moves smoothly to the next action and drops the pending fade, and shows a point once', async () => {
    const motion = createRecordingCursorMotion();
    const mounted = mountThroughReactNativeWeb(renderCursor(motion.driver, { target: null }));
    try {
      motion.calls.length = 0; // the idle mount's own hide is not under test
      await mounted.render(renderCursor(motion.driver, { target: null, point: { id: 'a', target: NOTES } }));
      motion.land('pointer', 1);
      motion.calls.length = 0;
      // The second action arrives while the first is still leaving: the hand travels, never jumps.
      await mounted.render(renderCursor(motion.driver, { target: null, point: { id: 'b', target: { ...NOTES, x: 0.25 } } }));
      expect(motion.calls).toContain('travel x 100');
      expect(motion.calls).not.toContain('set x 100');
      motion.calls.length = 0;
      // Rendering the same point again (any parent update) does not replay it.
      motion.land('pointer', 1);
      motion.calls.length = 0;
      await mounted.render(renderCursor(motion.driver, { target: null, point: { id: 'b', target: { ...NOTES, x: 0.25 } } }));
      expect(motion.calls).toEqual([]);
    } finally {
      mounted.unmount();
    }
  });

  it('does not replay the point that was already there when the cursor mounted', async () => {
    const motion = createRecordingCursorMotion();
    const mounted = mountThroughReactNativeWeb(renderCursor(motion.driver, { target: null, point: { id: 'old', target: NOTES } }));
    try {
      motion.calls.length = 0; // the idle mount's own hide is not under test
      expect(byTestId(mounted.container, 'c-pointer')).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it('reduced motion: shows the point at once, with no travel or fade, until the host withdraws it', async () => {
    const motion = createRecordingCursorMotion();
    const point = { id: 'click-1', target: NOTES };
    const mounted = mountThroughReactNativeWeb(renderCursor(motion.driver, { target: null, reducedMotion: true }));
    try {
      motion.calls.length = 0; // the idle mount's own hide is not under test
      await mounted.render(renderCursor(motion.driver, { target: null, point, reducedMotion: true }));
      expect(motion.calls).toContain('opacity pointer 1');
      expect(motion.calls.some((call) => call.startsWith('fade') || call.startsWith('travel'))).toBe(false);
      expect(motion.calls).not.toContain('opacity pointer 0');
      await mounted.render(renderCursor(motion.driver, { target: null, point: null, reducedMotion: true }));
      expect(motion.calls).toContain('opacity pointer 0');
    } finally {
      mounted.unmount();
    }
  });
});
