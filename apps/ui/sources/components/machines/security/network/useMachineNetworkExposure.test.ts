import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { buildDeploymentAccountChangeV1, DeploymentDomainListResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { useMachineNetworkExposure } = await import('./useMachineNetworkExposure');

describe('Network exposure through the shared admitted Deployment reads', () => {
  beforeEach(() => homes.reset());
  afterEach(() => standardCleanup());

  it('reads one visible Machine page and one Domain page; unrelated arrivals, hidden and Use demand perform no reads', async () => {
    const serverId = await homes.addHome({ name: 'Network Domain', serverUrl: 'https://network-domain.test', accountId: 'owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const environment = createDeploymentEnvironmentHeaderV1({ serverId, owner: { kind: 'account', accountId: 'owner' } });
    const runtime = createDeploymentTargetLinkHeaderV1();
    await account.createArtifactDocument({ artifactId: environment.contentArtifactId,
      header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Shop' }, body: '{}' });
    const content = { hostname: 'shop.example.test', target: { service: 'web', containerPort: 8080 }, healthCheck: { path: '/', expectStatus: 200 } };
    let domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: environment.id, targetLinkId: runtime.id,
      state: 'active', revision: 1, contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1,
      createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1, observedAtMs: 100,
      networkExposure: [{ machineId: 'machine-a', installationId: 'installation-a', nativeServer: 'https', listener: 'public',
        observation: { kind: 'unavailable', reason: 'route_absent' } }] });
    await account.createArtifactDocument({ artifactId: domain.contentArtifactId,
      header: { kind: 'deployment-domain.v1', title: 'Shop domain' }, body: JSON.stringify(content) });
    let inventoryReads = 0;
    let domainReads = 0;
    homes.answer(serverId, '/v1/deployments/environments', { select: () => {
      inventoryReads++;
      return { body: { ok: true, items: [environment], runtimeTargetLinks: [runtime], coverage: 'partial', nextCursor: 'next-environment' } };
    } });
    // The public Domain Action resolves the admitted Environment's Source before its read.
    homes.answer(serverId, `/v1/deployments/environments/${environment.id}`, {
      body: { ok: true, environment, targetLinks: [runtime] },
    });
    homes.answer(serverId, `/v1/deployments/environments/${environment.id}/domains`, { select: () => {
      domainReads++;
      return { body: DeploymentDomainListResultV1Schema.parse({ ok: true, environmentId: environment.id,
        revision: environment.revision, domains: [domain], nextCursor: 'next-domain' }) };
    } });
    const hook = await renderHook(({ enabled, needsManage }: { enabled: boolean; needsManage: boolean }) => {
      const input = { serverId, machineId: 'machine-a', facts: { posture: null, selections: null, observation: null },
        services: null, enabled, needsManage };
      return { left: useMachineNetworkExposure(input) };
    }, { initialProps: { enabled: true, needsManage: true } });
    try {
      await flushHookEffects();
      expect([inventoryReads, domainReads]).toEqual([0, 0]);
      await hook.rerender({ enabled: false, needsManage: false });
      expect([inventoryReads, domainReads]).toEqual([0, 0]);
      await hook.rerender({ enabled: true, needsManage: false });
      await vi.waitFor(() => expect(hook.getCurrent().left?.facts.domains, JSON.stringify({
        inventory: hook.getCurrent().left?.inventory.snapshot, domains: hook.getCurrent().left?.domains.snapshot,
        paths: homes.requests.map(request => request.path) }))
        .toMatchObject([{ state: 'unavailable', reason: 'route_absent' }]));
      expect(hook.getCurrent().left?.inventory.snapshot.value).toMatchObject({ coverage: 'partial', hasNextPage: true });
      expect(hook.getCurrent().left?.domains.hasNextPage).toBe(true);
      expect([inventoryReads, domainReads]).toEqual([1, 1]);
      const inventoryRequest = homes.requests.find(request => request.path.startsWith('/v1/deployments/environments?'));
      expect(new URLSearchParams(inventoryRequest?.path.split('?')[1]).get('machineId')).toBe('machine-a');
      const before = hook.getCurrent().left?.facts;
      await act(async () => publishHomeAccountChange(serverId, Array.from({ length: 100 }, (_, index) =>
        buildDeploymentAccountChangeV1({ environmentId: `elsewhere-${index}`, deploymentId: `receipt-${index}`, revision: 2 }).entityId),
      { changeKinds: ['account'] }));
      expect([inventoryReads, domainReads]).toEqual([1, 1]);
      expect(hook.getCurrent().left?.facts).toBe(before);
      domain = { ...domain, revision: 2, observedAtMs: 200 };
      await act(async () => publishHomeAccountChange(serverId, [buildDeploymentAccountChangeV1({
        environmentId: environment.id, revision: 2 }).entityId], { changeKinds: ['account'] }));
      await vi.waitFor(() => expect(hook.getCurrent().left?.facts.domains?.[0]?.observedAtMs).toBe(200));
      expect([inventoryReads, domainReads]).toEqual([2, 2]);
      await hook.rerender({ enabled: false, needsManage: false });
      await act(async () => publishHomeAccountChange(serverId, [buildDeploymentAccountChangeV1({
        environmentId: environment.id, revision: 3 }).entityId], { changeKinds: ['account'] }));
      expect([inventoryReads, domainReads]).toEqual([2, 2]);
    } finally { await hook.unmount(); account.dispose(); }
  });
});
