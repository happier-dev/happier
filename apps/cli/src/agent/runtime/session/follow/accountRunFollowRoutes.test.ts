import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createAccountRunFollowRoutes } from './accountRunFollowRoutes';
import type { RunFollowAvailability } from '@/api/client/accountEncryptionCurrentnessObservation';
import { SessionFollowRunOccurrenceRoutesRequestV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';

afterEach(() => vi.restoreAllMocks());

it('keeps legacy fieldless holds broad and retains pending full-recovery diagnostics without changing the route body', async () => {
  const source = { kind: 'execution_run' as const, sessionId: 'legacy-session', runId: 'legacy-run' };
  const request = { v: 1 as const, source };
  const refusal = { status: 409, data: { ok: false, v: 1, error: 'source_unavailable' } };
  let finish!: (response: typeof refusal) => void;
  const waiting = new Promise<typeof refusal>(resolve => { finish = resolve; });
  const posts = vi.spyOn(axios, 'post').mockImplementationOnce(() => waiting).mockResolvedValue(refusal);
  const routes = createAccountRunFollowRoutes({ credentials: { token: 'boundary-token', encryption: null },
    serverHttpBaseUrl: 'https://run-frontier.test', signal: new AbortController().signal, isCurrent: async () => true });
  try {
    const first = routes.read(request);
    await vi.waitFor(() => expect(posts).toHaveBeenCalledTimes(1));
    const fullRecovery = routes.available({ kind: 'reconnected' }, 'full_recovery');
    finish(refusal);
    expect(await first).toBeNull();
    await fullRecovery;
    expect(await routes.read(request)).toBeNull();
    expect(posts.mock.calls[1]?.[2]?.params).toEqual({ includeTargetMachineId: 'true', releaseReason: 'full_recovery' });
    for (let index = 0; index < 100; index++) expect(await routes.read(request)).toBeNull();
    expect(posts).toHaveBeenCalledTimes(2);
    await routes.available({ kind: 'machine', machineId: 'any-machine' });
    expect(await routes.read(request)).toBeNull();
    expect(posts).toHaveBeenCalledTimes(3);
    expect(posts.mock.calls.map(([, body]) => body)).toEqual([request, request, request]);
    expect(posts.mock.calls[2]?.[2]?.params).toEqual({ includeTargetMachineId: 'true', releaseReason: 'legacy_broad' });
    // The diagnostic is consumed by that transport attempt, not source identity
    // or a later exact publication.
    await routes.available(source);
    expect(await routes.read(request)).toBeNull();
    expect(posts.mock.calls[3]?.[2]?.params).toEqual({ includeTargetMachineId: 'true', releaseReason: 'exact_run' });
  } finally { finish?.(refusal); routes.dispose(); }
});

it.each([false, true])('matches the retained Session Run target after a %s pending read and ignores another Machine', async pending => {
  const source = { kind: 'execution_run' as const, sessionId: 'targeted-session', runId: 'targeted-run' };
  const request = { v: 1 as const, source };
  const secondRequest = { v: 1 as const, source: { ...source, runId: 'second-targeted-run' } };
  const otherTarget = { v: 1 as const, source: { ...source, sessionId: 'other-session', runId: 'other-target-run' } };
  let push: ((change: RunFollowAvailability) => void) | undefined;
  let finish!: (response: { status: number; data: unknown }) => void;
  const waiting = new Promise<{ status: number; data: unknown }>(resolve => { finish = resolve; });
  const refusal = { status: 409, data: { ok: false, v: 1, error: 'source_unavailable', targetMachineId: 'machine-a' } };
  const posts = vi.spyOn(axios, 'post').mockImplementationOnce(() => pending ? waiting : Promise.resolve(refusal))
    .mockImplementation(async (_url, body) => {
      const parsed = SessionFollowRunOccurrenceRoutesRequestV1Schema.parse(body);
      const run = 'source' in parsed ? parsed.source : parsed.original.source;
      return { ...refusal, data: { ...refusal.data, targetMachineId: run.runId === otherTarget.source.runId ? 'machine-b' : 'machine-a' } };
    });
  const routes = createAccountRunFollowRoutes({ credentials: { token: 'boundary-token', encryption: null },
    serverHttpBaseUrl: 'https://run-frontier.test', signal: new AbortController().signal, isCurrent: async () => true,
    subscribeAvailability: listener => { push = listener; return () => {}; } });
  routes.bindDispatch(async (next, context) => { await routes.read(next, context); });
  try {
    const first = routes.read(request);
    await vi.waitFor(() => expect(posts).toHaveBeenCalledTimes(1));
    if (pending) {
      push?.({ kind: 'machine', machineId: 'machine-b' });
      finish(refusal);
    }
    await first;
    if (!pending) {
      await routes.read(secondRequest);
      await routes.read(secondRequest, { receiverSessionId: 'receiver' });
      await routes.read(otherTarget);
    }
    await routes.available({ kind: 'machine', machineId: 'machine-b' });
    if (!pending) {
      await routes.read(otherTarget);
      expect(posts.mock.calls.at(-1)?.[2]?.params).toEqual({ includeTargetMachineId: 'true', releaseReason: 'target_machine' });
    }
    const beforeMachineA = pending ? 1 : 4;
    for (let index = 0; index < 100; index++) {
      expect(await routes.read(request)).toBeNull();
      if (!pending) expect(await routes.read(secondRequest)).toBeNull();
    }
    expect(posts, 'Machine B cannot release either held Machine A Run').toHaveBeenCalledTimes(beforeMachineA);
    push?.({ kind: 'machine', machineId: 'machine-a' });
    const afterMachineA = beforeMachineA + (pending ? 1 : 2);
    await vi.waitFor(() => expect(posts).toHaveBeenCalledTimes(afterMachineA));
    expect(posts.mock.calls.slice(beforeMachineA).map(([, body]) => body)).toEqual(expect.arrayContaining(pending ? [request] : [request, secondRequest]));
    for (const [, , options] of posts.mock.calls.slice(beforeMachineA)) expect(options?.params)
      .toEqual({ includeTargetMachineId: 'true', releaseReason: 'target_machine' });
    await routes.available({ kind: 'reconnected' });
    await routes.read(request);
    expect(posts.mock.calls[afterMachineA]?.[2]?.params).toEqual({ includeTargetMachineId: 'true', releaseReason: 'account_reconnect' });
    await routes.available({ kind: 'reconnected' }, 'full_recovery');
    await routes.read(request);
    expect(posts.mock.calls[afterMachineA + 1]?.[2]?.params).toEqual({ includeTargetMachineId: 'true', releaseReason: 'full_recovery' });
  } finally { finish?.(refusal); routes.dispose(); }
});

it('holds a Discussion source after an exact-message refusal and resumes it once on source availability', async () => {
  const source = { kind: 'discussion' as const, discussionId: 'discussion' };
  const routes = createAccountRunFollowRoutes({ credentials: { token: 'boundary-token', encryption: null },
    serverHttpBaseUrl: 'https://discussion.test', signal: new AbortController().signal, isCurrent: async () => true });
  const ready = { source, messageId: 'ready-message', seq: 2, event: { kind: 'person_wrote' },
    personal: { policy: { preset: 'important' }, alreadyRepresented: true } };
  const posts = vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 409,
    data: { ok: false, v: 1, error: 'source_unavailable' } }).mockResolvedValue({ status: 200, data: { ok: true, v: 1, discussion: ready } });
  try {
    const concurrent = await Promise.all([routes.readDiscussion({ v: 1, source, messageId: 'previous-message' }),
      ...Array.from({ length: 100 }, () => routes.readDiscussion({ v: 1, source }))]);
    expect(concurrent).toEqual(Array.from({ length: 101 }, () => null));
    for (let index = 0; index < 100; index++) expect(await routes.readDiscussion({ v: 1, source })).toBeNull();
    expect(posts).toHaveBeenCalledTimes(1);
    await routes.available({ ...source, discussionId: 'unrelated-discussion' });
    expect(await routes.readDiscussion({ v: 1, source })).toBeNull();
    await routes.available(source);
    expect(await routes.readDiscussion({ v: 1, source })).toEqual(ready);
    expect(posts).toHaveBeenCalledTimes(2);
  } finally { routes.dispose(); }
});

it('holds unavailable Run demand across callers, joins concurrent reads and consumes one real availability change', async () => {
  const source = { kind: 'execution_run' as const, sessionId: 'source-session', runId: 'source-run' };
  const request = { v: 1 as const, source };
  let push: ((change: RunFollowAvailability) => void) | undefined;
  let finish!: (response: { status: number; data: unknown }) => void;
  const waiting = new Promise<{ status: number; data: unknown }>(resolve => { finish = resolve; });
  const ready = { ok: true, v: 1, original: { source, terminalEventId: 'terminal' }, event: { kind: 'finished' }, routes: [] };
  const posts = vi.spyOn(axios, 'post').mockImplementationOnce(() => waiting).mockResolvedValue({ status: 200, data: ready });
  const routes = createAccountRunFollowRoutes({ credentials: { token: 'boundary-token', encryption: null },
    serverHttpBaseUrl: 'https://run-frontier.test', signal: new AbortController().signal, isCurrent: async () => true,
    subscribeAvailability: listener => { push = listener; return () => { push = undefined; }; } });
  const consumed: unknown[] = [];
  routes.bindDispatch(async (next, context) => { consumed.push({ context, response: await routes.read(next, context) }); });
  try {
    const callers = Promise.all(Array.from({ length: 100 }, () => routes.read(request)));
    await vi.waitFor(() => expect(posts).toHaveBeenCalledTimes(1));
    finish({ status: 409, data: { ok: false, v: 1, error: 'source_unavailable' } });
    expect(await callers).toEqual(Array.from({ length: 100 }, () => null));
    for (let index = 0; index < 100; index++) expect(await routes.read(request)).toBeNull();
    await routes.read(request, { personalOnly: true });
    await routes.read(request, { receiverSessionId: 'receiver' });
    expect(posts).toHaveBeenCalledTimes(1);
    push?.({ ...source, runId: 'other-run' });
    await routes.read(request);
    expect(posts).toHaveBeenCalledTimes(1);
    push?.(source);
    await vi.waitFor(() => expect(consumed).toEqual([
      { context: {}, response: ready }, { context: { personalOnly: true }, response: ready },
      { context: { receiverSessionId: 'receiver' }, response: ready },
    ]));
    expect(posts).toHaveBeenCalledTimes(2);
    // Positive routes are not a cache or admission grant: final readers remain fresh.
    expect(await routes.read(request)).toEqual(ready);
    expect(posts).toHaveBeenCalledTimes(3);
  } finally { routes.dispose(); }
});

it.each(['machine', 'session'] as const)('does not lose an availability push that arrives while the refused %s frontier read is still pending', async kind => {
  const targetMachineId = 'machine';
  const source = kind === 'machine' ? { kind: 'execution_run' as const, machineId: targetMachineId, runId: 'run' }
    : { kind: 'execution_run' as const, sessionId: 'session', runId: 'run' };
  let push: ((change: RunFollowAvailability) => void) | undefined;
  let finish!: (response: { status: number; data: unknown }) => void;
  const waiting = new Promise<{ status: number; data: unknown }>(resolve => { finish = resolve; });
  const refusal = { status: 409, data: { ok: false, v: 1, error: 'source_unavailable',
    ...(kind === 'session' ? { targetMachineId } : {}) } };
  const posts = vi.spyOn(axios, 'post').mockImplementationOnce(() => waiting).mockResolvedValue(refusal);
  const routes = createAccountRunFollowRoutes({ credentials: { token: 'boundary-token', encryption: null },
    serverHttpBaseUrl: 'https://run-frontier.test', signal: new AbortController().signal, isCurrent: async () => true,
    subscribeAvailability: listener => { push = listener; return () => { push = undefined; }; } });
  routes.bindDispatch(async request => { await routes.read(request); });
  try {
    const first = routes.read({ v: 1, source });
    await vi.waitFor(() => expect(posts).toHaveBeenCalledTimes(1));
    push?.({ kind: 'machine', machineId: targetMachineId });
    finish(refusal);
    await first;
    await vi.waitFor(() => expect(posts).toHaveBeenCalledTimes(2));
    expect(posts.mock.calls[1]?.[2]?.params).toEqual({ includeTargetMachineId: 'true', releaseReason: 'target_machine' });
    for (let index = 0; index < 100; index++) await routes.read({ v: 1, source });
    expect(posts).toHaveBeenCalledTimes(2);
  } finally { routes.dispose(); }
});
