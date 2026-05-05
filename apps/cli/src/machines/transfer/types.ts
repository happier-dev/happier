import type {
  MachineTransferStrategy,
  MachineTransferUnavailableReasonCode,
} from '@happier-dev/peer-mediation';

export type { MachineTransferStrategy };

export type MachineTransferNegotiationResult =
  | Readonly<{ kind: 'selected'; strategy: MachineTransferStrategy }>
  | Readonly<{
      kind: 'unavailable';
      reasonCode: MachineTransferUnavailableReasonCode;
    }>;
