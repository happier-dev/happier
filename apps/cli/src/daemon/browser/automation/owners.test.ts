import { describe, expect, it } from 'vitest';

import { createBrowserAutomationOwnerRegistry } from './owners';

const view = { browserSessionId: 'browser_session_1', viewId: 'view_1' } as const;
const otherView = { browserSessionId: 'browser_session_1', viewId: 'view_2' } as const;

describe('browser automation owner registry', () => {
  it('projects the confidential hold until the source is authoritatively destroyed', async () => {
    const registry = createBrowserAutomationOwnerRegistry();
    expect(registry.getControllerState(view).confidentialityHeld).toBeUndefined();
    await registry.acquireConfidentiality(view);
    expect(registry.getControllerState(view).confidentialityHeld).toBe(true);
    registry.handBack(view);
    expect(registry.getControllerState(view).confidentialityHeld).toBe(true);
    registry.closeView(view);
    expect(registry.getControllerState(view).confidentialityHeld).toBe(true);
    registry.closeView(view, { sourceDestroyed: true });
    expect(registry.getControllerState(view).confidentialityHeld).toBeUndefined();
  });
  it('does not mistake an ordinarily closed input target for a confidential source', async () => {
    const registry = createBrowserAutomationOwnerRegistry();
    await registry.getInputControl(view).close('view_closed');
    registry.closeView(view);
    expect(registry.isObservationHeld(view)).toBe(false);
    expect(registry.getInputControl(view).isClosed()).toBe(false);
  });

  it('retains a closed confidential source after transport loss until destruction is confirmed', async () => {
    const registry = createBrowserAutomationOwnerRegistry();
    await registry.acquireConfidentiality(view);
    registry.closeView(view);
    expect(registry.isObservationHeld(view)).toBe(true);
    expect(registry.getInputControl(view).isClosed()).toBe(true);
    registry.closeView(view, { sourceDestroyed: true });
    expect(registry.isObservationHeld(view)).toBe(false);
  });

  it('retains confidentiality across hand back until every reviewed fill is safe', async () => {
    const registry = createBrowserAutomationOwnerRegistry();
    await registry.acquireConfidentiality(view);
    registry.handBack(view);
    expect(registry.isObservationHeld(view)).toBe(true);
    expect(registry.isObservationHeld(otherView)).toBe(false);
    let finish: (safe: boolean) => void = () => undefined;
    const firstSafety = new Promise<boolean>(resolve => { finish = resolve; });
    registry.setConfidentialitySafetyCheck(view, () => firstSafety);
    const release = registry.tryReleaseConfidentiality(view);
    let secondSafe = false;
    registry.setConfidentialitySafetyCheck(view, async () => secondSafe);
    finish(true);
    expect(await release).toBe(false);
    expect(registry.isObservationHeld(view)).toBe(true);
    expect(await registry.tryReleaseConfidentiality(view)).toBe(false);
    registry.setConfidentialitySafetyCheck(view, async () => true);
    expect(await registry.tryReleaseConfidentiality(view)).toBe(false);
    secondSafe = true;
    expect(await registry.tryReleaseConfidentiality(view)).toBe(true);
    expect(registry.isObservationHeld(view)).toBe(false);
  });

  it('projects interruption settlement and clears uncertainty after a fresh human observation', async () => {
    const registry = createBrowserAutomationOwnerRegistry();
    const control = registry.getInputControl(view);
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const pending = control.execute({ requestedBy: 'agent', effect: async () => { await gate; }, classifyCompletion: () => 'unknown' });
    const takeover = control.takeOver();
    expect(registry.getControllerState(view)).toMatchObject({ controller: 'human', interruptionSettling: true });
    finish();
    await pending;
    await takeover;
    expect(registry.getControllerState(view)).toMatchObject({ controller: 'human', interruptionSettling: false, uncertain: true });
    expect(control.observe(control.getStatus().controlEpoch)).toBe(true);
    expect(registry.getControllerState(view)).toMatchObject({ uncertain: false });
  });
  it('holds human control after the active action drains until explicit hand back', () => {
    const registry = createBrowserAutomationOwnerRegistry();
    registry.takeOver(view);
    expect(registry.getControllerState(view).controller).toBe('human');
    expect(registry.getControllerState(view, { controller: 'agent', activeAutomationRequestId: 'old' }).controller).toBe('human');
    registry.handBack(view);
    expect(registry.getControllerState(view)).toMatchObject({ controller: 'none', controlEpoch: 2 });
    expect(registry.getControllerState(otherView).controlEpoch).toBe(0);
  });
  it('reports an idle view as uncontrolled with no active request', () => {
    const registry = createBrowserAutomationOwnerRegistry();

    const state = registry.getControllerState(view);

    expect(state).toEqual({
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      controller: 'none',
      controlEpoch: 0,
      interruptionSettling: false,
      uncertain: false,
    });
    expect(state.activeAutomationRequestId).toBeUndefined();
  });

  it('projects browser request metadata during a shared input flight', async () => {
    const registry = createBrowserAutomationOwnerRegistry();
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const pending = registry.getInputControl(view).execute({ requestedBy: 'agent',
      effect: async () => { await gate; return 'done'; }, classifyCompletion: () => 'known' });

    const state = registry.getControllerState(view, {
      controller: 'agent',
      activeAutomationRequestId: 'req_1',
    });

    expect(state.controller).toBe('agent');
    expect(state.activeAutomationRequestId).toBe('req_1');
    finish();
    await pending;
  });

  it('does not let stale browser request metadata claim control after the input owner is idle', () => {
    const registry = createBrowserAutomationOwnerRegistry();

    const state = registry.getControllerState(view, {
      controller: 'agent',
      activeAutomationRequestId: 'settled_request',
    });

    expect(state.controller).toBe('none');
    expect(state.activeAutomationRequestId).toBeUndefined();
  });

  it('keeps control state per view rather than per session', async () => {
    const registry = createBrowserAutomationOwnerRegistry();
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const pending = registry.getInputControl(view).execute({ requestedBy: 'agent',
      effect: async () => { await gate; return 'done'; }, classifyCompletion: () => 'known' });

    const first = registry.getControllerState(view, {
      controller: 'system',
      activeAutomationRequestId: 'req_1',
    });
    const second = registry.getControllerState(otherView);

    expect(first.controller).toBe('system');
    expect(second.controller).toBe('none');
    expect(second.viewId).toBe('view_2');
    finish();
    await pending;
  });

  it('exposes a control epoch that the status route can report', () => {
    const registry = createBrowserAutomationOwnerRegistry();

    expect(registry.getControlEpoch(view)).toBe(0);
    expect(registry.getControllerState(view).controlEpoch).toBe(registry.getControlEpoch(view));
  });

  it('advances the per-view control epoch when a present user takes over', () => {
    const registry = createBrowserAutomationOwnerRegistry();

    expect(registry.takeOver(view)).toBe(1);
    expect(registry.getControlEpoch(view)).toBe(1);
    expect(registry.getControlEpoch(otherView)).toBe(0);
  });
});
