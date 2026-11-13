import type { JsonValue } from '@happier-dev/plugin-sdk';

export type PackedChannelProviderLoopback = Readonly<{
  origin: string;
  socketUrl: string;
  pairingCode: string;
  caCertificatePath: string;
  observerSocketCount(): number;
  receivedFrameKinds(): readonly string[];
  sendObservation(): void;
  sendProviderEvent(event: JsonValue): void;
  sendHistoryGap(): void;
  closeObserverSockets(): void;
  waitForObserverSocketCount(
    expected: number,
    context: string,
  ): Promise<void>;
  stop(): Promise<void>;
}>;

export declare function startPackedChannelProviderLoopback(): Promise<
  PackedChannelProviderLoopback
>;
