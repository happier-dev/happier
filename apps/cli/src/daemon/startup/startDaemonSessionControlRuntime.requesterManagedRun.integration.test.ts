import { expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';

it('uses an actually issued same-Account reader with distinct credentials and never falls back after its admission disappears', async () => {
  const fixture = await createAttachedManagedRunFixture({ issuedRequester: true });
  try {
    const requester = fixture.requester;
    if (!requester) throw new Error('Expected actual issued Account runtime');
    expect(requester.bootstrap.credentials.token).not.toBe(fixture.credentials.token);
    expect(fixture.proof.expectedAccountSettingsScopeKey).not.toBe(fixture.snapshot.scopeKey);
    expect(requester.bootstrap.attribution.accountId).toBe('account');
    const intent = fixture.fixture.gateway?.purposeBindings.bindings[0];
    if (!intent || intent.target.kind !== 'account') throw new Error('Expected canonical bound purpose');
    await expect(fixture.dispatch({ kind: 'provider_managed.purpose.resolve', requestId: 'issued-purpose',
      purpose: intent.purpose, target: intent.target, serviceRefs: [intent.target.account.service],
      expectedAccountSettingsScopeKey: fixture.proof.expectedAccountSettingsScopeKey,
    })).resolves.toMatchObject({ ok: true, result: { kind: 'provider_managed.purpose', binding: intent } });
    await expect(access(join(fixture.directory, 'gateway-started'))).rejects.toMatchObject({ code: 'ENOENT' });
    const opened = await fixture.dispatch({ kind: 'provider_managed.binding.open', requestId: 'issued-open', ...fixture.proof });
    expect(opened, JSON.stringify({ opened, sourceDiagnostics: fixture.sourceDiagnostics })).toMatchObject({ ok: true, result: { kind: 'provider_managed.binding' } });
    if (!opened.ok || opened.result.kind !== 'provider_managed.binding') throw new Error('Expected genuine issued consumer');
    const send = () => fetch(`${opened.result.endpointUrl}/responses`, { method: 'POST', headers: opened.result.headers,
      body: JSON.stringify({ model: 'example', input: 'hello' }) });
    expect((await send()).ok).toBe(true);
    const rootSnapshot = getActiveAccountSettingsSnapshot();
    fixture.withdrawRequesterAdmission();
    expect(await requester.isCurrent()).toBe(false);
    expect(() => requester.readAccountSettingsSnapshot()).toThrow('requester_account_context_unavailable');
    await expect(fixture.dispatch({ kind: 'provider_managed.binding.read', requestId: 'issued-read', ...fixture.proof,
      bindingId: opened.result.bindingId })).resolves.toMatchObject({ ok: false, error: { code: 'provider_endpoint_unavailable' } });
    await expect(send()).rejects.toBeDefined();
    await expect(fixture.dispatch({ kind: 'provider_managed.binding.read', requestId: 'issued-no-handle', ...fixture.proof }))
      .resolves.toMatchObject({ ok: false, error: { code: 'provider_endpoint_unavailable' } });
    expect(getActiveAccountSettingsSnapshot()).toBe(rootSnapshot);
  } finally { await fixture.cleanup(); }
});
