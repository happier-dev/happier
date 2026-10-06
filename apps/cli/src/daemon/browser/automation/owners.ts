import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import type { BrowserAutomationControllerKindV1, BrowserAutomationControllerStateV1 } from '@happier-dev/protocol';

import { createSurfaceInputControl, type SurfaceInputControl } from '../../surfaces/inputControl';

export type BrowserAutomationViewRef = Readonly<{
  browserSessionId: string;
  viewId: string;
}>;

/**
 * Browser-only request metadata supplied by the service for the schema-shaped projection.
 * Admission, controller epochs and input drain belong to the shared surface input control.
 */
export type BrowserAutomationControlFacts = Readonly<{
  controller?: BrowserAutomationControllerKindV1;
  activeAutomationRequestId?: string | null;
}>;

/**
 * Browser view lookup and protocol projection around the same input owner used by native targets.
 * Consent remains the action-approval danger floor; no action lease or parallel admission state.
 */
export type BrowserAutomationOwnerRegistry = Readonly<{
  getControllerState(
    view: BrowserAutomationViewRef,
    facts?: BrowserAutomationControlFacts,
  ): BrowserAutomationControllerStateV1;
  getControlEpoch(view: BrowserAutomationViewRef): number;
  getInputControl(view: BrowserAutomationViewRef): SurfaceInputControl;
  takeOver(view: BrowserAutomationViewRef): number;
  handBack(view: BrowserAutomationViewRef): number;
  closeView(view: BrowserAutomationViewRef): void;
}>;

export function createBrowserAutomationOwnerRegistry(): BrowserAutomationOwnerRegistry {
  const entries = new Map<string, SurfaceInputControl>();

  function entryFor(view: BrowserAutomationViewRef): SurfaceInputControl {
    const key = browserViewKey(view);
    const existing = entries.get(key);
    if (existing) return existing;
    const created = createSurfaceInputControl();
    entries.set(key, created);
    return created;
  }

  return {
    getControllerState(view, facts) {
      const state = entryFor(view).getStatus();
      const activeAutomationRequestId = state.controller === 'idle' ? null : facts?.activeAutomationRequestId ?? null;
      return {
        browserSessionId: view.browserSessionId,
        viewId: view.viewId,
        controller: state.controller === 'idle' ? 'none'
          : state.controller === 'agent' && facts?.controller === 'system' ? 'system' : state.controller,
        controlEpoch: state.controlEpoch,
        interruptionSettling: state.stopping,
        uncertain: state.uncertain,
        ...(activeAutomationRequestId ? { activeAutomationRequestId } : {}),
      } satisfies BrowserAutomationControllerStateV1;
    },

    getControlEpoch(view) {
      return entryFor(view).getStatus().controlEpoch;
    },
    getInputControl: entryFor,

    takeOver(view) {
      const entry = entryFor(view);
      void entry.takeOver();
      return entry.getStatus().controlEpoch;
    },
    handBack(view) {
      const entry = entryFor(view);
      entry.handBack();
      return entry.getStatus().controlEpoch;
    },
    closeView(view) {
      const key = browserViewKey(view);
      void entries.get(key)?.close('view_closed');
      entries.delete(key);
    },
  };
}
