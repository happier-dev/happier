import { expect, it, vi } from 'vitest';
import axios from 'axios';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveSystemToolLaunchPurposeDeclarations } from '@/daemon/connectedServices/requestAuth/agentPurposeDeclarations';

it('keeps an owned native Session terminal usable after its in-memory purpose snapshot retires', async () => {
  const f = await createAttachedManagedRunFixture({ issuedRequester: true, includeBundledDeclarations: true });
  try {
    const registry = pluginReloadController.getState().activeRegistry;
    if (!registry || !f.requester?.activateSessionPurposeBindings) throw new Error('Expected real requester and plugin registry');
    const declarations = resolveSystemToolLaunchPurposeDeclarations(registry.contributes);
    expect(declarations.some(declaration => declaration.snapshot.environmentUses?.some(use => use.environmentKey === 'GH_TOKEN'))).toBe(true);
    const input = { sessionId: 'parent-session', requesterAccountId: 'account',
      environment: { PATH: '/native/bin', GH_TOKEN: 'native-environment-token' }, signal: new AbortController().signal };
    const lease = f.requester.activateSessionPurposeBindings({ sessionId: input.sessionId, purposes: [], bindings: [] });
    try {
      await expect(f.runtime.materializeSessionProcessEnvironment(input)).resolves.toEqual({ environment: input.environment, secretValues: [] });
      await expect(f.runtime.materializeSessionProcessEnvironment({ ...input, requesterAccountId: 'other-account' }))
        .rejects.toMatchObject({ code: 'credential_unavailable' });
    } finally { lease.dispose(); }
    expect(f.requester.readSessionPurposeBindingSnapshot(input.sessionId)).toBeNull();
    const github = declarations.find(declaration => declaration.snapshot.environmentUses?.some(use => use.environmentKey === 'GH_TOKEN'))!;
    const service = github.snapshot.authorizedPurposes[0]!.serviceRefs[0]!;
    if (!f.tracked.spawnOptions) throw new Error('Expected retained Session launch selection');
    f.tracked.spawnOptions.connectedServices = { v: 2, bindingsByServiceId: {
      [buildQualifiedPluginContributionKey(service)]: { source: 'connected', selection: 'profile', profileId: 'unavailable-selected-account' },
    } };
    await expect(f.runtime.materializeSessionProcessEnvironment(input)).rejects.toMatchObject({ code: 'credential_unavailable' });
    f.tracked.spawnOptions.connectedServices = { v: 2, bindingsByServiceId: {} };
    await expect(f.runtime.materializeSessionProcessEnvironment(input)).resolves.toEqual({ environment: input.environment, secretValues: [] });
    // Untracked selections are read through the real mode-checked Session owner.
    // Substitute only authenticated Home HTTP to distinguish unreadable/malformed data.
    const launch = f.tracked.spawnOptions;
    f.tracked.spawnOptions = undefined;
    const read = vi.mocked(axios.get).getMockImplementation();
    if (!read) throw new Error('Expected requester Home HTTP boundary');
    let persisted: 'native' | 'invalid' | 'missing' = 'native';
    const home = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      if (new URL(String(url)).pathname !== '/v2/sessions/parent-session') return read(url, options);
      if (persisted === 'missing') return { status: 404, data: { error: 'Session not found' } };
      return { status: 200, data: { session: createSessionRecordFixture({
        id: input.sessionId, encryptionMode: 'plain', dataEncryptionKey: null,
        metadata: JSON.stringify({ machineId: f.fixture.machineId, ...(persisted === 'invalid' ? { connectedServices: { invalid: true } } : {}) }),
      }) } };
    });
    try {
      await expect(f.runtime.materializeSessionProcessEnvironment(input)).resolves.toEqual({ environment: input.environment, secretValues: [] });
      persisted = 'invalid';
      await expect(f.runtime.materializeSessionProcessEnvironment(input)).rejects.toMatchObject({ code: 'credential_unavailable' });
      persisted = 'missing';
      await expect(f.runtime.materializeSessionProcessEnvironment(input)).rejects.toMatchObject({ code: 'credential_unavailable' });
    } finally { home.mockRestore(); f.tracked.spawnOptions = launch; }
    await f.requester.dispose();
    await expect(f.runtime.materializeSessionProcessEnvironment(input)).rejects.toThrow('requester_session_not_current');
  } finally { await f.cleanup(); }
});
