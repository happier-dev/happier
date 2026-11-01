import { EventEmitter } from 'node:events';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import {
  decryptStoredSessionPayload,
  encryptStoredSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { reconcileRecoveredSessionMachineControl } from './reconcileRecoveredSessionMachineControl';

const network = vi.hoisted(() => ({
  update: (_payload: { expectedVersion: number; metadata: string }): unknown => undefined,
}));
vi.mock('@/api/session/sockets', () => ({
  // Only the Socket.IO transport is replaced; metadata CAS, encryption and access binding stay real.
  createSessionScopedSocket: () => {
    const events = new EventEmitter();
    return {
      connected: true,
      on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
      off: (event: string, listener: (...args: unknown[]) => void) => events.off(event, listener),
      connect: () => events.emit('connect'),
      emit: (_event: string, payload: { expectedVersion: number; metadata: string }, ack: (value: unknown) => void) => ack(network.update(payload)),
      disconnect: () => undefined,
      close: () => undefined,
    };
  },
}));

afterEach(() => vi.restoreAllMocks());

describe('recovered runner machine control', () => {
  it.each(['plain', 'e2ee'] as const)('repairs %s routing without retiring the live publisher identity', async (mode) => {
    const credentials: Credentials = mode === 'plain'
      ? { token: 'plain-token', encryption: null }
      : { token: 'encrypted-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } };
    const ctx = resolveSessionEncryptionContextFromCredentials(credentials, { encryptionMode: mode });
    const initial = {
      machineId: 'old-machine', hostPid: 1234, host: 'old-host', path: '/workspace/repo',
      claudeSessionId: 'provider-session', summary: { text: 'Keep this' },
      sessionWorkspaceLocationV1: { v: 1, machineId: 'old-machine', agentPath: '/sandbox/repo', machinePath: '/workspace/repo' },
    };
    let stored = createSessionRecordFixture({
      id: 'recovered-' + mode, encryptionMode: mode, dataEncryptionKey: null, metadataVersion: 3,
      metadata: encryptStoredSessionPayload({ mode, ctx, payload: initial }),
    });
    let binding = false;
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).includes('/access-keys/')) return { status: 200, data: { accessKey: binding ? { id: 'binding' } : null } };
      return { status: 200, data: { session: stored } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url) => {
      expect(String(url)).toContain('/v1/access-keys/');
      binding = true;
      return { status: 200, data: {} };
    });
    network.update = (payload) => {
      expect(binding).toBe(true);
      expect(payload.expectedVersion).toBe(stored.metadataVersion);
      stored = { ...stored, metadata: payload.metadata, metadataVersion: stored.metadataVersion + 1 };
      return { result: 'success', version: stored.metadataVersion, metadata: stored.metadata };
    };
    const params = { credentials, sessionId: stored.id, machineId: 'new-machine', runnerPid: 1234 };
    await reconcileRecoveredSessionMachineControl(params);

    expect(binding).toBe(true);
    expect(decryptStoredSessionPayload({ mode, ctx, value: stored.metadata! })).toEqual({
      ...initial, machineId: 'new-machine',
      sessionWorkspaceLocationV1: { ...initial.sessionWorkspaceLocationV1, machineId: 'new-machine' },
    });
    const version = stored.metadataVersion;
    await reconcileRecoveredSessionMachineControl(params);
    expect(stored.metadataVersion).toBe(version);
  });
  it('does not reclaim metadata already published by another runner', async () => {
    const credentials: Credentials = { token: 'other-runner-token', encryption: null };
    const initial = { machineId: 'handoff-target', hostPid: 5678, path: '/other/repo' };
    const stored = createSessionRecordFixture({
      id: 'already-moved', encryptionMode: 'plain', dataEncryptionKey: null,
      metadataVersion: 10, metadata: JSON.stringify(initial),
    });
    vi.spyOn(axios, 'get').mockImplementation(async (url) => ({
      status: 200, data: String(url).includes('/access-keys/')
        ? { accessKey: { id: 'bound' } } : { session: stored },
    }));
    network.update = () => { throw new Error('Must preserve the current runner metadata'); };
    await reconcileRecoveredSessionMachineControl({
      credentials, sessionId: stored.id, machineId: 'new-machine', runnerPid: 1234,
    });
    expect(JSON.parse(stored.metadata!)).toEqual(initial);
    expect(stored.metadataVersion).toBe(10);
  });

});
