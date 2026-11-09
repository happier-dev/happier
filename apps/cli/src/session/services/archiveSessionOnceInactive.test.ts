import { EventEmitter } from 'node:events';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { archiveSessionOnceInactive } from './archiveSessionOnceInactive';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const boundary = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/api/session/sockets', () => ({
  createSessionScopedSocket: boundary.create,
  createSessionScopedSocketConnection: () => {
    const socket = boundary.create();
    return { socket, transport: createSocketTransportAdapter(socket) };
  },
}));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('keeps observing beyond the former archive cutoff without idle reads or writes, then archives on inactivity', async () => {
  vi.useFakeTimers();
  const socket = Object.assign(new EventEmitter(), { connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn() });
  boundary.create.mockReturnValue(socket);
  const sessionId = 'c' + 'd'.repeat(24);
  let active = true;
  const get = vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200, data: { session:
    createSessionRecordFixture({ id: sessionId, active, encryptionMode: 'plain', metadata: '{}' }) } }));
  const post = vi.spyOn(axios, 'post').mockImplementation(async () => active
    ? { status: 409, data: { error: 'session_active' } }
    : { status: 200, data: { success: true, archivedAt: 123 } });
  const result = archiveSessionOnceInactive({ token: 'token', sessionId });
  // Observe rejection immediately so the old cutoff produces the intended
  // assertion failure rather than an unhandled-rejection harness failure.
  let failure: unknown;
  void result.catch(error => { failure = error; });
  await vi.advanceTimersByTimeAsync(0);
  const reads = get.mock.calls.length;
  const writes = post.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_001);
  expect(failure).toBeUndefined();
  expect(get.mock.calls).toHaveLength(reads);
  expect(post.mock.calls).toHaveLength(writes);
  active = false;
  socket.emit('connect');
  await vi.advanceTimersByTimeAsync(0);
  await expect(result).resolves.toEqual({ archivedAt: 123 });
  expect(socket.eventNames()).toEqual([]);
});

it('closes inactive observation when its containing caller cancels', async () => {
  vi.useFakeTimers();
  const socket = Object.assign(new EventEmitter(), { connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn() });
  boundary.create.mockReturnValue(socket);
  const sessionId = 'c' + 'e'.repeat(24);
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session:
    createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain', metadata: '{}' }) } });
  const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 409, data: { error: 'session_active' } });
  const controller = new AbortController();
  const cancelled = new Error('Caller cancelled archive');
  let failure: unknown;
  const result = archiveSessionOnceInactive({ token: 'token', sessionId, signal: controller.signal })
    .catch(error => { failure = error; });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort(cancelled);
  await vi.advanceTimersByTimeAsync(0);
  expect(failure).toBe(cancelled);
  await result;
  expect(post).toHaveBeenCalledTimes(1);
  expect(socket.eventNames()).toEqual([]);
});
