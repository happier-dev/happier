import { z } from 'zod';

import { ACTION_ID_FAMILIES_V1, type RuntimeActionIdV1 } from './actionIds.js';
import { RUNTIME_SIDE_EFFECT_DANGER_ACTION_IDS } from './danger.js';

export const ActionSafetySchema = z.enum(['safe', 'danger']);
export type ActionSafety = z.infer<typeof ActionSafetySchema>;

export const RuntimeActionHostEffectClassSchema = z.enum([
  'readOnly',
  'mutating',
  'destructive',
  'recording',
  'externalNavigation',
  'diagnostic',
]);
export type RuntimeActionHostEffectClass = z.infer<typeof RuntimeActionHostEffectClassSchema>;

export type RuntimeActionSideEffectClass = 'none' | 'read' | 'write' | 'external' | 'danger';

const RUNTIME_EXTERNAL_SIDE_EFFECT_ACTION_IDS: ReadonlySet<RuntimeActionIdV1> = new Set<RuntimeActionIdV1>([
  'localServices.publicPreview.copyUrl',
  'devices.simulator.input.tap',
  'devices.simulator.input.swipe',
  'devices.simulator.input.text',
  'devices.simulator.input.key',
  'devices.simulator.input.button',
  'devices.simulator.input.orientation',
  'devices.simulator.input.pinch',
  'devices.simulator.input.rotate',
]);

const RUNTIME_DIAGNOSTIC_HOST_EFFECT_ACTION_IDS: ReadonlySet<RuntimeActionIdV1> = new Set<RuntimeActionIdV1>([
  ...ACTION_ID_FAMILIES_V1.browser_diagnostics,
  ...ACTION_ID_FAMILIES_V1.peer_mediation_observability,
]);

const RUNTIME_RECORDING_HOST_EFFECT_ACTION_IDS: ReadonlySet<RuntimeActionIdV1> = new Set<RuntimeActionIdV1>(
  ACTION_ID_FAMILIES_V1.browser_recording,
);

const RUNTIME_EXTERNAL_NAVIGATION_HOST_EFFECT_ACTION_IDS: ReadonlySet<RuntimeActionIdV1> = new Set<RuntimeActionIdV1>([
  'browser.navigate',
  'browser.reload',
  'browser.goBack',
  'browser.goForward',
  'browser.stop',
  'browser.automation.navigate',
  'browser.automation.reload',
  'browser.automation.goBack',
  'browser.automation.goForward',
  'localServices.launcher.openPreview',
  'localServices.preview.openOrCreate',
  'localServices.actions.openPreview',
]);

export function runtimeActionSideEffectClass(actionId: RuntimeActionIdV1): RuntimeActionSideEffectClass {
  if (RUNTIME_EXTERNAL_SIDE_EFFECT_ACTION_IDS.has(actionId)) return 'external';
  if (RUNTIME_SIDE_EFFECT_DANGER_ACTION_IDS.has(actionId)) return 'danger';
  if (
    actionId.endsWith('.snapshot')
    || actionId.endsWith('.status')
    || actionId.endsWith('.list')
    || actionId.includes('.listForView')
    || actionId.includes('.observability.')
    || actionId.includes('.queryElements')
    || actionId.includes('.waitFor')
    || actionId.includes('.get')
  ) {
    return 'read';
  }
  return 'write';
}

export function resolveRuntimeActionHostEffectClass(
  actionId: RuntimeActionIdV1,
): RuntimeActionHostEffectClass | null {
  const sideEffectClass = runtimeActionSideEffectClass(actionId);

  if (RUNTIME_RECORDING_HOST_EFFECT_ACTION_IDS.has(actionId)) {
    return 'recording';
  }

  if (RUNTIME_DIAGNOSTIC_HOST_EFFECT_ACTION_IDS.has(actionId)) {
    if (sideEffectClass === 'read' || sideEffectClass === 'none') return 'diagnostic';
    if (sideEffectClass === 'write') return 'mutating';
    if (sideEffectClass === 'danger') return 'destructive';
    return null;
  }

  if (RUNTIME_EXTERNAL_NAVIGATION_HOST_EFFECT_ACTION_IDS.has(actionId)) {
    if (sideEffectClass === 'external' || sideEffectClass === 'write') return 'externalNavigation';
    if (sideEffectClass === 'danger') return 'destructive';
    if (sideEffectClass === 'read' || sideEffectClass === 'none') return 'readOnly';
    return null;
  }

  if (sideEffectClass === 'none' || sideEffectClass === 'read') return 'readOnly';
  if (sideEffectClass === 'write') return 'mutating';
  if (sideEffectClass === 'danger') return 'destructive';
  return null;
}
