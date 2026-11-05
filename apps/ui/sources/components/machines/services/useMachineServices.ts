import type { MachineServiceRowV1, ManagedServiceUnavailableReasonV1 } from '@happier-dev/protocol';

export { useMachineServicesList } from './useMachineServicesList';
export { useMachineServiceFirstLogRead, type MachineServiceFirstLogRead } from './useMachineServiceFirstLogRead';

export type MachineServicesReadError = Readonly<{
  code: string;
  message: string;
}>;
export type MachineServicesListState = Readonly<{
  /** The last answer that listed rows; kept while a later read is pending or fails. */
  rows: readonly MachineServiceRowV1[] | null;
  unavailable: ManagedServiceUnavailableReasonV1 | null;
  readAt: number | null;
  pending: boolean;
  error: MachineServicesReadError | null;
}>;
