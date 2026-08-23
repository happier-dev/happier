import { describe, expect, it } from 'vitest';

import { createBrowserAutomationOwnerRegistry } from './owners';

const view = { browserSessionId: 'browser_session_1', viewId: 'view_1' } as const;
const otherView = { browserSessionId: 'browser_session_1', viewId: 'view_2' } as const;

describe('browser automation owner registry', () => {
  it('reports an idle view as uncontrolled with no active request', () => {
    const registry = createBrowserAutomationOwnerRegistry();

    const state = registry.getControllerState(view);

    expect(state).toEqual({
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      controller: 'none',
      controlEpoch: 0,
    });
    expect(state.activeAutomationRequestId).toBeUndefined();
  });

  it('projects the service-owned active request as the controller', () => {
    const registry = createBrowserAutomationOwnerRegistry();

    const state = registry.getControllerState(view, {
      controller: 'agent',
      activeAutomationRequestId: 'req_1',
    });

    expect(state.controller).toBe('agent');
    expect(state.activeAutomationRequestId).toBe('req_1');
  });

  it('reports no controller when the service reports no active request, whatever kind is passed', () => {
    const registry = createBrowserAutomationOwnerRegistry();

    // The active request is the single source of "someone is driving". A stale controller kind
    // cannot resurrect a finished action into a busy view.
    const state = registry.getControllerState(view, {
      controller: 'agent',
      activeAutomationRequestId: null,
    });

    expect(state.controller).toBe('none');
    expect(state.activeAutomationRequestId).toBeUndefined();
  });

  it('keeps control state per view rather than per session', () => {
    const registry = createBrowserAutomationOwnerRegistry();

    const first = registry.getControllerState(view, {
      controller: 'system',
      activeAutomationRequestId: 'req_1',
    });
    const second = registry.getControllerState(otherView);

    expect(first.controller).toBe('system');
    expect(second.controller).toBe('none');
    expect(second.viewId).toBe('view_2');
  });

  it('exposes a control epoch that the status route can report', () => {
    const registry = createBrowserAutomationOwnerRegistry();

    expect(registry.getControlEpoch(view)).toBe(0);
    expect(registry.getControllerState(view).controlEpoch).toBe(registry.getControlEpoch(view));
  });

  it('advances the per-view control epoch when a present user takes over', () => {
    const registry = createBrowserAutomationOwnerRegistry() as ReturnType<typeof createBrowserAutomationOwnerRegistry> & Readonly<{
      takeOver(view: typeof view): number;
    }>;

    expect(registry.takeOver(view)).toBe(1);
    expect(registry.getControlEpoch(view)).toBe(1);
    expect(registry.getControlEpoch(otherView)).toBe(0);
  });
});
