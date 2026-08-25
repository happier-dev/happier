import {
  browserViewKey,
  type BrowserAutomationControllerKindV1,
  type BrowserAutomationControllerStateV1,
} from '@happier-dev/protocol';

export type BrowserAutomationViewRef = Readonly<{
  browserSessionId: string;
  viewId: string;
}>;

/**
 * The live control facts the daemon service owns for a view. The registry owns the control epoch
 * and the schema-shaped projection; the service owns single-flight, so it passes its own active
 * request in rather than the registry keeping a second copy of it.
 */
export type BrowserAutomationControlFacts = Readonly<{
  controller?: BrowserAutomationControllerKindV1;
  activeAutomationRequestId?: string | null;
}>;

/**
 * Per-view control epoch and controller projection backing `browser.automation.status`.
 *
 * There is no action lease. One existed until 2026-08-23 and no code path could mint it, which
 * made every mutating automation verb undispatchable (G3/OE-1). Arbitration is the service's
 * single-flight `activeAutomationRequestId`; consent is the action-approval danger floor; human
 * takeover bumps the control epoch and cancels the in-flight agent action.
 */
export type BrowserAutomationOwnerRegistry = Readonly<{
  getControllerState(
    view: BrowserAutomationViewRef,
    facts?: BrowserAutomationControlFacts,
  ): BrowserAutomationControllerStateV1;
  getControlEpoch(view: BrowserAutomationViewRef): number;
  takeOver(view: BrowserAutomationViewRef): number;
}>;

type ViewEntry = {
  controlEpoch: number;
};

export function createBrowserAutomationOwnerRegistry(): BrowserAutomationOwnerRegistry {
  const entries = new Map<string, ViewEntry>();

  function entryFor(view: BrowserAutomationViewRef): ViewEntry {
    const key = browserViewKey(view);
    const existing = entries.get(key);
    if (existing) return existing;
    const created: ViewEntry = { controlEpoch: 0 };
    entries.set(key, created);
    return created;
  }

  return {
    getControllerState(view, facts) {
      const entry = entryFor(view);
      const activeAutomationRequestId = facts?.activeAutomationRequestId ?? null;
      return {
        browserSessionId: view.browserSessionId,
        viewId: view.viewId,
        controller: activeAutomationRequestId ? facts?.controller ?? 'agent' : 'none',
        controlEpoch: entry.controlEpoch,
        ...(activeAutomationRequestId ? { activeAutomationRequestId } : {}),
      } satisfies BrowserAutomationControllerStateV1;
    },

    getControlEpoch(view) {
      return entryFor(view).controlEpoch;
    },

    takeOver(view) {
      const entry = entryFor(view);
      entry.controlEpoch += 1;
      return entry.controlEpoch;
    },
  };
}
