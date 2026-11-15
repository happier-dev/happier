import { UpdatesActionInputSchemas } from '@happier-dev/protocol/actions/updatesActionFamily';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { UpdatesGroup } from './buildMachineUpdateGroups';
import { isUpdateItemActionable, type UpdateItem } from './items/updateItem';
import { readUpdateBatch, runUpdateBatch, stopUpdateBatch } from './machineUpdateRuns';
import { getInstallablesRegistryEntries } from '@/capabilities/installablesRegistry';

export type UpdatesActionOwner = Readonly<{
    scope: ServerAccountScope | null;
    groups: readonly UpdatesGroup[];
    check: () => Promise<void>;
    executeItem: (item: UpdateItem) => Promise<void>;
}>;

// The mounted detail exposes its current selection, never another updater or batch store.
const owners = new Set<() => UpdatesActionOwner>();
export function registerUpdatesActionOwner(read: () => UpdatesActionOwner): () => void {
    owners.add(read);
    return () => { owners.delete(read); };
}

const unavailable = () => ({ ok: false as const, errorCode: 'update_target_unavailable', error: 'update_target_unavailable' });

export function readCurrentMachineUpdateItem(scope: ServerAccountScope, machineId: string,
    subject: Readonly<{ kind: 'agent-cli'; agentId: string }> | Readonly<{ kind: 'installable'; capabilityId: string }>): UpdateItem | null {
    const item = [...owners].map(read => read()).reverse()
        .filter(candidate => areServerAccountScopesEqual(candidate.scope, scope))
        .flatMap(owner => owner.groups.flatMap(group => group.items)).find(candidate => {
        if (candidate.machineId !== machineId) return false;
        if (subject.kind === 'agent-cli') return candidate.subject.kind === 'agent-cli' && candidate.subject.agentId === subject.agentId;
        if (candidate.subject.kind !== 'installable') return false;
        const key = candidate.subject.key;
        return getInstallablesRegistryEntries().some(entry => entry.key === key && entry.capabilityId === subject.capabilityId);
    });
    return item ?? null;
}

export function createUpdatesAction(account: LazyActionAccountContext | null | undefined): NonNullable<ActionExecutorDeps['updatesAction']> {
    return async ({ actionId, input, context }) => {
        if (!account) return unavailable();
        account.assertCurrent();
        context.signal?.throwIfAborted();
        const scope = account.accountLifetime.scope;
        if (actionId === 'updates.batch.stop') {
            stopUpdateBatch(scope);
            return { status: 'requested' };
        }
        const currentOwners = [...owners].map(read => read()).reverse().filter(candidate => areServerAccountScopesEqual(candidate.scope, scope));
        // The full Updates surface owns the Home-wide list and Check. A later
        // Machine tab supplies its target's rows without narrowing that owner.
        const owner = currentOwners.find(candidate => candidate.groups.some(group => group.kind === 'app')) ?? currentOwners[0];
        if (!owner) return unavailable();
        if (actionId === 'updates.get') {
            const installables = getInstallablesRegistryEntries();
            return {
                groups: owner.groups.map(group => ({
                groupId: group.id, machineName: group.machineName, online: group.online === true,
                target: group.kind === 'app' ? { kind: 'app' as const } : group.kind === 'thisComputer'
                    ? { kind: 'local' as const } : { kind: 'machine' as const, machineId: group.machineId },
                items: group.items.map(item => ({
                    itemId: item.id, title: item.title, subject: item.subject, state: item.state,
                    currentVersion: item.currentVersion, latestVersion: item.latestVersion,
                    managedBy: item.managedBy, action: item.action.kind === 'run' ? item.action.verb : null,
                    batchEligible: isUpdateItemActionable(item),
                    capabilityId: item.subject.kind === 'installable' ? (() => {
                        const key = item.subject.key;
                        return installables.find(entry => entry.key === key)?.capabilityId ?? null;
                    })() : null,
                    manualCommand: item.action.kind === 'manual' ? item.action.command : null, logPath: item.logPath ?? null,
                })),
                })),
                batch: readUpdateBatch(scope),
            };
        }
        if (actionId === 'updates.check') {
            await owner.check();
        } else if (actionId === 'machines.cli.update') {
            const { target } = UpdatesActionInputSchemas[actionId].parse(input);
            const matchesTarget = (candidate: UpdatesGroup) => target.kind === 'local'
                ? candidate.kind === 'thisComputer' : candidate.kind === 'machine' && candidate.machineId === target.machineId;
            const targetOwner = currentOwners.find(candidate => candidate.groups.some(matchesTarget));
            const group = targetOwner?.groups.find(matchesTarget);
            const item = group?.items.find(candidate => candidate.subject.kind === 'happier-cli');
            if (!targetOwner || !item || item.managedBy !== 'happier' || item.action.kind !== 'run'
                || item.action.verb !== 'update' && item.action.verb !== 'retry') return unavailable();
            // The owner selects Home payloads for managed guests and release
            // channels for standalone installs; displayed versions never pin a recipe.
            await targetOwner.executeItem(item);
        } else {
            const request = UpdatesActionInputSchemas['updates.batch.start'].parse(input);
            const group = request.groupId === null ? null : owner.groups.find(candidate => candidate.id === request.groupId);
            if (request.groupId !== null && !group) return unavailable();
            const candidates = group?.items ?? owner.groups.flatMap(candidate => candidate.items);
            const items = request.itemIds.map(itemId => candidates.find(candidate => candidate.id === itemId));
            if (items.some(item => !item || !isUpdateItemActionable(item))) return unavailable();
            // Reuse the batch's custody, overlap checks, Stop intent and per-machine order.
            await runUpdateBatch(scope, items.filter((item): item is UpdateItem => Boolean(item)), owner.executeItem, request.groupId);
        }
        return { status: 'requested' };
    };
}
