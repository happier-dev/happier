import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { readSourceTeamId } from './sources/projectSourceGroups';

/**
 * The Projects tree's rows (plan 10 §2/§8, lab p-projects TREE/RULES): one Project's accepted
 * checkouts folded into the fewest levels that still tell them apart. The Project projection
 * (`buildProjectsListGroups`) decides WHICH checkouts belong to a Project and in what order; this
 * only decides how they are drawn.
 *
 * - One checkout: one row, never a disclosure ("MacBook Pro · main").
 * - One machine, many checkouts: the machine folds into the Project row; checkouts sit under it.
 * - Many machines, one checkout each: machines become the leaves and carry their checkout's label.
 * - Otherwise: Project → machine → checkout.
 *
 * Leaves always open an exact checkout (its ref id); parents only disclose.
 */
export type ProjectsTreeAttention = 'needs-you' | 'working' | null;

/** Compact observed checkout facts, shared by the tree and its live summary selector. */
export type ProjectsTreeCheckoutFacts = Readonly<{
    branch: string | null;
    isWorktree: boolean | null;
    attention: ProjectsTreeAttention;
    newFromSession: boolean;
}>;

export type ProjectsTreeCheckout = Readonly<{
    /** The exact checkout this leaf opens (a WorkspaceRef id). */
    refId: string;
    workspaceAddress?: WorkspaceAddressV1;
    machineId: string;
    machineName: string;
    /** Branch, or the checkout's folder name when its branch is not known. */
    label: string;
    /** Unknown SCM facts remain null; the display label may still use the folder. */
    branch?: string | null;
    isWorktree?: boolean | null;
    /** Home-relative display path ("~/src/happier-wt/fix-modal"). */
    path: string;
    attention: ProjectsTreeAttention;
    /** The machine is offline: the leaf stays, dimmed, last-known. */
    offline?: boolean;
}>;

export type ProjectsTreeProject = Readonly<{
    key: string;
    name: string;
    /** The Team a Team project is shared with ("Acme"), drawn quietly after the name. */
    teamLabel?: string | null;
    /** Accepted Session checkout not yet viewed through the existing device presentation owner. */
    newFromSession?: boolean;
    checkouts: readonly ProjectsTreeCheckout[];
}>;

export type ProjectsTreeRow = Readonly<{
    key: string;
    level: number;
    kind: 'project' | 'machine' | 'checkout';
    title: string;
    /** Quiet text on the title's line: the Team, the folded machine's name, or a machine leaf's label. */
    titleQualifier?: string | null;
    /** A second line: where a single checkout lives, or the open checkout's path. */
    subtitle?: string | null;
    /** The machine whose glyph a machine row (or a machine leaf) carries. */
    machineId?: string | null;
    /** Machine leaves draw the machine's glyph; checkout leaves under a machine draw a branch. */
    glyph: 'project' | 'machine' | 'branch';
    expandable: boolean;
    expanded: boolean;
    /** The ref a leaf opens. */
    refId?: string | null;
    workspaceAddress?: WorkspaceAddressV1;
    /** A collapsed parent's checkout count. */
    count?: number | null;
    /** The most urgent status beneath (a collapsed parent) or of this leaf. */
    attention: ProjectsTreeAttention;
    offline?: boolean;
    selected: boolean;
    /** Drawn through `projectsTreeRowSubtitle` as the row's second line. */
    newFromSession?: boolean;
}>;

/**
 * A row's second line (lab p-projects AUTO): a Project that arrived from a session and has not been
 * viewed yet leads with that, once, until it is opened. The column and the phone list both draw it.
 */
export function projectsTreeRowSubtitle(row: Pick<ProjectsTreeRow, 'subtitle' | 'newFromSession'>, newFromSessionLabel: string): string | null {
    if (row.newFromSession !== true) return row.subtitle ?? null;
    return [newFromSessionLabel, row.subtitle].filter((part): part is string => Boolean(part)).join(' · ');
}

function mostUrgent(checkouts: readonly ProjectsTreeCheckout[]): ProjectsTreeAttention {
    if (checkouts.some((checkout) => checkout.attention === 'needs-you')) return 'needs-you';
    if (checkouts.some((checkout) => checkout.attention === 'working')) return 'working';
    return null;
}

/** Full-address keys prevent a tree leaf from choosing a different checkout with the same id. */
export function projectsTreeCheckoutKey(checkout: Readonly<{ refId: string; workspaceAddress?: WorkspaceAddressV1 }>): string {
    const address = checkout.workspaceAddress;
    return address ? JSON.stringify([address.serverId, address.machineId, address.rootPath, address.workspaceId]) : checkout.refId;
}

function groupByMachine(checkouts: readonly ProjectsTreeCheckout[]): ProjectsTreeCheckout[][] {
    const groups = new Map<string, ProjectsTreeCheckout[]>();
    for (const checkout of checkouts) {
        const group = groups.get(checkout.machineId);
        if (group) group.push(checkout);
        else groups.set(checkout.machineId, [checkout]);
    }
    return [...groups.values()];
}

/**
 * `expandedKeys` / `collapsedKeys`: the person's own disclosure (device-local presentation). A
 * parent holding the open checkout opens by default so the open checkout is always visible; others
 * stay as they were left.
 */
export function buildProjectsTreeRows(input: Readonly<{
    projects: readonly ProjectsTreeProject[];
    openRefId: string | null;
    expandedKeys: ReadonlySet<string>;
    collapsedKeys?: ReadonlySet<string>;
}>): ProjectsTreeRow[] {
    const rows: ProjectsTreeRow[] = [];
    const isOpen = (key: string, holdsOpen: boolean) => (
        input.collapsedKeys?.has(key) === true ? false : input.expandedKeys.has(key) || holdsOpen
    );
    const leaf = (
        checkout: ProjectsTreeCheckout,
        level: number,
        key: string,
        title: string,
        qualifier: string | null,
        glyph: ProjectsTreeRow['glyph'],
    ): ProjectsTreeRow => {
        const selected = checkout.refId === input.openRefId;
        return {
            key,
            level,
            kind: 'checkout',
            title,
            titleQualifier: qualifier,
            // Only the open checkout shows where it lives; the rest stay one line.
            subtitle: selected ? checkout.path : null,
            machineId: checkout.machineId,
            glyph,
            expandable: false,
            expanded: false,
            refId: checkout.refId,
            workspaceAddress: checkout.workspaceAddress,
            attention: checkout.attention,
            offline: checkout.offline,
            selected,
        };
    };

    for (const project of input.projects) {
        const checkouts = project.checkouts;
        if (checkouts.length === 0) continue;
        const holdsOpen = checkouts.some((checkout) => checkout.refId === input.openRefId);
        const machines = groupByMachine(checkouts);

        if (checkouts.length === 1) {
            const only = checkouts[0]!;
            const selected = only.refId === input.openRefId;
            rows.push({
                key: project.key,
                level: 0,
                kind: 'project',
                title: project.name,
                titleQualifier: project.teamLabel ?? null,
                subtitle: selected ? `${only.machineName} · ${only.path}` : `${only.machineName} · ${only.label}`,
                machineId: only.machineId,
                glyph: 'project',
                expandable: false,
                expanded: false,
                refId: only.refId,
                workspaceAddress: only.workspaceAddress,
                attention: only.attention,
                offline: only.offline,
                selected,
                newFromSession: project.newFromSession === true,
            });
            continue;
        }

        const projectOpen = isOpen(project.key, holdsOpen);
        const singleMachine = machines.length === 1;
        rows.push({
            key: project.key,
            level: 0,
            kind: 'project',
            title: project.name,
            // One machine: it folds into the Project row ("happier-plugins devbox").
            titleQualifier: singleMachine
                ? [project.teamLabel, machines[0]![0]!.machineName].filter(Boolean).join(' · ')
                : project.teamLabel ?? null,
            subtitle: null,
            machineId: null,
            glyph: 'project',
            expandable: true,
            expanded: projectOpen,
            refId: null,
            count: projectOpen ? null : checkouts.length,
            attention: projectOpen ? null : mostUrgent(checkouts),
            selected: false,
            newFromSession: project.newFromSession === true,
        });
        if (!projectOpen) continue;

        if (singleMachine) {
            for (const checkout of checkouts) rows.push(leaf(checkout, 1, `${project.key}/${projectsTreeCheckoutKey(checkout)}`, checkout.label, null, 'branch'));
            continue;
        }
        if (machines.every((group) => group.length === 1)) {
            // Many machines, one checkout each: the machine is the leaf and carries its label.
            for (const [checkout] of machines) {
                rows.push(leaf(checkout!, 1, `${project.key}/${projectsTreeCheckoutKey(checkout!)}`, checkout!.machineName, checkout!.label, 'machine'));
            }
            continue;
        }
        for (const group of machines) {
            const machine = group[0]!;
            const machineKey = `${project.key}/${machine.machineId}`;
            if (group.length === 1) {
                rows.push(leaf(machine, 1, `${machineKey}/${projectsTreeCheckoutKey(machine)}`, machine.machineName, machine.label, 'machine'));
                continue;
            }
            const machineOpen = isOpen(machineKey, group.some((checkout) => checkout.refId === input.openRefId));
            rows.push({
                key: machineKey,
                level: 1,
                kind: 'machine',
                title: machine.machineName,
                subtitle: null,
                machineId: machine.machineId,
                glyph: 'machine',
                expandable: true,
                expanded: machineOpen,
                refId: null,
                count: machineOpen ? null : group.length,
                attention: machineOpen ? null : mostUrgent(group),
                offline: group.every((checkout) => checkout.offline === true),
                selected: false,
            });
            if (!machineOpen) continue;
            for (const checkout of group) rows.push(leaf(checkout, 2, `${machineKey}/${projectsTreeCheckoutKey(checkout)}`, checkout.label, null, 'branch'));
        }
    }
    return rows;
}

/** What the tree needs of a machine: its name, home and presence (Machine rows own these facts). */
export type ProjectsTreeMachineFacts = Readonly<{ name: string; homeDir: string | null; online: boolean }>;

function folderName(rootPath: string): string {
    const parts = rootPath.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    return parts.at(-1) ?? rootPath;
}

/**
 * The Project projection's groups (`projectProjectListV1`, in their order) as tree input: a Project is
 * named after its checkout the person sees first; each checkout keeps its exact ref.
 */
export function buildProjectsTreeProjects<TRef extends Readonly<{
    id: string; serverId?: string; machineId: string; rootPath: string;
    label?: string | null; source?: Readonly<{ sourceId: string }>;
}>>(input: Readonly<{
    groups: ReadonlyArray<Readonly<{ projectKey: Readonly<{ projectKey: string }>; items: readonly TRef[] }>>;
    projectName: (ref: TRef) => string;
    machine: (machineId: string) => ProjectsTreeMachineFacts | null;
    /** Only current authorized catalog rows from the same Home/Account as these accepted refs. */
    sources?: readonly Pick<ProjectSourceV1, 'id' | 'name' | 'audience'>[];
    teamName?: (teamId: string) => string | null;
    checkoutFacts?: (ref: TRef) => ProjectsTreeCheckoutFacts | null;
}>): ProjectsTreeProject[] {
    return input.groups.flatMap((group) => {
        const first = group.items[0];
        if (!first) return [];
        const sourceIds = new Set(group.items.flatMap(ref => ref.source ? [ref.source.sourceId] : []));
        const source = sourceIds.size === 1
            ? input.sources?.find(candidate => sourceIds.has(candidate.id)) ?? null
            : null;
        const teamId = source ? readSourceTeamId(source) : null;
        let newFromSession = false;
        const checkouts = group.items.map((ref): ProjectsTreeCheckout => {
            const machine = input.machine(ref.machineId);
            const facts = input.checkoutFacts?.(ref) ?? null;
            if (facts?.newFromSession) newFromSession = true;
            return {
                refId: ref.id,
                ...(ref.serverId ? { workspaceAddress: { serverId: ref.serverId, workspaceId: ref.id,
                    machineId: ref.machineId, rootPath: ref.rootPath } } : {}),
                machineId: ref.machineId,
                machineName: machine?.name ?? ref.machineId,
                label: facts?.branch ?? folderName(ref.rootPath),
                branch: facts?.branch ?? null,
                isWorktree: facts?.isWorktree ?? null,
                path: formatPathRelativeToHome(ref.rootPath, machine?.homeDir ?? undefined),
                attention: facts?.attention ?? null,
                offline: machine ? !machine.online : undefined,
            };
        });
        return [{
            key: group.projectKey.projectKey,
            name: first.label?.trim() ? input.projectName(first) : source?.name ?? input.projectName(first),
            teamLabel: teamId ? input.teamName?.(teamId) ?? null : null,
            newFromSession,
            checkouts,
        }];
    });
}

/**
 * The phone tree (plan 10 §2 Phone, lab p-projects TREEp): two levels instead of three — a Project, and
 * under it each checkout as one "Machine · label" leaf. A Project row says where it lives in its second
 * line: its one checkout, its one machine's checkout count, or how many machines (and how many offline).
 */
export function buildProjectsPhoneTreeRows(input: Readonly<{
    projects: readonly ProjectsTreeProject[];
    openRefId: string | null;
    expandedKeys: ReadonlySet<string>;
    collapsedKeys?: ReadonlySet<string>;
    describe: Readonly<{
        checkoutCount: (count: number) => string;
        machineCount: (count: number) => string;
        offlineCount: (count: number) => string;
    }>;
}>): ProjectsTreeRow[] {
    const rows: ProjectsTreeRow[] = [];
    for (const project of input.projects) {
        const checkouts = project.checkouts;
        if (checkouts.length === 0) continue;
        const machines = groupByMachine(checkouts);
        const holdsOpen = checkouts.some((checkout) => checkout.refId === input.openRefId);
        const single = checkouts.length === 1 ? checkouts[0]! : null;
        const offlineMachines = machines.filter((group) => group.every((checkout) => checkout.offline === true)).length;
        const subtitle = single
            ? `${single.machineName} · ${single.label}`
            : machines.length === 1
                ? `${machines[0]![0]!.machineName} · ${input.describe.checkoutCount(checkouts.length)}`
                : [input.describe.machineCount(machines.length), offlineMachines > 0 ? input.describe.offlineCount(offlineMachines) : null]
                    .filter((part): part is string => part !== null).join(' · ');
        const expanded = !single && (input.collapsedKeys?.has(project.key) === true
            ? false
            : input.expandedKeys.has(project.key) || holdsOpen);
        rows.push({
            key: project.key,
            level: 0,
            kind: 'project',
            title: project.name,
            titleQualifier: project.teamLabel ?? null,
            subtitle,
            machineId: single?.machineId ?? null,
            glyph: 'project',
            expandable: !single,
            expanded,
            refId: single?.refId ?? null,
            workspaceAddress: single?.workspaceAddress,
            count: single ? null : checkouts.length,
            attention: single ? single.attention : expanded ? null : mostUrgent(checkouts),
            offline: single?.offline,
            selected: single?.refId === input.openRefId,
            newFromSession: project.newFromSession === true,
        });
        if (!expanded) continue;
        for (const checkout of checkouts) {
            rows.push({
                key: `${project.key}/${projectsTreeCheckoutKey(checkout)}`,
                level: 1,
                kind: 'checkout',
                title: checkout.machineName,
                titleQualifier: checkout.label,
                subtitle: checkout.path,
                machineId: checkout.machineId,
                glyph: 'machine',
                expandable: false,
                expanded: false,
                refId: checkout.refId,
                workspaceAddress: checkout.workspaceAddress,
                attention: checkout.attention,
                offline: checkout.offline,
                selected: checkout.refId === input.openRefId,
            });
        }
    }
    return rows;
}
