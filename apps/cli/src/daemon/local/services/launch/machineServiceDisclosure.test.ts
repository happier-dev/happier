import { expect, it, vi } from 'vitest';
import { readSettings, type Settings } from '@/persistence';
import { selectVisibleMachineProjectServices } from './machineServiceDisclosure';

vi.mock('@/persistence', async importOriginal => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readSettings: vi.fn(),
}));

const target = { serverId: 'srv_owner_home', machineId: 'machine' };
const profile = (id: string, homeServerIdentityId: string): NonNullable<Settings['servers']>[string] => {
    const url = `https://${id}.example.test`;
    return {
        id, name: id, serverUrl: url, webappUrl: url, createdAt: 1, updatedAt: 1,
        homeConnectionDescriptor: { v: 1, homeServerIdentityId, canonicalServerUrl: url, revision: 1,
            endpoints: [{ kind: 'https', url }] },
    };
};
const service = (index: number, serverId: string) => ({
    kind: 'environment' as const, machineId: target.machineId, serverId, environmentId: `environment-${index}`,
    serviceId: `service-${index}`, isCurrent: () => true, retirementSignal: new AbortController().signal,
});

it('admits the Home aliases and Environment set once for a Machine list across 500 rows', async () => {
    const servers = { owner: profile('owner', target.serverId), other: profile('other', 'srv_other_home') };
    const settings = vi.mocked(readSettings);
    settings.mockReset().mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true, servers });
    const owned = Array.from({ length: 500 }, (_, index) => service(index, 'owner'));
    const admitted = owned.slice(1);
    const canReadEnvironments = vi.fn(async (ids: readonly string[]) => new Set(ids.slice(1)));

    const visible = await selectVisibleMachineProjectServices(target, [
        service(501, 'other'), ...owned, service(502, 'unknown'),
    ], { canReadEnvironments });

    expect(visible).toEqual(admitted);
    expect(canReadEnvironments.mock.calls).toEqual([[
        owned.map(row => row.environmentId),
    ]]);
    expect(settings, 'read the Home profile snapshot once for the admitted list').toHaveBeenCalledTimes(1);

    settings.mockClear();
    const exact = service(503, target.serverId);
    await expect(selectVisibleMachineProjectServices(target, [exact], {
        canReadEnvironments: async ids => new Set(ids),
    })).resolves.toEqual([exact]);
    expect(settings, 'exact Home identity needs no profile snapshot').not.toHaveBeenCalled();

    const otherAlias = profile('duplicate', target.serverId);
    settings.mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true, servers: { ...servers, duplicate: otherAlias } });
    canReadEnvironments.mockClear();
    await expect(selectVisibleMachineProjectServices(target, owned, { canReadEnvironments })).resolves.toEqual([]);
    expect(canReadEnvironments, 'ambiguous Home aliases cannot reach Environment disclosure').not.toHaveBeenCalled();
});
