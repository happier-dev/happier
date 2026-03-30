import type {
  MachineTransferStrategy,
  MachineTransferUnavailableReasonCode,
} from '@happier-dev/transfers';

export type { MachineTransferStrategy };

export type MachineTransferNegotiationResult =
  | Readonly<{ kind: 'selected'; strategy: MachineTransferStrategy }>
  | Readonly<{
      kind: 'unavailable';
      reasonCode: MachineTransferUnavailableReasonCode;
    }>;
