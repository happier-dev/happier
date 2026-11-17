import { access } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { startAutomaticCheckFixture } from '../../src/testkit/automationPending';
import { waitFor } from '../../src/testkit/timing';

describe('AE.P02.F3-notify', () => {
  let fixture: Awaited<ReturnType<typeof startAutomaticCheckFixture>> | undefined;
  afterEach(async () => { await fixture?.release(); await fixture?.stop(); fixture = undefined; }, 0);
  it('admits one ordinary check Run and finishes the effect while notify is still running', async () => {
    fixture = await startAutomaticCheckFixture('notify');
    expect(await fixture.invoke()).toMatchObject({ ok: true, result: { exitCode: 0, stdout: 'effect' } });
    await expect(access(fixture.effectPath)).resolves.toBeUndefined();
    await waitFor(async () => (await fixture!.runs()).length === 1, { context: 'Notify check admission' });
    const runs = await fixture.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ automationId: fixture.saved.set.automationId });
    expect(runs[0]!.state).not.toBe('succeeded');
    await fixture.release();
    await waitFor(async () => {
      const run = (await fixture!.runs())[0];
      expect(run?.state, JSON.stringify({ runId: run?.id, state: run?.state, errorCode: run?.errorCode }))
        .toBe('succeeded');
      return true;
    }, { context: 'Detached notify completion' });
    expect(await fixture.runs()).toHaveLength(1);
  }, 0);
});
