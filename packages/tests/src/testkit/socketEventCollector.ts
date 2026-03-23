function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? error);
  }
  return String(error);
}

export type UpdateEvent = {
  id?: string;
  seq?: number;
  createdAt?: number;
  body?: { t?: string; [k: string]: unknown };
  [k: string]: unknown;
};

export type EphemeralEvent = { type?: string; [k: string]: unknown };

export type CapturedEvent =
  | { at: number; kind: 'update'; payload: UpdateEvent }
  | { at: number; kind: 'ephemeral'; payload: EphemeralEvent }
  | { at: number; kind: 'connect' }
  | { at: number; kind: 'disconnect'; reason?: string }
  | { at: number; kind: 'connect_error'; message: string };

type SocketEventSource = {
  on: (event: string, listener: (...args: any[]) => void) => unknown;
};

export class SocketEventCollector {
  private readonly events: CapturedEvent[] = [];

  recordConnect(): void {
    this.events.push({ at: Date.now(), kind: 'connect' });
  }

  recordDisconnect(reason: string | undefined): void {
    this.events.push({ at: Date.now(), kind: 'disconnect', reason });
  }

  recordConnectError(error: unknown): void {
    this.events.push({ at: Date.now(), kind: 'connect_error', message: describeError(error) });
  }

  recordUpdate(payload: unknown): void {
    this.events.push({ at: Date.now(), kind: 'update', payload: (payload ?? {}) as UpdateEvent });
  }

  recordEphemeral(payload: unknown): void {
    this.events.push({ at: Date.now(), kind: 'ephemeral', payload: (payload ?? {}) as EphemeralEvent });
  }

  getEvents(): CapturedEvent[] {
    return [...this.events];
  }
}

export function attachSocketEventCollector(
  socket: SocketEventSource,
  collector: SocketEventCollector = new SocketEventCollector(),
): SocketEventCollector {
  socket.on('connect', () => collector.recordConnect());
  socket.on('disconnect', (reason?: string) => collector.recordDisconnect(reason));
  socket.on('connect_error', (error: unknown) => collector.recordConnectError(error));
  socket.on('update', (payload: unknown) => collector.recordUpdate(payload));
  socket.on('ephemeral', (payload: unknown) => collector.recordEphemeral(payload));
  return collector;
}
