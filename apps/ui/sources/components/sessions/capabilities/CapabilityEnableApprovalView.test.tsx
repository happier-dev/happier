import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReachRulesWriteResult } from '@/sync/domains/capabilities/reach/useReachRulesState';

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

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve,
  };
}

/**
 * The card body over the real decision controller. Only the two Action boundaries are fakes: the approval
 * decision (the incumbent approval owner's network replay) and the rules write (P2's Action).
 */
async function mount(
  options: Readonly<{ approvalStatus?: 'open' | 'approved' | 'rejected' | 'canceled' }> = {},
) {
  const { createCapabilityEnableApprovalController } =
    await import('./capabilityEnableApprovalModel');
  const { CapabilityEnableApprovalView, describeCapabilityEnableSettled } =
    await import('./CapabilityEnableApprovalView');
  const calls: string[] = [];
  const writes: Deferred<ReachRulesWriteResult>[] = [];
  const controller = createCapabilityEnableApprovalController({
    alwaysWrite: {
      place: { t: 'project', projectKey: 'happier' },
      state: 'on',
    },
    decide: async (decision) => {
      calls.push(`decide:${decision}`);
      return true;
    },
    changeRules: (change) => {
      calls.push(`rules:${change.kind}`);
      const write = deferred<ReachRulesWriteResult>();
      writes.push(write);
      return write.promise;
    },
    undoRules: async () => {
      calls.push('undo:rules');
      return { ok: true, revision: 3 } as ReachRulesWriteResult;
    },
  });
  function Harness() {
    const snapshot = React.useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
      controller.getSnapshot,
    );
    const settled = describeCapabilityEnableSettled({
      approvalStatus: options.approvalStatus ?? 'open',
      snapshot,
      itemTitle: 'Linear',
      agentName: 'Codex',
      placeName: 'happier',
      timing: 'Joins after this turn',
      undoSession: () => {
        calls.push('undo:session');
      },
      undoAlways: () => controller.undoAlways(),
      retryAlways: () => controller.choose('always'),
    });
    return (
      <CapabilityEnableApprovalView
        chrome="card"
        decisionsAvailable={true}
        onChoose={(choice) => {
          void controller.choose(choice);
        }}
        model={{
          title: 'Codex wants Linear for this session',
          reason: 'To link the fix',
          offLine: 'Linear is off in happier.',
          alwaysLine: null,
          cost: null,
          timing: 'Joins after this turn',
          connected: false,
          allowLabel: 'Allow for this session',
          alwaysLabel: 'Always in happier',
          blocking: null,
          settled,
          decisionError: null,
          deciding: snapshot.status === 'deciding',
        }}
      />
    );
  }
  const screen = await renderScreen(<Harness />);
  const press = async (testID: string) => {
    const { act } = await import('react');
    const node = screen.findAll(
      (candidate) =>
        candidate.props?.testID === testID &&
        typeof candidate.props?.onPress === 'function',
    )[0];
    if (!node) throw new Error(`no pressable ${testID}`);
    await act(async () => {
      void node.props.onPress({});
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const settle = async (result: ReachRulesWriteResult) => {
    const { act } = await import('react');
    await act(async () => {
      writes.at(-1)!.resolve(result);
      await Promise.resolve();
    });
  };
  const has = (testID: string) =>
    screen.findAll((candidate) => candidate.props?.testID === testID).length >
    0;
  return {
    press,
    settle,
    has,
    calls,
    text: () => screen.getTextContent(),
  };
}

describe('CapabilityEnableApproval', () => {
  it('approves, then writes Always, and claims the rule only after the write returns; Undo restores the rules', async () => {
    const card = await mount();
    expect(
      card.has('capability-enable-session') &&
        card.has('capability-enable-always') &&
        card.has('capability-enable-reject'),
    ).toBe(true);
    await card.press('capability-enable-always');
    expect(card.calls).toEqual(['decide:approve', 'rules:write']);
    // The session is allowed; the place rule is still being written, so nothing claims it yet.
    expect(card.text()).toContain('capabilities.session.ask.saving');
    expect(card.has('capability-enable-undo-always')).toBe(false);
    await card.settle({ ok: true, revision: 2 } as ReachRulesWriteResult);
    expect(card.text()).toContain('capabilities.session.ask.alwaysOn');
    await card.press('capability-enable-undo-always');
    expect(card.calls).toEqual(['decide:approve', 'rules:write', 'undo:rules']);
    expect(card.has('capability-enable-undo-session')).toBe(true);
  }, 180_000);

  it('keeps the session approval when Always fails to save and retries only the write', async () => {
    const card = await mount();
    await card.press('capability-enable-always');
    await card.settle({ ok: false, message: 'conflict' });
    expect(card.text()).toContain('capabilities.session.ask.alwaysFailed');
    await card.press('capability-enable-retry-always');
    expect(card.calls).toEqual([
      'decide:approve',
      'rules:write',
      'rules:write',
    ]);
  }, 180_000);

  it('Not now rejects with no rules write; an answer from another device settles without local Undo', async () => {
    const card = await mount();
    await card.press('capability-enable-reject');
    expect(card.calls).toEqual(['decide:reject']);
    expect(card.has('capability-enable-settled')).toBe(true);
    const elsewhere = await mount({ approvalStatus: 'approved' });
    expect(elsewhere.text()).toContain(
      'capabilities.session.ask.answeredElsewhere',
    );
    expect(elsewhere.has('capability-enable-session')).toBe(false);
    expect(elsewhere.has('capability-enable-undo-session')).toBe(false);
  }, 180_000);

  it('a canceled request settles to its status with no controls, and never claims the item is off, even once it was enabled elsewhere', async () => {
    const canceled = await mount({ approvalStatus: 'canceled' });
    expect(canceled.has('capability-enable-settled')).toBe(true);
    expect(canceled.text()).toContain('approvals.status.canceled');
    expect(canceled.text()).toContain('Linear');
    for (const id of [
      'capability-enable-session',
      'capability-enable-always',
      'capability-enable-reject',
      'capability-enable-undo-session',
      'capability-enable-undo-always',
    ]) {
      expect(canceled.has(id)).toBe(false);
    }
    // The card's body (the question and its historical Off line) is not drawn once canceled.
    expect(canceled.text()).not.toContain('Linear is off in happier.');
    expect(canceled.text()).not.toContain('Codex wants Linear for this session');
  }, 180_000);

  it('binds Details to the same controller: Always is the alternative decision, then the settled line with Undo', async () => {
    const { createCapabilityEnableApprovalController, } = await import('./capabilityEnableApprovalModel');
    const { CapabilityEnableDecisionBar, describeCapabilityEnableSettled } = await import('./CapabilityEnableApprovalView');
    const calls: string[] = [];
    const write = deferred<ReachRulesWriteResult>();
    const controller = createCapabilityEnableApprovalController({
      alwaysWrite: { place: { t: 'project', projectKey: 'happier' }, state: 'on' },
      decide: async (decision) => { calls.push(`decide:${decision}`); return true; },
      changeRules: (change) => { calls.push(`rules:${change.kind}`); return write.promise; },
      undoRules: async () => { calls.push('undo:rules'); return { ok: true, revision: 3 } as ReachRulesWriteResult; },
    });
    function Details() {
      const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
      const settled = describeCapabilityEnableSettled({ approvalStatus: 'open', snapshot, itemTitle: 'Linear', agentName: 'Codex',
        placeName: 'happier', timing: null, undoSession: () => {}, undoAlways: () => controller.undoAlways(), retryAlways: () => controller.choose('always') });
      return <CapabilityEnableDecisionBar disabled={false} onDismiss={() => { calls.push('dismiss'); }}
        choose={(choice) => controller.choose(choice)}
        model={{ allowLabel: 'Allow for this session', alwaysLabel: 'Always in happier', blocking: null, settled, deciding: snapshot.status === 'deciding' }} />;
    }
    const screen = await renderScreen(<Details />);
    const { act } = await import('react');
    const press = async (testID: string) => {
      const node = screen.findAll((candidate) => candidate.props?.testID === testID && typeof candidate.props?.onPress === 'function')[0];
      if (!node) throw new Error(`no pressable ${testID}`);
      await act(async () => { void node.props.onPress({}); await new Promise((resolve) => setTimeout(resolve, 0)); });
    };
    expect(screen.findAll((node) => node.props?.testID === 'approvals.always').length).toBeGreaterThan(0);
    await press('approvals.always');
    expect(calls).toEqual(['decide:approve', 'rules:write']);
    expect(screen.getTextContent()).toContain('capabilities.session.ask.saving');
    await act(async () => { write.resolve({ ok: true, revision: 2 } as ReachRulesWriteResult); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getTextContent()).toContain('capabilities.session.ask.alwaysOn');
    await press('capability-enable-undo-always');
    expect(calls).toEqual(['decide:approve', 'rules:write', 'undo:rules']);
  }, 180_000);
});
