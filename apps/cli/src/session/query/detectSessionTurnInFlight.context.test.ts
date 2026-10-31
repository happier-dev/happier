import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectSessionTurnActivity, SessionTurnActivityUnavailableError } from './detectSessionTurnInFlight';

type Row = { id: string; seq: number; localId: null; createdAt: number; updatedAt: number; content: { t: 'plain'; v: unknown } };
const row = (seq: number, v: unknown): Row => ({ id: `m-${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq, content: { t: 'plain', v } });
const task = (type: 'task_started' | 'task_complete') => ({ role: 'agent', content: { type: 'acp', provider: 'codex', data: { type, id: 'task-1' } } });
const noise = (seq: number) => row(seq, { role: 'agent', content: { type: 'acp', provider: 'codex', data: { type: 'tool-result', callId: `call-${seq}`, id: `result-${seq}`, output: 'ok' } } });
const read = (extra = {}) => detectSessionTurnActivity({ token: 'token', sessionId: 'sess-1', encryptionMode: 'plain', encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey', ...extra });
function serve(rows: Row[]) {
  return vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    const query = new URL(String(url), 'http://boundary.test').searchParams;
    const rawParams: unknown = config?.params;
    const params = rawParams && typeof rawParams === 'object' ? rawParams as Record<string, unknown> : {};
    const value = (key: string) => params[key] ?? query.get(key);
    const after = value('afterSeq') === null || value('afterSeq') === undefined ? null : Number(value('afterSeq'));
    const before = value('beforeSeq') === null || value('beforeSeq') === undefined ? null : Number(value('beforeSeq'));
    const selected = rows.filter(item => (after === null || item.seq > after) && (before === null || item.seq < before))
      .sort((a, b) => after === null ? b.seq - a.seq : a.seq - b.seq);
    const limit = Number(value('limit') ?? 20);
    const hasMore = selected.length > limit;
    const messages = selected.slice(0, limit);
    return { status: 200, data: { messages, hasMore, nextBeforeSeq: after === null && hasMore ? messages.at(-1)?.seq ?? null : null, nextAfterSeq: after !== null && hasMore ? messages.at(-1)?.seq ?? null : null } };
  });
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('legacy transcript activity context', () => {
  it('recovers an active task start across multiple backward pages before the latest twenty tool rows', async () => {
    serve([row(1, task('task_started')), ...Array.from({ length: 2004 }, (_, index) => noise(index + 2))]);
    await expect(read()).resolves.toEqual({ pendingUserTurns: 0, activeTaskInFlight: true, turnInFlight: true });
  });
  it('preserves the existing reduction when the latest window already has material activity evidence', async () => {
    serve([row(1, { role: 'user', content: { type: 'text', text: 'queued prompt' } }), row(2, { role: 'user', content: { type: 'text', text: 'queued prompt' } }), row(3, { role: 'user', content: { type: 'text', text: 'queued prompt' } }), row(4, task('task_started')), row(5, task('task_complete')), row(6, { role: 'agent', content: { type: 'event', data: { type: 'ready' } } }), ...Array.from({ length: 9 }, (_, index) => noise(index + 7))]);
    await expect(read()).resolves.toEqual({ pendingUserTurns: 1, activeTaskInFlight: false, turnInFlight: true });
  });
  it('keeps an explicit after-sequence boundary ahead of an earlier task start', async () => {
    serve([row(1, task('task_started')), ...Array.from({ length: 24 }, (_, index) => noise(index + 2))]);
    await expect(read({ afterSeqExclusive: 1 })).resolves.toEqual({ pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false });
  });
  it('retains complete foreground projection precedence over older transcript activity', async () => {
    const http = serve([row(1, task('task_started')), ...Array.from({ length: 24 }, (_, index) => noise(index + 2))]);
    await expect(read({ sessionProjection: { latestTurnStatus: 'completed', pendingCount: 0, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 } })).resolves.toEqual({ pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false });
    expect(http).not.toHaveBeenCalled();
  });
  it('observes an older Claude row becoming terminal at the same sequence on the next read', async () => {
    const assistant = (stopReason: string | null) => ({ role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: 'assistant-1', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], stop_reason: stopReason } } } });
    const rows = [row(1, task('task_started')), row(2, assistant(null)), ...Array.from({ length: 24 }, (_, index) => noise(index + 3))];
    serve(rows);
    await expect(read()).resolves.toMatchObject({ activeTaskInFlight: true, turnInFlight: true });
    rows[1] = row(2, assistant('end_turn'));
    await expect(read()).resolves.toEqual({ pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false });
  });
  it('does not backfill a legacy sidechain task into foreground activity', async () => {
    serve([row(1, { ...task('task_started'), meta: { sidechainId: 'background-1' } }), ...Array.from({ length: 24 }, (_, index) => noise(index + 2))]);
    await expect(read()).resolves.toEqual({ pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false });
  });
  it.each([
    { messages: [], hasMore: true, nextBeforeSeq: 1 },
    { messages: [{ seq: 1, createdAt: 1, content: { t: 'invalid' } }], hasMore: false },
  ])('rejects incomplete or malformed transcript pages rather than interpreting them as idle: %j', async (data) => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data });
    await expect(read()).rejects.toBeInstanceOf(SessionTurnActivityUnavailableError);
  });
  it('spends one caller budget across the initial page and context pages', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const rows = [row(1, task('task_started')), ...Array.from({ length: 24 }, (_, index) => noise(index + 2))];
    const http = serve(rows);
    const response = http.getMockImplementation()!;
    http.mockImplementation(async (url, config) => {
      const result = await response(url, config);
      now = now === 0 ? 25 : 31;
      return result;
    });
    await expect(read({ transcriptFetchTimeoutMs: 30 })).rejects.toBeInstanceOf(SessionTurnActivityUnavailableError);
    expect(http.mock.calls.map(call => call[1]?.timeout)).toEqual([30, 5]);
  });
  it('preserves cancellation through completion of a context response body', async () => {
    const controller = new AbortController();
    const rows = [row(1, task('task_started')), ...Array.from({ length: 24 }, (_, index) => noise(index + 2))];
    const http = serve(rows);
    const response = http.getMockImplementation()!;
    let contextStarted = false;
    http.mockImplementation(async (url, config) => {
      if (config?.params?.beforeSeq !== undefined) {
        contextStarted = true;
        const result = await response(url, config);
        controller.abort(new Error('cancelled'));
        return result;
      }
      return response(url, config);
    });
    await expect(read({ signal: controller.signal })).rejects.toBeInstanceOf(SessionTurnActivityUnavailableError);
    expect(contextStarted).toBe(true);
  });

  it('accepts a caller budget larger than native timer ranges and releases completed-read timers', async () => {
    vi.useFakeTimers();
    serve([row(1, task('task_started')), ...Array.from({ length: 24 }, (_, index) => noise(index + 2))]);
    await expect(read({ transcriptFetchTimeoutMs: 2 ** 32 })).resolves.toMatchObject({ activeTaskInFlight: true, turnInFlight: true });
    expect(vi.getTimerCount()).toBe(0);
  });

});
