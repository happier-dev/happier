import * as React from 'react';
import { useInboxArtifactItems, useInboxArtifactSource } from '@/hooks/inbox/useInboxArtifactSource';
import { useMachinesNeedingAttention } from '@/components/machines/attention/useMachinesNeedingAttention';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { useSetting } from '@/sync/store/hooks';
import { useHeldMcpServerMachineTests } from '@/components/settings/mcpServers/status/useMcpServerMachineTests';
import { findMcpSignInGrant, mcpSignInGrantView, mcpSignInFact } from '@/components/settings/mcpServers/signIn/mcpSignInGrantView';
import { mcpServerAttentionStatus } from '@/components/settings/mcpServers/status/mcpServerStatus';
import { mcpServerRoute } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { getSavedSecretCatalogSnapshot, resolveSavedSecretReference,
    subscribeSavedSecretCatalogSnapshots } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { buildSkillsNeedsALook } from '@/components/settings/skills/status/skillStatus';
import { maskedLibraryNames } from '@/components/settings/skills/found/foundSkillsModel';
import { skillHref } from '@/components/settings/skills/skillsCollectionModel';
import { useFoundSkillsCache } from '@/sync/domains/skills/useFoundSkills';
import { presentProviderConnection, providerConnectionNeedsAttention } from '@/providers/connection/presentation';
import { providerConnectionDetailRoute } from '@/components/settings/providers/collection/providerCollectionModel';
import { collectManagedInventoryAttention, type ManagedInventoryAttention } from './inventoryAttention';
import type { ManagedInventoryFamilies, ManagedInventoryQuery } from './useManagedInventory';
import type { ManagedInventoryRow as InstalledRow } from './useManagedInventory';
import { useMachineAgentsByMachine } from '@/agents/machineAgents/useMachineAgents';
import { getResolvedAgentCatalogEntries } from '@/agents/backendCatalog/agentCatalogProjection';
import { buildAgentCollection } from '@/components/settings/agents/collection/agentCollectionModel';
import { presentInventoryRow } from './inventoryRows';
import { useReachMachines } from '@/sync/domains/capabilities/reach/useReachProjection';

const NO_NOTICES: ReturnType<typeof useInboxArtifactItems>['openAccountNotices'] = [];
function sameScope(left: ServerAccountScope | null | undefined, right: ServerAccountScope | null | undefined): boolean {
    return Boolean(left && right && left.accountId === right.accountId
        && areServerProfileIdentifiersEquivalent(left.serverId, right.serverId));
}

/** Read held, admitted source facts. No Test, sign-in, Secret acquisition, Found scan or Inbox mutation. */
export function useManagedInventoryAttention(query: ManagedInventoryQuery, families: ManagedInventoryFamilies, rows: readonly InstalledRow[],
    scope: ServerAccountScope | null) {
    const source = useInboxArtifactSource();
    const items = useInboxArtifactItems();
    const machineAttention = useMachinesNeedingAttention();
    const profileScope = storage(state => state.profileScope);
    const grants = storage(state => state.profile.connectedAccountsV4);
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const tests = useHeldMcpServerMachineTests();
    const readSecrets = React.useCallback(() => getSavedSecretCatalogSnapshot(scope), [scope]);
    const secrets = React.useSyncExternalStore(subscribeSavedSecretCatalogSnapshots, readSecrets, readSecrets);
    const machineIds = React.useMemo(() => [...new Set(families.skill.rows.flatMap(row => row.reach.map(place => place.machineId)))], [families.skill.rows]);
    // Names and presence only for the Machines the rows place: other Machines opening redraw nothing here.
    const placedMachineIds = React.useMemo(() => [...machineIds, ...families.mcpServer.rows.flatMap(row => row.reach.map(place => place.machineId))],
        [machineIds, families.mcpServer.rows]);
    const reach = useReachMachines({ machineIds: placedMachineIds });
    const found = useFoundSkillsCache(machineIds, scope);
    const agentMachineIds = React.useMemo(() => [...new Set(families.agent.rows.flatMap(row => row.subject === 'machineAgent' ? row.machineIds : []))],
        [families.agent.rows]);
    const agentFacts = useMachineAgentsByMachine({ serverId: scope?.serverId ?? '', machineIds: agentMachineIds, load: false });
    const capabilities = React.useMemo(() => {
        const result: Extract<ManagedInventoryAttention, { kind: 'capability' }>[] = [];
        if (!scope) return result;
        const activeFacts = sameScope(profileScope, scope);
        // S40 owns membership. The existing Reach presentation owner supplies
        // only current presence/names for those already admitted placements.
        const machines = new Map(sameScope(reach.scope, scope) ? reach.machines.map(machine => [machine.machineId, machine]) : []);
        for (const row of families.mcpServer.rows) {
            const signIn = activeFacts ? mcpSignInFact(mcpSignInGrantView(row.native, findMcpSignInGrant(grants, row.native.id), null)) : null;
            const status = mcpServerAttentionStatus({ entry: row.native, signIn,
                savedSecretCatalog: { resolveReference: ref => resolveSavedSecretReference(scope, [], ref) },
                tests: activeFacts ? tests.get(row.native.id) ?? {} : {},
                machines: row.reach.filter(place => place.agents.some(agent => agent.enabled)).map(place => ({
                    machineId: place.machineId, name: machines.get(place.machineId)?.name ?? place.machineId,
                    online: machines.get(place.machineId)?.online ?? place.online,
                })),
            });
            if (status) result.push({ kind: 'capability', key: `${row.key}:${status.kind}`, row, scope,
                native: status, href: mcpServerRoute(row.native.id) });
        }
        const coverage = families.skill.coverage;
        const reason = typeof coverage === 'object' ? 'partial' in coverage ? coverage.partial : coverage.unavailable : null;
        const unavailable = reason && typeof reason === 'object' && 'unavailableItems' in reason ? reason.unavailableItems ?? [] : [];
        const masked = maskedLibraryNames(machineIds.map(machineId => ({ machineId, name: machines.get(machineId)?.name ?? null })), found);
        const skills = buildSkillsNeedsALook(families.skill.rows.map(row => row.native), unavailable, masked);
        const bySkill = new Map(families.skill.rows.map(row => [row.native.skillId, row]));
        for (const native of skills) {
            const row = bySkill.get(native.key);
            // Unreadable source-owned attention is not a fabricated installed row.
            result.push({ kind: 'capability', key: `${row?.key ?? serverAccountScopedResourceKey(scope, 'skill', native.key)}:${native.kind}`,
                ...(row ? { row } : {}), scope, native, href: skillHref(native.key) });
        }
        for (const row of families.provider.rows) {
            const native = presentProviderConnection(row.view);
            if (providerConnectionNeedsAttention(native.status)) result.push({ kind: 'capability', key: `${row.key}:${native.status}`,
                row, scope, native: { kind: 'provider', status: native.status }, href: providerConnectionDetailRoute(row.native.id) });
        }
        const entries = getResolvedAgentCatalogEntries({ enabledAgentIds: [], backendEnabledByTargetKey });
        for (const machineId of activeFacts ? agentMachineIds : []) {
            const agents = agentFacts.get(machineId)?.agents ?? [];
            const native = buildAgentCollection({ entries, agents, query: '' });
            for (const value of native.onMachine) {
                if (!value.trouble) continue;
                const row = families.agent.rows.find(row => row.subject === 'machineAgent' && row.machineIds.includes(machineId) && row.native === value.entry.agentId);
                if (!row) continue;
                const serverIdentityId = getServerProfileById(scope.serverId)?.serverIdentityId;
                const home = presentInventoryRow(row, { ...query,
                    ...(serverIdentityId ? { machine: { serverIdentityId, machineId } } : {}) }).home;
                if (typeof home.href !== 'string') continue;
                result.push({ kind: 'capability', key: `${row.key}:${machineId}:${value.status}`, row, scope,
                    native: { kind: 'agent', value }, href: home.href });
            }
        }
        return result;
    }, [agentFacts, agentMachineIds, backendEnabledByTargetKey, families.agent.rows, families.mcpServer.rows, families.skill, families.provider.rows,
        found, grants, machineIds, profileScope, query, reach, scope, secrets, tests]);
    const notices = sameScope(source.scope, scope) ? items.openAccountNotices : NO_NOTICES;
    const attention = React.useMemo(() => scope ? collectManagedInventoryAttention({ query, rows,
        notices, machines: machineAttention, capabilities }) : [], [capabilities, machineAttention, notices, query, rows, scope]);
    return { attention, noticeSource: sameScope(source.scope, scope) ? source : null };
}
