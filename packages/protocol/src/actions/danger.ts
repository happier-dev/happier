import type { RuntimeActionIdV1 } from './actionIds.js';

// Side-effect danger SSOT: the actions whose `sideEffectClass` is `'danger'` (the highest
// host-effect class). This is intentionally NARROWER than the SAFETY danger SSOT below: navigation
// + page-input + view-lifecycle browser verbs are dangerous for AGENT CONSENT purposes but keep
// their `external`/`externalNavigation`/`write` host-effect semantics (a navigate is not a
// `destructive` host effect). Do not widen this set to drive the consent floor - use the safety set.
export const RUNTIME_SIDE_EFFECT_DANGER_ACTION_IDS: ReadonlySet<RuntimeActionIdV1> = new Set<RuntimeActionIdV1>([
  'browser.diagnostics.eval',
  'browser.recording.start',
  'browser.recording.discard',
  'localServices.launcher.start',
  'localServices.publicPreview.create',
  'localServices.publicPreview.revoke',
  'localServices.actions.stopManaged',
  'localServices.actions.restartManaged',
  'localServices.actions.terminateDetected',
  'devices.simulator.input.tap',
  'devices.simulator.input.swipe',
  'devices.simulator.input.text',
  'devices.simulator.input.key',
  'devices.simulator.input.button',
  'devices.simulator.input.orientation',
  'devices.simulator.input.pinch',
  'devices.simulator.input.rotate',
]);

// SAFETY danger SSOT (single source of truth for the `safety` flag and the derived agent approval
// floor in `actionApprovalPolicy.ts`). It is the side-effect danger set UNIONED with the
// mutating/navigating browser verbs that must reach human consent on the `agent` surface
// (the agent-browser consent hole - CON-1/CON-2). Read-only browser verbs
// (`status`/`snapshot`/`semanticSnapshot`/`queryElements`/`waitFor`/`timeline.get`/`cancelActive`/
// `view.focus`/`target.set`/`elementPicker.*`) stay `safe` and agent-allowed without consent.
export const RUNTIME_DANGER_ACTION_IDS: ReadonlySet<RuntimeActionIdV1> = new Set<RuntimeActionIdV1>([
  ...RUNTIME_SIDE_EFFECT_DANGER_ACTION_IDS,
  'browser.navigate',
  'browser.reload',
  'browser.goBack',
  'browser.goForward',
  'browser.stop',
  'browser.session.create',
  'browser.session.close',
  'browser.view.open',
  'browser.view.close',
  'browser.automation.navigate',
  'browser.automation.reload',
  'browser.automation.goBack',
  'browser.automation.goForward',
  'browser.automation.click',
  'browser.automation.tap',
  'browser.automation.type',
  'browser.automation.press',
  'browser.automation.scroll',
  'browser.automation.hover',
  'browser.automation.focus',
  'browser.automation.select',
  'browser.automation.setValue',
]);
