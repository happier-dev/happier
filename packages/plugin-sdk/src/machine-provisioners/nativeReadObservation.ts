/** @moduleRealm any */
import type { MachineProvisionerObservationV1 } from '../machineProvisioners.js';

/** Native adapters prove exact presence or absence, including owned attachments.
 * A failed or incomplete read remains unknown; status codes alone are not proof. */
export type MachineProvisionerNativeReadOutcomeV1 = Readonly<
  ({ kind: 'present' } | { kind: 'absent' } | { kind: 'unknown' })
  & Omit<MachineProvisionerObservationV1, 'observedAt' | 'availability'>
>;

/** Translate native evidence once; the existing Action result schema admits the observation. */
export function observeMachineProvisionerNativeRead(
  observedAt: number,
  outcome: MachineProvisionerNativeReadOutcomeV1,
): MachineProvisionerObservationV1 {
  const { kind, ...facts } = outcome;
  return { observedAt, ...facts, availability: kind === 'unknown' ? 'unavailable' : kind };
}
