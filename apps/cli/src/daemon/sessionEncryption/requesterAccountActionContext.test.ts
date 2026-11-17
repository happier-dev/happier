import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { retainVerifiedExternalActionRequester, readRetainedVerifiedExternalActionRequester } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { canReadIncompleteSecretMaskingForHost } from '@/plugins/runtime/invocation/services/managedServiceNativeLogs';
import { rebindRequesterAccountActionContext, readRequesterAccountActionContext } from './requesterAccountActionContext';

it('preserves verified person disclosure through same-root Account custody enrichment without blessing copied or changed roots', async () => {
  const channel = await createRequesterCurrentnessSocketHarness();
  const fixture = await createDeploymentChildRequesterHarness({ encryptionMode: 'plain' });
  let prepared: Awaited<ReturnType<typeof fixture.prepare>> | undefined;
  try {
    // Substitute only Home HTTP; Account custody and carrier enrichment remain real.
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: fixture.settingsContent, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: fixture.currentness };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      throw new Error('Unexpected requester Home read');
    });
    prepared = await fixture.prepare();
    const custody = readRequesterAccountActionContext(prepared.authorization);
    if (!custody) throw new Error('Expected canonical Account custody');
    // Trusted ingress is the only proof producer; the real UI/Home regression
    // supplies its signer and demonstrates the production enrichment hop.
    const admitted = retainVerifiedExternalActionRequester({ authorization: prepared.authorization,
      isCurrent: async () => { throw new Error('An admitted finite read must not re-admit'); } });
    const person = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    expect(canReadIncompleteSecretMaskingForHost({ ...person, externalActionExecutionAuthorization: admitted })).toBe(true);
    const rebound = rebindRequesterAccountActionContext(admitted, admitted, custody);
    expect(readRequesterAccountActionContext(rebound)?.authorization).toBe(rebound);
    expect(canReadIncompleteSecretMaskingForHost({ ...person, externalActionExecutionAuthorization: rebound })).toBe(true);
    expect(readRetainedVerifiedExternalActionRequester(rebound)?.authorization).toBe(rebound);
    for (const candidate of [
      { ...admitted },
      Object.defineProperties({ ...admitted }, Object.getOwnPropertyDescriptors(admitted)),
      { ...admitted, token: 'another-root' },
      { ...admitted, binding: { ...admitted.binding, requestId: 'another-request' } },
    ]) {
      const previous = candidate.token === admitted.token && candidate.binding === admitted.binding ? candidate : admitted;
      const changed = rebindRequesterAccountActionContext(candidate, previous);
      expect(readRetainedVerifiedExternalActionRequester(changed)).toBeUndefined();
      expect(canReadIncompleteSecretMaskingForHost({ ...person, externalActionExecutionAuthorization: changed })).toBe(false);
    }
    for (const context of [
      { ...person, approvedActionReplay: {} },
      { ...person, authority: 'account_automation' as const },
      { ...person, actionCaller: { kind: 'session' as const, sessionId: 'agent', starterDepth: 0, turnDepth: 0 } },
      { ...person, inheritedLocalActionContext: { authority: 'account_automation' as const } },
    ]) expect(canReadIncompleteSecretMaskingForHost({ ...context, externalActionExecutionAuthorization: rebound })).toBe(false);
  } finally {
    await prepared?.dispose();
    await channel.close();
    vi.restoreAllMocks();
  }
});
