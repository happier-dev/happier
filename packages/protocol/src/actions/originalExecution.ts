import type { ActionSpec } from './actionSpecs.js';

/** Whether an originating host delegates this Action to its admitted daemon. */
export function hasDeclaredActionDaemonIngress(
  spec: Pick<ActionSpec, 'originalExecution'>,
  host: NonNullable<NonNullable<ActionSpec['originalExecution']>['daemonIngressSurfaces']>[number],
): boolean {
  return spec.originalExecution?.daemonIngressSurfaces?.includes(host) === true;
}
