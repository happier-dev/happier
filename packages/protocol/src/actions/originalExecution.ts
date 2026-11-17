import type { ActionSpec } from './actionSpecs.js';

/** Whether an originating host delegates this Action to its admitted daemon. */
export function hasDeclaredActionDaemonIngress(
  spec: Pick<ActionSpec, 'originalExecution'>,
  host: NonNullable<NonNullable<ActionSpec['originalExecution']>['daemonIngressSurfaces']>[number],
): boolean {
  return spec.originalExecution?.daemonIngressSurfaces?.includes(host) === true;
}

/** Session authority does not require a publisher for an explicitly Home-owned read. */
export function isDaemonIndependentSessionRead(
  spec: Pick<ActionSpec, 'executionPlacement' | 'sideEffectClass' | 'originalExecution'>,
): boolean {
  return spec.executionPlacement === 'session' && spec.sideEffectClass === 'read'
    && spec.originalExecution?.daemonIngressSurfaces?.length === 0;
}
