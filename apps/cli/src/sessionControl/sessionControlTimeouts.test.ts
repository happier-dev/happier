import { afterEach, describe, expect, it } from 'vitest';

import { resolveSessionControlSocketAckTimeoutMs, resolveSessionControlSocketConnectTimeoutMs } from './sessionControlTimeouts';

describe('sessionControlTimeouts', () => {
  const prevConnect = process.env.HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS;
  const prevAck = process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;

  afterEach(() => {
    if (prevConnect === undefined) delete process.env.HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS;
    else process.env.HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS = prevConnect;

    if (prevAck === undefined) delete process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
    else process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = prevAck;
  });

  it('defaults socket connect timeout to 10s', () => {
    delete process.env.HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS;
    expect(resolveSessionControlSocketConnectTimeoutMs()).toBe(10_000);
  });

  it('defaults socket ack timeout to 10s', () => {
    delete process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
    expect(resolveSessionControlSocketAckTimeoutMs()).toBe(10_000);
  });

  it('reads connect timeout from env', () => {
    process.env.HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS = '1234';
    expect(resolveSessionControlSocketConnectTimeoutMs()).toBe(1234);
  });

  it('reads ack timeout from env', () => {
    process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = '2345';
    expect(resolveSessionControlSocketAckTimeoutMs()).toBe(2345);
  });

  it('rejects invalid env values and falls back', () => {
    process.env.HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS = '-1';
    process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = 'nope';
    expect(resolveSessionControlSocketConnectTimeoutMs()).toBe(10_000);
    expect(resolveSessionControlSocketAckTimeoutMs()).toBe(10_000);
  });
});

