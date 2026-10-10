import { expect, it } from 'vitest';
import { createExecutionRunManagedProviderEndpointPreparer } from '@/agent/runtime/bridges/executionRun/runtime/managedProvider';
import { createRunnerManagedProviderRunSourceOpener } from '@/agent/runtime/session/process/runnerManagedProviderConsumerAccess';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createAttachedManagedRunFixture, createAttachedManagedRunControlTransport } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';

it('retains an exact attached source closer after a failed control response and releases it on explicit launch-scope retry', async () => {
  const fixture = await createAttachedManagedRunFixture();
  const resources = createProviderLaunchResourceScope();
  let transport: Awaited<ReturnType<typeof createAttachedManagedRunControlTransport>> | null = null;
  const readBinding = () => {
    if (!transport) throw new Error('Expected real private control transport');
    return transport.readBinding();
  };
  let closeUnavailable = true;
  try {
    transport = await createAttachedManagedRunControlTransport(fixture, {
      beforeDispatch(request) {
        if (request.operation.kind === 'provider_managed.binding.close' && closeUnavailable) {
          closeUnavailable = false;
          return new Response('', { status: 503 }); // Refused before dispatch, not an ambiguous close or replay.
        }
        return null;
      },
    });
    const purposeResolver = fixture.fixture.gateway!.purposeBindingOwner.resolveBindingIntent;
    const accountId = readAccountIdFromToken(fixture.credentials.token);
    if (!accountId) throw new Error('Expected authenticated fixture Account');
    const prepare = createExecutionRunManagedProviderEndpointPreparer({
      machineId: fixture.fixture.machineId, accountId, readAccountSettingsSnapshot: async () => fixture.snapshot,
      resolveManagedPurposeBindingIntent: purposeResolver,
      openSource: createRunnerManagedProviderRunSourceOpener({ services: transport.services, isOwnerCurrent: async () => true }),
    });
    const attempt = fixture.attempt;
    if (!('materializeManagedEndpoint' in attempt)) throw new Error('Expected real managed authorization');
    const endpoint = await prepare({ scope: { kind: 'execution_run', executionRunId: fixture.proof.executionRunId },
      registerCleanup: resources.register,
      authorization: attempt.authorization, agentId: fixture.proof.agentId,
      executionRunOccurrenceId: fixture.proof.executionRunOccurrenceId,
      signal: fixture.context.signal, isCurrent: async () => true });
    const send = (endpointUrl: string, headers: Record<string, string>) => fetch(`${endpointUrl}/responses`, {
      method: 'POST', headers, body: JSON.stringify({ model: 'example', input: 'hello' }),
    });
    expect((await send(endpoint.normalizedUrl, { authorization: `Bearer ${endpoint.downstreamBearer}` })).ok).toBe(true);
    await expect(resources.release()).rejects.toBeDefined();
    await expect(send(endpoint.normalizedUrl, { authorization: `Bearer ${endpoint.downstreamBearer}` })).rejects.toBeDefined();
    expect((await send(readBinding().endpointUrl, readBinding().headers)).ok).toBe(true);
    await expect(resources.release()).resolves.toBeUndefined();
    await expect(send(readBinding().endpointUrl, readBinding().headers)).rejects.toBeDefined();
  } finally {
    // A failed regression still releases the real target through its public
    // private-control closer rather than replacing internal cleanup logic.
    await transport?.cleanup();
    await resources.release().catch(() => undefined);
    await fixture.cleanup();
  }
});
