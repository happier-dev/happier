import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';

it('admits exact Account Run proofs, recovers only captured proofs after transport loss, isolates release, and refuses an Account lifetime replacement', async () => {
  let homeAvailable = true;
  const fixture = await createAttachedManagedRunFixture({ resolveRunAuthority: request => {
    if (!homeAvailable) throw new Error('Authenticated Home RPC unavailable');
    return { status: 'current', executionRunId: request.executionRunId, occurrenceId: request.expectedOccurrenceId!,
      parentSessionId: 'parent-session', intent: 'review', runtimeState: 'idle', teamCredentialProviderModel: null };
  } });
  const { dispatch, proof } = fixture;
  try {
    const opened = await dispatch({ kind: 'provider_managed.binding.open', requestId: 'open', ...proof });
    expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true, result: { kind: 'provider_managed.binding' } });
    if (!opened.ok || opened.result.kind !== 'provider_managed.binding') throw new Error('Expected real private consumer');
    const physicalPid = Number(await readFile(join(fixture.directory, 'gateway-started'), 'utf8'));
    expect(physicalPid).toBeGreaterThan(0);
    const send = (binding: typeof opened.result) => fetch(`${binding.endpointUrl}/responses`, {
      method: 'POST', headers: binding.headers, body: JSON.stringify({ model: 'example', input: 'hello' }),
    });
    expect((await send(opened.result)).ok).toBe(true);
    const changed = await dispatch({ kind: 'provider_managed.binding.read', requestId: 'tampered', ...proof,
      bindingId: opened.result.bindingId, modelId: 'different-model' });
    expect(changed).toMatchObject({ ok: false, error: { code: 'provider_endpoint_unavailable' } });
    expect((await send(opened.result)).ok).toBe(true);

    const secondProof = { ...proof, executionRunId: 'run-second', executionRunOccurrenceId: 'second-occurrence' };
    const second = await dispatch({ kind: 'provider_managed.binding.open', requestId: 'second', ...secondProof });
    if (!second.ok || second.result.kind !== 'provider_managed.binding') throw new Error(JSON.stringify(second));
    expect(second.result.headers).not.toEqual(opened.result.headers);
    expect((await send(second.result)).ok).toBe(true);
    expect(Number(await readFile(join(fixture.directory, 'gateway-started'), 'utf8'))).toBe(physicalPid);
    await expect(dispatch({ kind: 'provider_managed.binding.close', requestId: 'close', bindingId: opened.result.bindingId }))
      .resolves.toMatchObject({ ok: true, result: { kind: 'provider_managed.binding.closed' } });
    await expect(send(opened.result)).rejects.toBeDefined();
    expect((await send(second.result)).ok).toBe(true);

    // Lost process-private cleanup handles do not change the captured proof.
    const recovered = await dispatch({ kind: 'provider_managed.binding.read', requestId: 'recovered', ...proof,
      bindingId: opened.result.bindingId });
    if (!recovered.ok || recovered.result.kind !== 'provider_managed.binding') throw new Error(JSON.stringify(recovered));
    expect((await send(recovered.result)).ok).toBe(true);
    expect(Number(await readFile(join(fixture.directory, 'gateway-started'), 'utf8'))).toBe(physicalPid);
    await dispatch({ kind: 'provider_managed.binding.close', requestId: 'close-recovered', bindingId: recovered.result.bindingId });
    expect((await send(second.result)).ok).toBe(true);

    // Transport loss withdraws the old listener; restoration permits a later
    // genuine read of only the original proof, never replaying an inference.
    homeAvailable = false;
    await expect(dispatch({ kind: 'provider_managed.binding.read', requestId: 'home-outage', ...secondProof,
      bindingId: second.result.bindingId })).resolves.toMatchObject({ ok: false, error: { code: 'provider_endpoint_unavailable' } });
    await expect(send(second.result)).rejects.toBeDefined();
    homeAvailable = true;
    const afterOutage = await dispatch({ kind: 'provider_managed.binding.read', requestId: 'home-restored', ...secondProof,
      bindingId: second.result.bindingId });
    expect(afterOutage).toMatchObject({ ok: true, result: { kind: 'provider_managed.binding' } });
    if (!afterOutage.ok || afterOutage.result.kind !== 'provider_managed.binding') throw new Error(JSON.stringify(afterOutage));
    expect(afterOutage.result.headers).not.toEqual(second.result.headers);
    expect((await send(afterOutage.result)).ok).toBe(true);

    setActiveAccountSettingsSnapshot({ ...fixture.snapshot, scopeKey: 'another-account-scope' });
    await expect(dispatch({ kind: 'provider_managed.binding.read', requestId: 'scope-changed', ...secondProof,
      bindingId: afterOutage.result.bindingId })).resolves.toMatchObject({ ok: false, error: { code: 'provider_endpoint_unavailable' } });
    await expect(send(afterOutage.result)).rejects.toBeDefined();
    await expect(dispatch({ kind: 'provider_managed.binding.read', requestId: 'no-fallback', ...secondProof }))
      .resolves.toMatchObject({ ok: false, error: { code: 'provider_endpoint_unavailable' } });
  } finally { await fixture.cleanup(); }
});
