import { act, useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import type { HappierCapsuleColors, HappierCapsuleHost } from '../status/capsuleHost.js';
import { HappierStatusCapsule } from '../status/StatusCapsule.js';
import {
  HAPPIER_INSTANT_AGENT_CURSOR_MOTION,
  HappierAgentCursor,
  resolveHappierAgentCursorPlacement,
} from './AgentCursor.js';
import { HappierPresenceCapsule, type HappierPresence, type HappierPresenceCapsuleCopy } from './PresenceCapsule.js';

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
    Text: (props) => <span>{props.children}</span>,
    Button: (props) => (
      <button type="button" data-testid={props.testID} onClick={props.onPress}>{props.title}</button>
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

  it('stands inline in flow as an identity capsule, with its leading mark, never through the dock', () => {
    const { host } = createHost();
    const mounted = mountThroughReactNativeWeb(
      <div data-testid="row">
        <HappierStatusCapsule placement="inline" text="fly-bot-1" leading={<span data-testid="dot" />}
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
