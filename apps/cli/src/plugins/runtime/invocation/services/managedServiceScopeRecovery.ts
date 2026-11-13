import { configuration } from '@/configuration';
import { parseHappierLinuxScopeName } from '@/daemon/platform/linux/systemdUserResourceGovernor';
import type { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import { equalProcessStart } from '@/daemon/processes/ownership/types';
import { resolveProcessOwnerScopeKey } from '@/processes/ownerTag';
import type { createProcessTreeTerminator } from '@/processes/terminate/terminateProcessTree';

type OwnershipRuntime = Pick<ReturnType<typeof createProcessOwnershipRuntime>, 'readOwners'>;
type OwnershipView = Extract<Awaited<ReturnType<OwnershipRuntime['readOwners']>>, { status: 'ok' }>;

/** Native inventory closes the gap left when a managed endpoint projection was removed. */
export async function retireProjectionFreeServiceScopes(input: Readonly<{
    view: OwnershipView;
    processOwnership: OwnershipRuntime;
    projectedInstances: ReadonlySet<string>;
    terminate: ReturnType<typeof createProcessTreeTerminator>;
}>): Promise<Readonly<{ retired: readonly number[]; incomplete: boolean }>> {
    const homeScope = resolveProcessOwnerScopeKey(configuration.happyHomeDir, 'linux');
    const scopes = new Map<string, string>();
    for (const row of input.view.snapshot.rows) {
        const parts = row.cgroup?.split('/') ?? [];
        for (let index = 0; index < parts.length; index++) {
            const tag = parseHappierLinuxScopeName(parts[index]!);
            if (tag?.daemonScopeKey === homeScope && tag.owner.kind === 'service'
                && !input.projectedInstances.has(tag.owner.serviceId)) {
                scopes.set(parts.slice(0, index + 1).join('/'), tag.owner.serviceId);
            }
        }
    }
    const retired: number[] = [];
    let incomplete = false;
    for (const [prefix, serviceId] of scopes) {
        const members = (view: OwnershipView) => view.snapshot.rows.filter(row => row.cgroup === prefix || row.cgroup?.startsWith(`${prefix}/`));
        const authorized = (view: OwnershipView) => {
            const owned = new Map(view.rows.map(row => [row.pid, row]));
            if (view.roots.some(root => root.live && root.owner.kind === 'service' && root.owner.serviceId === serviceId)) return false;
            const current = members(view);
            return current.length > 0 && current.every(row => {
                const proof = owned.get(row.pid);
                return row.state !== 'zombie' && proof?.level === 'left_behind' && proof.ownerEnded
                    && proof.owner?.kind === 'service' && proof.owner.serviceId === serviceId;
            });
        };
        if (!authorized(input.view)) continue;
        const targets = members(input.view).map(row => ({ pid: row.pid, start: row.start }));
        const result = await input.terminate({ targets, tree: false, policy: 'kill',
            containment: { kind: 'linux_unit', prefix },
            authorizeSignal: async () => {
                const view = await input.processOwnership.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
                return view.status === 'ok' && authorized(view) && members(view).every(row =>
                    targets.some(target => target.pid === row.pid && equalProcessStart(target.start, row.start)));
            },
        });
        if (result.status === 'complete') retired.push(...targets.map(target => target.pid));
        else incomplete = true;
    }
    return { retired, incomplete };
}
