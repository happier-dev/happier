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
  acquireConfidentiality(view: BrowserAutomationViewRef): Promise<void>;
  isObservationHeld(view: BrowserAutomationViewRef): boolean;
  setConfidentialitySafetyCheck(view: BrowserAutomationViewRef, check: () => Promise<boolean>): void;
  tryReleaseConfidentiality(view: BrowserAutomationViewRef): Promise<boolean>;
  takeOver(view: BrowserAutomationViewRef): number;
  handBack(view: BrowserAutomationViewRef): number;
  closeView(view: BrowserAutomationViewRef, facts?: Readonly<{ sourceDestroyed?: boolean }>): void;
}>;

export function createBrowserAutomationOwnerRegistry(): BrowserAutomationOwnerRegistry {
  const entries = new Map<string, { control: SurfaceInputControl; safetyCheck?: () => Promise<boolean> }>();

  function entryFor(view: BrowserAutomationViewRef): SurfaceInputControl {
    const key = browserViewKey(view);
    const existing = entries.get(key);
    if (existing) return existing.control;
    const created = createSurfaceInputControl();
    entries.set(key, { control: created });
    return created;
  }

  return {
    getControllerState(view, facts) {
      const control = entryFor(view);
      const state = control.getStatus();
      const activeAutomationRequestId = state.controller === 'idle' ? null : facts?.activeAutomationRequestId ?? null;
      return {
        browserSessionId: view.browserSessionId,
        viewId: view.viewId,
        controller: state.controller === 'idle' ? 'none'
          : state.controller === 'agent' && facts?.controller === 'system' ? 'system' : state.controller,
        controlEpoch: state.controlEpoch,
        interruptionSettling: state.stopping,
        uncertain: state.uncertain,
        ...(control.hasConfidentialityHold() ? { confidentialityHeld: true } : {}),
        ...(activeAutomationRequestId ? { activeAutomationRequestId } : {}),
      } satisfies BrowserAutomationControllerStateV1;
    },

    getControlEpoch(view) {
      return entryFor(view).getStatus().controlEpoch;
    },
    getInputControl: entryFor,
    acquireConfidentiality: view => entryFor(view).beginConfidentialityHold(),
    isObservationHeld: view => entryFor(view).isObservationHeld(),
    setConfidentialitySafetyCheck(view, check) {
      entryFor(view);
      const entry = entries.get(browserViewKey(view));
      if (entry) {
        // A later known nondelivery cannot erase an older delivered/unknown secret's hold.
        const previous = entry.safetyCheck;
        entry.safetyCheck = previous ? async () => await previous() && await check() : check;
      }
    },
    async tryReleaseConfidentiality(view) {
      const entry = entries.get(browserViewKey(view));
      if (!entry?.control.isObservationHeld() || !entry.safetyCheck) return false;
      const check = entry.safetyCheck;
      const safe = await check().catch(() => false);
      if (!safe || entries.get(browserViewKey(view)) !== entry || entry.safetyCheck !== check) return false;
      const cleared = entry.control.clearConfidentialityHold();
      if (cleared) {
        delete entry.safetyCheck;
      }
      return cleared;
    },

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
    closeView(view, facts) {
      const key = browserViewKey(view);
      const entry = entries.get(key);
      const held = entry?.control.hasConfidentialityHold() ?? false;
      void entry?.control.close('view_closed');
      // Loss of a binding/connection does not prove that its confidential page disappeared.
      if (held && facts?.sourceDestroyed !== true) return;
      entries.delete(key);
    },
  };
}
