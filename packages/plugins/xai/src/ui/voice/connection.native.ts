import {
  createXaiWebSocketDriver,
  type CreateXaiWebSocket,
  type XaiWebSocketDriverInput,
  type XaiWebSocketLike,
} from './connection.js';

type ReactNativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: Readonly<{ headers?: Readonly<Record<string, string>> }>,
) => XaiWebSocketLike;

const createNativeWebSocket: CreateXaiWebSocket = (url, protocols, headers) => {
  if (typeof WebSocket !== 'function') throw new Error('provider_response_invalid');
  // React Native's WebSocket is the external boundary that accepts request
  // headers in its third constructor argument. Keep that platform detail out
  // of the shared provider protocol and lifecycle.
  const NativeWebSocket = WebSocket as unknown as ReactNativeWebSocketConstructor;
  return new NativeWebSocket(url, protocols, headers ? { headers } : undefined);
};

export function createXaiNativeWebSocketDriver(input: XaiWebSocketDriverInput) {
  return createXaiWebSocketDriver({
    ...input,
    createWebSocket: input.createWebSocket ?? createNativeWebSocket,
  });
}
