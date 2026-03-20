import type { TransferEndpointCandidate } from '@happier-dev/protocol';

import type { MachineTransferStrategy } from './types';
import type { TransferPayloadSource } from './transferPayloadSource';

export type ResolvedTypedTransferPayload<TPayload, TUnavailable> =
  | Readonly<{
      kind: 'resolved';
      actualTransportStrategy: MachineTransferStrategy;
      payload: TPayload;
    }>
  | Readonly<{
      kind: 'unavailable';
      response: TUnavailable;
    }>;

export type TypedTransferPayloadDelivery = Readonly<{
  endpointCandidates: readonly TransferEndpointCandidate[];
}>;

export async function resolveRequestedTypedTransferPayload<TPayload, TUnavailable>(params: Readonly<{
  transferId: string;
  sourceMachineId: string;
  negotiatedTransportStrategy: MachineTransferStrategy;
  endpointCandidates: readonly TransferEndpointCandidate[];
  allowServerRoutedFallback: boolean;
  storedPayload?: TPayload | null;
  requestDirectPeerPayload?: ((input: Readonly<{
    transferId: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
  }>) => Promise<TPayload>) | null;
  requestServerRoutedPayload?: ((input: Readonly<{
    transferId: string;
    sourceMachineId: string;
  }>) => Promise<TPayload>) | null;
  isDirectPeerProtocolError?: ((error: unknown) => boolean) | null;
  unavailableResponse: () => TUnavailable;
  now?: () => number;
}>): Promise<ResolvedTypedTransferPayload<TPayload, TUnavailable>> {
  let actualTransportStrategy = params.negotiatedTransportStrategy;
  const now = params.now ?? Date.now;

  if (params.storedPayload) {
    return {
      kind: 'resolved',
      actualTransportStrategy,
      payload: params.storedPayload,
    };
  }

  if (
    params.negotiatedTransportStrategy === 'server_routed_stream'
    && params.requestServerRoutedPayload
  ) {
    return {
      kind: 'resolved',
      actualTransportStrategy,
      payload: await params.requestServerRoutedPayload({
        transferId: params.transferId,
        sourceMachineId: params.sourceMachineId,
      }),
    };
  }

  if (params.negotiatedTransportStrategy !== 'direct_peer') {
    return { kind: 'unavailable', response: params.unavailableResponse() };
  }

  const endpointCandidates = params.endpointCandidates.filter((candidate) => candidate.expiresAt >= now());
  if (endpointCandidates.length === 0) {
    if (!params.allowServerRoutedFallback || !params.requestServerRoutedPayload) {
      return { kind: 'unavailable', response: params.unavailableResponse() };
    }
    actualTransportStrategy = 'server_routed_stream';
    return {
      kind: 'resolved',
      actualTransportStrategy,
      payload: await params.requestServerRoutedPayload({
        transferId: params.transferId,
        sourceMachineId: params.sourceMachineId,
      }),
    };
  }

  try {
    const requestDirectPeerPayload = params.requestDirectPeerPayload;
    if (!requestDirectPeerPayload) {
      throw new Error(`Direct peer transfer is unavailable for ${params.transferId}`);
    }
    return {
      kind: 'resolved',
      actualTransportStrategy,
      payload: await requestDirectPeerPayload({
        transferId: params.transferId,
        endpointCandidates,
      }),
    };
  } catch (error) {
    if (params.isDirectPeerProtocolError?.(error)) {
      throw error;
    }
    if (!params.allowServerRoutedFallback || !params.requestServerRoutedPayload) {
      return { kind: 'unavailable', response: params.unavailableResponse() };
    }
    actualTransportStrategy = 'server_routed_stream';
    return {
      kind: 'resolved',
      actualTransportStrategy,
      payload: await params.requestServerRoutedPayload({
        transferId: params.transferId,
        sourceMachineId: params.sourceMachineId,
      }),
    };
  }
}

export function resolveTypedTransferPayloadDelivery<TPayload>(params: Readonly<{
  transferId: string;
  negotiatedTransportStrategy: MachineTransferStrategy;
  payload: TPayload;
  payloadSource?: TransferPayloadSource;
  directPeerTransfer?: Readonly<{
    publishTransfer: (input: Readonly<{
      transferId: string;
      payload: TPayload;
      payloadSource?: TransferPayloadSource;
    }>) => readonly TransferEndpointCandidate[];
  }>;
}>): TypedTransferPayloadDelivery {
  const endpointCandidates =
    params.negotiatedTransportStrategy === 'direct_peer' && params.directPeerTransfer
      ? [...params.directPeerTransfer.publishTransfer({
        transferId: params.transferId,
        payload: params.payload,
        ...(params.payloadSource ? { payloadSource: params.payloadSource } : {}),
      })]
      : [];
  return {
    endpointCandidates,
  };
}
