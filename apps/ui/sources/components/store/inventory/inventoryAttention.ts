import type { useInboxArtifactItems } from '@/hooks/inbox/useInboxArtifactSource';
import type { MachineNeedingAttention } from '@/components/machines/attention/useMachinesNeedingAttention';
import type { CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import type { SkillNeedsALookEntry } from '@/components/settings/skills/status/skillStatus';
import type { StoreInstalledInput } from '../catalog/storeKinds';
import type { ManagedInventoryRow as InstalledRow } from './useManagedInventory';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ProviderConnectionPresentationStatus } from '@/providers/connection/presentation';
import type { AgentCollectionRow } from '@/components/settings/agents/collection/agentCollectionModel';
import { projectAccountNoticeInboxItemV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { resolveInboxNoticePageRoute } from '@/components/inbox/inboxItemFocus';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { presentInventoryRow } from './inventoryRows';

export type ManagedInventoryAttention =
    | Readonly<{ kind: 'notice'; key: string; row?: InstalledRow; native: ReturnType<typeof useInboxArtifactItems>['openAccountNotices'][number]; href: string }>
    | Readonly<{ kind: 'machine'; key: string; native: MachineNeedingAttention; href: string }>
    | Readonly<{ kind: 'capability'; key: string; row?: InstalledRow; scope: ServerAccountScope;
        native: CapabilityStatus | SkillNeedsALookEntry | Readonly<{ kind: 'provider'; status: ProviderConnectionPresentationStatus }>
            | Readonly<{ kind: 'agent'; value: AgentCollectionRow }>;
        href: string }>;

export function collectManagedInventoryAttention(input: Readonly<{
    query: StoreInstalledInput;
    rows: readonly InstalledRow[];
    notices: ReturnType<typeof useInboxArtifactItems>['openAccountNotices'];
    machines: readonly MachineNeedingAttention[];
    capabilities: readonly Extract<ManagedInventoryAttention, { kind: 'capability' }>[];
}>): readonly ManagedInventoryAttention[] {
    const { query } = input;
    if (!query.scope) return [];
    const scope = query.scope;
    const rows = input.rows;
    const placements = query.projectKey ? rows.map(row => presentInventoryRow(row, query)) : [];
    const admittedMachine = (serverId: string, machineId: string) => areServerProfileIdentifiersEquivalent(serverId, scope.serverId)
        && (!query.machine || query.machine.machineId === machineId
            && areServerProfileIdentifiersEquivalent(query.machine.serverIdentityId, serverId))
        && (!query.projectKey || placements.some(row => row.machines?.some(machine => machine.machineId === machineId
            && areServerProfileIdentifiersEquivalent(machine.serverIdentityId, serverId))));
    const attention: ManagedInventoryAttention[] = [...input.capabilities];
    for (const native of input.notices) {
        const { header, artifact } = native;
        const serverId = artifact.sourceServerId ?? scope.serverId;
        if (!areServerProfileIdentifiersEquivalent(serverId, scope.serverId)) continue;
        const source = header.source;
        const row = source.kind === 'plugin' ? rows.find(row => row.kind === 'plugin' && row.native.pluginId === source.pluginId) : undefined;
        const page = header.page;
        const belongs = source.kind === 'plugin'
            ? row !== undefined
            : source.topic === 'resource_limit' && header.notice?.topic === 'resource_limit'
                ? admittedMachine(serverId, header.notice.machineId)
                : source.topic === 'service_health' && page && 'kind' in page && page.page === 'machine_service'
                    && areServerProfileIdentifiersEquivalent(page.machine.serverId, serverId)
                    && admittedMachine(serverId, page.machine.machineId);
        if (!belongs) continue;
        const href = resolveInboxNoticePageRoute(artifact.id, header, serverId);
        const item = projectAccountNoticeInboxItemV1({ artifactId: artifact.id, serverId,
            createdAt: artifact.createdAt, header, pageRoute: href });
        if (item?.view === 'needs_you') attention.push({ kind: 'notice', key: item.key, ...(row ? { row } : {}), native, href });
    }
    for (const native of input.machines) {
        if (!admittedMachine(native.serverId, native.machineId)) continue;
        attention.push({ kind: 'machine', key: `machine:${native.serverId}:${native.machineId}`, native,
            href: machinePageHref({ door: 'rail', target: native, ...(native.tab ? { tab: native.tab } : {}) }) });
    }
    return attention;
}


type MachineAttention = Extract<ManagedInventoryAttention, { kind: 'machine' }>;
/** A line of Needs you: one condition, or one Machine reason with one fix said once for every Machine it holds on. */
export type ManagedInventoryAttentionLine =
    | Readonly<{ kind: 'one'; entry: ManagedInventoryAttention }>
    | Readonly<{ kind: 'group'; key: string; word: string; actionLabel: string; entries: readonly MachineAttention[] }>;

/**
 * Machines that share a reason and its fix are one line at the first one's place ("Short on memory · 13 machines"),
 * the way the fleet sentence says a shared reason once; each Machine stays one step away inside it. Every other
 * condition keeps its own line and order.
 */
export function groupManagedInventoryAttention(attention: readonly ManagedInventoryAttention[]): readonly ManagedInventoryAttentionLine[] {
    const shared = new Map<string, MachineAttention[]>();
    for (const entry of attention) {
        if (entry.kind !== 'machine') continue;
        const key = `${entry.native.word}\u0000${entry.native.actionLabel}`;
        const entries = shared.get(key);
        if (entries) entries.push(entry); else shared.set(key, [entry]);
    }
    const lines: ManagedInventoryAttentionLine[] = [];
    for (const entry of attention) {
        if (entry.kind !== 'machine') { lines.push({ kind: 'one', entry }); continue; }
        const entries = shared.get(`${entry.native.word}\u0000${entry.native.actionLabel}`)!;
        if (entries.length < 2) lines.push({ kind: 'one', entry });
        else if (entries[0] === entry) lines.push({ kind: 'group', key: `machines:${entry.key}`, word: entry.native.word,
            actionLabel: entry.native.actionLabel, entries });
    }
    return lines;
}
