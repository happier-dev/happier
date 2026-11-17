import { access, readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { startAutomaticCheckFixture, hasAutomaticCheckPhase } from '../../src/testkit/automationPending';
import { waitFor } from '../../src/testkit/timing';

describe('AE.P02.F9-override', () => {
  let fixture: Awaited<ReturnType<typeof startAutomaticCheckFixture>> | undefined;
  afterEach(async () => { await fixture?.release(); await fixture?.stop(); fixture = undefined; }, 0);
  it('returns an ask failure to the same open card and runs the original effect only after Approve anyway', async () => {
    fixture = await startAutomaticCheckFixture('wait', 'ask', true, true);
    const pending = await fixture.invokePending();
    await waitFor(async () => hasAutomaticCheckPhase(await fixture!.approval(pending.artifactId), 'checking'),
      { context: 'Before check admission' });
    await expect(access(fixture.effectPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await fixture.release();
    await waitFor(async () => hasAutomaticCheckPhase(await fixture!.approval(pending.artifactId), 'override'),
      { context: 'Failed ask check returns to human decision' });
    expect(await fixture.approval(pending.artifactId)).toMatchObject({ status: 'open', automaticChecks: {
      phase: 'override', results: [expect.objectContaining({ outcome: 'failed' })],
    } });
    await expect(access(fixture.effectPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fixture.actor.execute('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve' }, fixture.agentContext))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(await fixture.actor.execute('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve' }))
      .toMatchObject({ ok: true });
    expect((await pending.invocation).ok).toBe(true);
    await waitFor(async () => (await fixture!.approval(pending.artifactId)).status === 'executed',
      { context: 'Override effect settlement' });
    expect(await readFile(fixture.effectPath, 'utf8')).toBe('effect');
    expect(await fixture.runs()).toHaveLength(1);
    expect(await fixture.actor.execute('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve' }))
      .toMatchObject({ ok: true });
    expect(await fixture.runs()).toHaveLength(1);
  }, 0);
  it('keeps a denied ask check refused with its recorded failure and no effect', async () => {
    fixture = await startAutomaticCheckFixture('wait', 'ask', true, true);
    const pending = await fixture.invokePending();
    await waitFor(async () => hasAutomaticCheckPhase(await fixture!.approval(pending.artifactId), 'checking'),
      { context: 'Before check admission for denial' });
    await fixture.release();
    await waitFor(async () => hasAutomaticCheckPhase(await fixture!.approval(pending.artifactId), 'override'),
      { context: 'Failed check awaits ordinary denial' });
    expect(await fixture.actor.execute('approval.request.decide', { artifactId: pending.artifactId, decision: 'reject' }))
      .toMatchObject({ ok: true, result: { status: 'rejected' } });
    await pending.invocation;
    expect(await fixture.approval(pending.artifactId)).toMatchObject({ status: 'rejected', automaticChecks: {
      results: [expect.objectContaining({ outcome: 'failed' })],
    } });
    expect(await fixture.runs()).toHaveLength(1);
    await expect(access(fixture.effectPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 0);

});
