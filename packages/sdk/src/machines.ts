import { ExternalActionMachineBootstrapListV1Schema } from '@happier-dev/protocol/actions';

import { HappierTransportError } from './errors.js';

export type HappierMachine = Readonly<{
  id: string;
  active: boolean;
  revokedAt: number | null;
  replacedByMachineId: string | null;
}>;

export type MachineListOptions = Readonly<{
  signal?: AbortSignal;
}>;

export function parseMachineListResponse(value: unknown): readonly HappierMachine[] {
  const parsed = ExternalActionMachineBootstrapListV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new HappierTransportError('The Happier machine API returned an invalid response.');
  }
  return Object.freeze(parsed.data.map((row) => Object.freeze(row)));
}
