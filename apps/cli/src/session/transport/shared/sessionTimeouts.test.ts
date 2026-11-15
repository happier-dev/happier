import { afterEach, describe, expect, it } from 'vitest';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';

import {
  resolveSessionControlSocketAckTimeoutMs,
  resolveSessionControlSocketConnectTimeoutMs,
  resolveSessionControlWaitIdleConfirmMs,
  resolveSessionControlStopPollIntervalMs,
  resolveSessionControlStopTimeoutMs,
  resolveSessionCriticalMetadataDrainTimeoutMs,
} from './sessionTimeouts';

describe('sessionControlTimeouts', () => {
  it('keeps concurrent hosted Session budgets independent of the host and stripped keys', async () => {
    const key = 'HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS';
    const previous = process.env[key];
    process.env[key] = '9876';
    try {
      const budgets = await Promise.all(['1234', '2345', undefined].map(value => runAddedHostedSession({
        environment: value === undefined ? {} : { [key]: value },
        workingDirectory: '/session', end: () => {},
      }, async () => {
        await Promise.resolve();
        return resolveSessionControlSocketConnectTimeoutMs();
      })));
      expect(budgets).toEqual([1234, 2345, 10_000]);
      expect(resolveSessionControlSocketConnectTimeoutMs()).toBe(9876);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  const prevConnect = process.env.HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS;
  const prevAck = process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
  const prevWaitIdleConfirm = process.env.HAPPIER_SESSION_WAIT_IDLE_CONFIRM_MS;
  const prevStopTimeout = process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS;
  const prevStopPollInterval = process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS;
  const prevCriticalMetadataDrain = process.env.HAPPIER_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS;

  afterEach(() => {
    if (prevConnect === undefined) delete process.env.HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS;
    else process.env.HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS = prevConnect;

    if (prevAck === undefined) delete process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
    else process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = prevAck;

    if (prevWaitIdleConfirm === undefined) delete process.env.HAPPIER_SESSION_WAIT_IDLE_CONFIRM_MS;
    else process.env.HAPPIER_SESSION_WAIT_IDLE_CONFIRM_MS = prevWaitIdleConfirm;

    if (prevStopTimeout === undefined) delete process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS;
    else process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS = prevStopTimeout;

    if (prevStopPollInterval === undefined) delete process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS;
    else process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS = prevStopPollInterval;

    if (prevCriticalMetadataDrain === undefined) delete process.env.HAPPIER_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS;
    else process.env.HAPPIER_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS = prevCriticalMetadataDrain;
  });

  it('defaults socket connect timeout to 10s', () => {
    delete process.env.HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS;
    expect(resolveSessionControlSocketConnectTimeoutMs()).toBe(10_000);
  });

  it('defaults socket ack timeout to 10s', () => {
    delete process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
    expect(resolveSessionControlSocketAckTimeoutMs()).toBe(10_000);
  });

  it('defaults session stop timeout to 10s', () => {
    delete process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS;
    expect(resolveSessionControlStopTimeoutMs()).toBe(10_000);
  });

  it('defaults session wait idle confirmation window to 250ms', () => {
    delete process.env.HAPPIER_SESSION_WAIT_IDLE_CONFIRM_MS;
    expect(resolveSessionControlWaitIdleConfirmMs()).toBe(250);
  });

  it('defaults session stop poll interval to 200ms', () => {
    delete process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS;
    expect(resolveSessionControlStopPollIntervalMs()).toBe(200);
  });

  it('defaults the critical metadata drain budget to 3s', () => {
    delete process.env.HAPPIER_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS;
    expect(resolveSessionCriticalMetadataDrainTimeoutMs()).toBe(3_000);
  });

  it('reads connect timeout from env', () => {
    process.env.HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS = '1234';
    expect(resolveSessionControlSocketConnectTimeoutMs()).toBe(1234);
  });

  it('reads ack timeout from env', () => {
    process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = '2345';
    expect(resolveSessionControlSocketAckTimeoutMs()).toBe(2345);
  });

  it('honors socket budgets longer than one minute', () => {
    process.env.HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS = '180000';
    process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = '180000';
    expect(resolveSessionControlSocketConnectTimeoutMs()).toBe(180_000);
    expect(resolveSessionControlSocketAckTimeoutMs()).toBe(180_000);
  });

  it('reads session wait idle confirmation window from env', () => {
    process.env.HAPPIER_SESSION_WAIT_IDLE_CONFIRM_MS = '345';
    expect(resolveSessionControlWaitIdleConfirmMs()).toBe(345);
  });

  it('reads session stop timeout from env', () => {
    process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS = '3456';
    expect(resolveSessionControlStopTimeoutMs()).toBe(3456);
  });

  it('reads session stop poll interval from env', () => {
    process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS = '12';
    expect(resolveSessionControlStopPollIntervalMs()).toBe(12);
  });

  it('reads the critical metadata drain budget from env', () => {
    process.env.HAPPIER_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS = '456';
    expect(resolveSessionCriticalMetadataDrainTimeoutMs()).toBe(456);
  });

  it('rejects invalid env values and falls back', () => {
    process.env.HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS = '-1';
    process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = 'nope';
    process.env.HAPPIER_SESSION_WAIT_IDLE_CONFIRM_MS = '0';
    process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS = '0';
    process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS = 'nan';
    process.env.HAPPIER_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS = 'nope';
    expect(resolveSessionControlSocketConnectTimeoutMs()).toBe(10_000);
    expect(resolveSessionControlSocketAckTimeoutMs()).toBe(10_000);
    expect(resolveSessionControlWaitIdleConfirmMs()).toBe(250);
    expect(resolveSessionControlStopTimeoutMs()).toBe(10_000);
    expect(resolveSessionControlStopPollIntervalMs()).toBe(200);
    expect(resolveSessionCriticalMetadataDrainTimeoutMs()).toBe(3_000);
  });
});
