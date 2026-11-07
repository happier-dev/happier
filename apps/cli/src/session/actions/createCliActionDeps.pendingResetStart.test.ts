import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

function fixture(protocolVersion = 4) {
  const source = { bindingKind: 'account' as const, ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'account' } };
  const recordKey = { providerId: 'test', accountSubjectId: 'subject', subjectKind: 'account' as const, quotaScope: 'account' as const };
  const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
    providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'subject' }, observedAtMs: 250, fetchedAtMs: 250,
    staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
    meters: [{ meterId: 'weekly', label: 'Weekly', used: 50, limit: 100, utilizationPct: 50, unit: 'requests',
      resetsAt: 1000, windowDurationMs: 1000, status: 'ok', details: {} }] });
  const reset = { source, recordId: snapshot.recordId, meterId: 'weekly', witness: { id: 'accepted', observedAtMs: 250 } };
  const requestedAction = { v: 1 as const, kind: 'reset_start' as const, reset };
  const record = (value = snapshot) => ({ content: { t: 'plain', v: value }, metadata: {
    fetchedAt: value.fetchedAtMs, staleAfterMs: value.staleAfterMs, status: 'ok' }, sources: [source] });
  const features = FeaturesResponseSchema.parse({ features: { sharing: { session: { enabled: true }, public: { enabled: true },
    contentKeys: { enabled: true }, pendingQueueV2: { enabled: true } } }, capabilities: { session: { pendingInput: { protocolVersion } } } });
  const deps = createCliActionDeps({ token: 'account-token', credentials: { token: 'account-token', encryption: null },
    sessionId: 'session', mode: 'plain', ctx: null, resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) });
  return { source, snapshot, reset, requestedAction, record, deps };
}

describe('CLI reset start admission', () => {
  it.each([undefined, 'run/one'])('restores discarded Pending through CLI composition for recipient %s', async targetExecutionRunId => {
    const { deps } = fixture();
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const controller = new AbortController();
    expect(await createActionExecutor(deps).execute('session.pending.requeue', {
      sessionId: 'session/one', localId: 'input/one', ...(targetExecutionRunId ? { targetExecutionRunId } : {}),
    }, { surface: 'cli', authority: 'present_user', signal: controller.signal,
      presentUserConfirmation: { actionId: 'session.pending.requeue' } })).toEqual({ ok: true, result: { ok: true } });
    const recipient = targetExecutionRunId ? '/execution-runs/run%2Fone' : '';
    expect(post).toHaveBeenCalledWith(expect.stringContaining(`/v2/sessions/session%2Fone${recipient}/pending/input%2Fone/restore`), {},
      expect.objectContaining({ signal: controller.signal, headers: expect.objectContaining({ Authorization: 'Bearer account-token' }) }));
  });

  it.each([false, undefined])('preserves the explicit inactive-resume choice (%s) through the pending Action', async resumeWhenAvailable => {
    const { deps } = fixture();
    const requestedAction = { v: 1, kind: 'enqueue' } as const;
    const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: { ok: true, didUpdate: true, requestedAction } });
    expect(await createActionExecutor(deps).execute('session.pending.action.set', {
      sessionId: 'session/one', localId: 'input/one', requestedAction,
      ...(resumeWhenAvailable !== undefined ? { resumeWhenAvailable } : {}),
    }, { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'session.pending.action.set' } }))
      .toEqual({ ok: true, result: { didUpdate: true, requestedAction } });
    expect(patch).toHaveBeenCalledWith(expect.stringContaining('/v2/sessions/session%2Fone/pending/input%2Fone/action'),
      { requestedAction, ...(resumeWhenAvailable !== undefined ? { resumeWhenAvailable } : {}) },
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer account-token' }) }));
  });

  it.each(['session.pending.markHandled', 'session.pending.dismiss', 'session.pending.sendAsNew'] as const)(
    'delivers %s through the registered Action and existing pending HTTP owner', async actionId => {
      const { deps } = fixture();
      const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true, newLocalId: 'replacement' } });
      const targetExecutionRunId = actionId === 'session.pending.markHandled' ? undefined : 'run/one';
      const input = { sessionId: 'session/one', localId: 'input/one', ...(targetExecutionRunId ? { targetExecutionRunId } : {}) };
      expect(await createActionExecutor(deps).execute(actionId, input, { surface: 'ui', authority: 'present_user',
        presentUserConfirmation: { actionId } })).toEqual({ ok: true,
          result: actionId === 'session.pending.sendAsNew' ? { newLocalId: 'replacement' } : { ok: true } });
      const action = actionId === 'session.pending.markHandled' ? 'handled' : actionId === 'session.pending.dismiss' ? 'dismiss' : 'send-as-new';
      const owner = targetExecutionRunId ? '/execution-runs/run%2Fone' : '';
      expect(post).toHaveBeenCalledWith(expect.stringContaining(`/v2/sessions/session%2Fone${owner}/pending/input%2Fone/delivery/${action}`), {},
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer account-token' }) }));
    });

  it.each([false, true])('admits the exact witnessed future window through one pending mutation (initial %s)', async initial => {
    const { source, snapshot, reset, requestedAction, record, deps } = fixture();
    vi.spyOn(Date, 'now').mockReturnValue(500);
    vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: String(url).endsWith('/encryption/currentness')
      ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
      : String(url).includes('/sources/resolve') ? { source, recordId: snapshot.recordId, providerAccountId: 'subject', fetchedAt: 250, staleAfterMs: 1000 }
      : String(url).includes('/history') ? { entries: [{ id: 'accepted', observedAtMs: 250, record: record() }], nextCursor: null }
      : record() }));
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => ({ status: 200,
      data: String(url).endsWith('/reset-starts/read') ? { entries: [] } : { ok: true, didWrite: true } }));
    const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: { ok: true, didUpdate: true, requestedAction } });
    const content = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'prepared work' } } };
    const result = await deps.sessionPendingResetStartSet!({ sessionId: 'session', localId: 'one-input', reset,
      ...(initial ? { initialInput: { content, targetMachineId: 'machine' } } : {}), context: { surface: 'cli' } });
    expect(result).toEqual({ didUpdate: true, requestedAction });
    const inputs = post.mock.calls.filter(([url]) => String(url).endsWith('/sessions/session/pending'));
    expect(inputs).toHaveLength(initial ? 1 : 0);
    if (initial) {
      expect(inputs[0]?.[1]).toEqual({ localId: 'one-input', content, messageRole: 'user', targetMachineId: 'machine', requestedAction });
      expect(patch).not.toHaveBeenCalled();
    } else expect(patch).toHaveBeenCalledOnce();
  });

  it('refuses a known unsupported Home before creating initial custody', async () => {
    const { reset, requestedAction, deps } = fixture(3);
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true, didWrite: true } });
    const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: { ok: true, didUpdate: true, requestedAction } });
    expect(await createActionExecutor(deps).execute('session.pending.resetStart.set', { sessionId: 'session', localId: 'one-input', reset,
      initialInput: { content: { t: 'plain', v: {} } } }, { surface: 'ui', authority: 'present_user',
        presentUserConfirmation: { actionId: 'session.pending.resetStart.set' } }))
      .toMatchObject({ ok: false, errorCode: 'reset_start_unsupported' });
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it.each(['stale', 'changed', 'witnessMissing', 'cancelled'] as const)('withholds initial input when reset evidence is %s', async scenario => {
    const { source, snapshot, reset, requestedAction, record, deps } = fixture();
    vi.spyOn(Date, 'now').mockReturnValue(scenario === 'stale' ? 1500 : 500);
    const controller = new AbortController();
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).includes('/history') && scenario === 'cancelled') controller.abort();
      return { status: 200, data: String(url).endsWith('/encryption/currentness')
        ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
        : String(url).includes('/sources/resolve') ? { source, recordId: snapshot.recordId, providerAccountId: 'subject', fetchedAt: 250, staleAfterMs: 1000 }
        : String(url).includes('/history') ? { entries: scenario === 'witnessMissing' ? [] : [{ id: 'accepted', observedAtMs: 250, record: record() }], nextCursor: null }
        : record(scenario === 'changed' ? { ...snapshot, meters: [{ ...snapshot.meters[0]!, resetsAt: 2000 }] } : snapshot) };
    });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { entries: [] } });
    const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: { ok: true, didUpdate: true, requestedAction } });
    const input = { sessionId: 'session', localId: 'one-input', reset, initialInput: { content: { t: 'plain' as const, v: {} } } };
    if (scenario === 'stale') {
      expect(await createActionExecutor(deps).execute('session.pending.resetStart.set', input,
        { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'session.pending.resetStart.set' } }))
        .toMatchObject({ ok: false, errorCode: 'reset_start_unavailable', details: { reason: 'quota_stale' } });
    } else if (scenario === 'cancelled') {
      await expect(deps.sessionPendingResetStartSet!({ ...input, context: { surface: 'cli', signal: controller.signal } })).rejects.toThrow();
    } else {
      expect(await deps.sessionPendingResetStartSet!({ ...input, context: { surface: 'cli', signal: controller.signal } }))
        .toMatchObject({ ok: false, errorCode: 'reset_start_unavailable', details: { reason: scenario === 'changed' ? 'window_changed' : 'witness_unavailable' } });
    }
    expect(post.mock.calls.filter(([url]) => String(url).endsWith('/sessions/session/pending'))).toHaveLength(0);
    expect(patch).not.toHaveBeenCalled();
  });
});
