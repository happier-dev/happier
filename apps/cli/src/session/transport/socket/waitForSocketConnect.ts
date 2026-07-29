import type { Socket } from 'socket.io-client';

export async function waitForSocketConnect(socket: Socket, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onConnect = () => settle(resolve);
    const onConnectError = (err: unknown) => settle(() => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    const timer = setTimeout(() => {
      settle(() => reject(new Error('Socket connect timeout')));
    }, timeoutMs);
    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
  });
}
