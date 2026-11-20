import { access, readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { startAutomaticCheckFixture, hasAutomaticCheckPhase } from '../../src/testkit/automationPending';
import { waitFor } from '../../src/testkit/timing';

describe('AE.P02.F9-override', () => {
  let fixture: Awaited<ReturnType<typeof startAutomaticCheckFixture>> | undefined;
  afterEach(async () => { await fixture?.release(); await fixture?.stop(); fixture = undefined; }, 0);
  async function checkIsRunning(artifactId: string) {
    const approval = await fixture!.approval(artifactId);
    const checks = 'automaticChecks' in approval ? approval.automaticChecks : undefined;
    expect(hasAutomaticCheckPhase(approval, 'checking'), JSON.stringify({ status: approval.status,
      phase: checks?.phase, humanApprovalRequired: checks?.humanApprovalRequired,
      humanDecision: checks?.humanDecision?.kind, consents: checks?.consents.map(row => row.decision),
    })).toBe(true);
    return true;
  }
  it('returns an ask failure to the same open card and runs the original effect only after Approve anyway', async () => {
    fixture = await startAutomaticCheckFixture('wait', 'ask', true, true);
    const pending = await fixture.invokePending();
    // The agent's original command still asks the person before any check runs.
    const originalApproval = fixture.actor.executeAsPerson('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve' });
    await waitFor(() => checkIsRunning(pending.artifactId),
      { context: 'Before check admission' });
    await expect(access(fixture.effectPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await fixture.release();
    expect(await originalApproval).toMatchObject({ ok: true });
    await waitFor(async () => hasAutomaticCheckPhase(await fixture!.approval(pending.artifactId), 'override'),
      { context: 'Failed ask check returns to human decision' });
    expect(await fixture.approval(pending.artifactId)).toMatchObject({ status: 'open', automaticChecks: {
      phase: 'override', results: [expect.objectContaining({ outcome: 'failed' })],
    } });
    await expect(access(fixture.effectPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fixture.actor.execute('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve' }, fixture.agentContext))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    const override = await fixture.actor.executeAsPerson('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve' });
    expect(override, JSON.stringify(override))
      .toMatchObject({ ok: true });
    expect((await pending.invocation).ok).toBe(true);
    let settled = await fixture.approval(pending.artifactId);
    await waitFor(async () => {
      settled = await fixture!.approval(pending.artifactId);
      return 'execution' in settled && settled.execution !== undefined;
    }, { context: 'Override effect settlement' }).catch(error => {
      throw new Error(JSON.stringify({ override, status: settled.status,
        automaticChecks: 'automaticChecks' in settled ? settled.automaticChecks : undefined,
        execution: 'execution' in settled ? settled.execution : undefined }), { cause: error });
    });
    expect(settled, JSON.stringify({ status: settled.status,
      execution: 'execution' in settled ? settled.execution : undefined }))
      .toMatchObject({ status: 'executed', execution: { ok: true } });
    expect(await readFile(fixture.effectPath, 'utf8')).toBe('effect');
    expect(await fixture.runs()).toHaveLength(1);
    expect(await fixture.actor.executeAsPerson('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve' }))
      .toMatchObject({ ok: true });
    expect(await fixture.runs()).toHaveLength(1);
  }, 0);
  it('keeps a denied ask check refused with its recorded failure and no effect', async () => {
    fixture = await startAutomaticCheckFixture('wait', 'ask', true, true);
    const pending = await fixture.invokePending();
    const originalApproval = fixture.actor.executeAsPerson('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve' });
    await waitFor(() => checkIsRunning(pending.artifactId),
      { context: 'Before check admission for denial' });
    await fixture.release();
    expect(await originalApproval).toMatchObject({ ok: true });
    await waitFor(async () => hasAutomaticCheckPhase(await fixture!.approval(pending.artifactId), 'override'),
      { context: 'Failed check awaits ordinary denial' });
    expect(await fixture.actor.executeAsPerson('approval.request.decide', { artifactId: pending.artifactId, decision: 'reject' }))
      .toMatchObject({ ok: true, result: { status: 'rejected' } });
    await pending.invocation;
    expect(await fixture.approval(pending.artifactId)).toMatchObject({ status: 'rejected', automaticChecks: {
      results: [expect.objectContaining({ outcome: 'failed' })],
    } });
    expect(await fixture.runs()).toHaveLength(1);
    await expect(access(fixture.effectPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 0);

});
