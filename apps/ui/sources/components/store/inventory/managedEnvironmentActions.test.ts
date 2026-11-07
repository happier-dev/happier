import { afterEach, expect, it } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentListResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');

afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); });

it('lets an agent list an exact Machine then get only the returned qualified Environment through existing Actions', async () => {
    const identity = 'srv_inventory_environment_agent';
    const home = await account.restore({ serverIdentityId: identity, machines: [] });
    const scope = storage.getState().settingsScope!;
    const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: identity }) });
    const root = '/v1/deployments/environments';
    account.home.answer(home.serverId, `GET ${root}`, { select: (_input, request) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('machineId')).toBe('machine-a');
        return { body: { ok: true, items: [detail.environment], nextCursor: 'unrequested-next-page' } };
    } });
    account.home.answer(home.serverId, `GET ${root}/${detail.environment.id}`, { body: {
        ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(link => link.targetLink),
    } });
    const executor = createDefaultActionExecutor();
    const context = { surface: 'agent' as const, serverId: scope.serverId, runtimeAccountId: scope.accountId };
    const before = account.home.requests.length;
    const listed = await executor.execute('deployments.environments.list', { serverId: home.serverId, machineId: 'machine-a' }, context);
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(listed.errorCode);
    const page = DeploymentEnvironmentListResultV1Schema.parse(listed.result);
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error(page.error);
    expect(page.items).toHaveLength(1);
    expect(account.home.requests.slice(before).filter(request => request.path.startsWith(root))).toHaveLength(1);
    const selected = page.items[0]!;
    const read = await executor.execute('deployments.environments.get', { serverId: selected.serverId, environmentId: selected.id }, context);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.errorCode);
    expect(DeploymentEnvironmentGetResultV1Schema.parse(read.result)).toMatchObject({ ok: true,
        environment: { id: selected.id, projectSourceId: selected.projectSourceId, serverId: identity } });
    const reads = account.home.requests.slice(before);
    // The front door also resolves the selected resource for authority. Every such read must stay
    // on that one returned identity; membership above was decided by the single list alone.
    expect([...new Set(reads.filter(request => request.path.startsWith(root)).map(request => request.path.split('?')[0]))])
        .toEqual([root, `${root}/${selected.id}`]);
    expect(reads.filter(request => request.path === '/v1/artifacts/read')).toHaveLength(0);
    expect(rpc.state.requests).toHaveLength(0);
});
