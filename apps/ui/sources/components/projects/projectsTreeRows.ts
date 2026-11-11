import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { readSourceTeamId } from './sources/projectSourceGroups';
import { shallow } from 'zustand/vanilla/shallow';

/**
 * The Projects tree's rows (plan 10 §2/§8, lab p-projects TREE/RULES): one Project's accepted
 * checkouts folded into the fewest levels that still tell them apart. The Project projection
 * (`buildProjectsListGroups`) decides WHICH checkouts belong to a Project and in what order; this
 * only decides how they are drawn.
 *
 * - One checkout: one row, never a disclosure ("MacBook Pro · main").
 * - One machine, many checkouts: the machine folds into the Project row; checkouts sit under it.
 * - Many machines, one checkout each: the checkouts sit directly under the Project.
 * - Otherwise: Project → machine → checkout.
 *
 * Leaves open an exact checkout (its ref id). A Project row is the Project: its press opens the Project on
 * its most recently opened checkout, and only its chevron discloses (owner 11-08). A machine row only discloses.
 * Every checkout leaf reads like a one-checkout Project row: its label, then where it lives ("NLDW3 · ~/code/x";
 * under a machine row, the path alone).
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
    /** Which checkout a press on the Project opens: the one opened most recently (default: the first). */
    lead?: number;
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
    /** The exact checkout this row stands for (a leaf, or a one-checkout Project): its menu acts on it. */
    refId?: string | null;
    workspaceAddress?: WorkspaceAddressV1;
    /** A Project row with several checkouts: the checkout its press opens. Read through `projectsTreeRowOpenTarget`. */
    opens?: ProjectsTreeOpenTarget | null;
    /** A collapsed parent's checkout count. */
    count?: number | null;
    /** The most urgent status beneath (a collapsed parent) or of this leaf. */
    attention: ProjectsTreeAttention;
    offline?: boolean;
    selected: boolean;
    /** Drawn through `projectsTreeRowSubtitle` as the row's second line. */
    newFromSession?: boolean;
}>;

export type ProjectsTreeOpenTarget = Readonly<{ refId: string; workspaceAddress?: WorkspaceAddressV1 }>;

/** What a press (or Enter) on a row opens; `null` for a row that only discloses (a machine). */
export function projectsTreeRowOpenTarget(row: Pick<ProjectsTreeRow, 'refId' | 'workspaceAddress' | 'opens'>): ProjectsTreeOpenTarget | null {
    if (row.refId) return row.workspaceAddress ? { refId: row.refId, workspaceAddress: row.workspaceAddress } : { refId: row.refId };
    return row.opens ?? null;
}

function projectOpenTarget(project: ProjectsTreeProject): ProjectsTreeOpenTarget | null {
    const lead = project.checkouts[project.lead ?? 0] ?? project.checkouts[0];
    if (!lead) return null;
    return lead.workspaceAddress ? { refId: lead.refId, workspaceAddress: lead.workspaceAddress } : { refId: lead.refId };
}

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
    const leaf = (checkout: ProjectsTreeCheckout, level: number, key: string, underMachine: boolean): ProjectsTreeRow => {
        const selected = checkout.refId === input.openRefId;
        return {
            key,
            level,
            kind: 'checkout',
            title: checkout.label,
            titleQualifier: null,
            subtitle: underMachine ? checkout.path : `${checkout.machineName} · ${checkout.path}`,
            machineId: checkout.machineId,
            glyph: 'branch',
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
                subtitle: `${only.machineName} · ${selected ? only.path : checkoutWhere(only)}`,
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
            opens: projectOpenTarget(project),
            count: projectOpen ? null : checkouts.length,
            attention: projectOpen ? null : mostUrgent(checkouts),
            selected: false,
            newFromSession: project.newFromSession === true,
        });
        if (!projectOpen) continue;

        if (singleMachine) {
            for (const checkout of checkouts) rows.push(leaf(checkout, 1, `${project.key}/${projectsTreeCheckoutKey(checkout)}`, false));
            continue;
        }
        if (machines.every((group) => group.length === 1)) {
            // Many machines, one checkout each: no machine level; each checkout names its machine.
            for (const [checkout] of machines) rows.push(leaf(checkout!, 1, `${project.key}/${projectsTreeCheckoutKey(checkout!)}`, false));
            continue;
        }
        for (const group of machines) {
            const machine = group[0]!;
            const machineKey = `${project.key}/${machine.machineId}`;
            if (group.length === 1) {
                rows.push(leaf(machine, 1, `${machineKey}/${projectsTreeCheckoutKey(machine)}`, false));
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
            for (const checkout of group) rows.push(leaf(checkout, 2, `${machineKey}/${projectsTreeCheckoutKey(checkout)}`, true));
        }
    }
    return rows;
}

/** What the tree needs of a machine: its name, home and presence (Machine rows own these facts). */
/**
 * The Hidden group's rows (lab p-projects HIDDEN): each hidden Project once, said where its first
 * checkout lives, and opening that exact checkout. The column and the phone list both draw these.
 */
export function buildProjectsTreeHiddenItems(projects: readonly ProjectsTreeProject[]): ReadonlyArray<Readonly<{
    key: string; title: string; subtitle: string; refId: string; workspaceAddress?: WorkspaceAddressV1;
}>> {
    return projects.flatMap((project) => {
        const first = project.checkouts[0];
        if (!first) return [];
        return [{ key: project.key, title: project.name, subtitle: `${first.machineName} · ${first.path}`, refId: first.refId,
            ...(first.workspaceAddress ? { workspaceAddress: first.workspaceAddress } : {}) }];
    });
}

/** `online` is null while presence is unknown (a Machine this Home does not list): never guessed. */
export type ProjectsTreeMachineFacts = Readonly<{ name: string; homeDir: string | null; online: boolean | null }>;

/**
 * A one-row Project's second line after its Machine: the branch when it is known, otherwise where the
 * checkout lives (lab RULES 6, "MacBook Pro · ~/scratch"), never the folder name its title already says.
 */
function checkoutWhere(checkout: ProjectsTreeCheckout): string {
    return checkout.branch ? checkout.label : checkout.path;
}

function folderName(rootPath: string): string {
    const parts = rootPath.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    return parts.at(-1) ?? rootPath;
}

/**
 * The one name a checkout gets wherever it is listed (the tree, the Checkouts widget): its branch, else its folder,
 * never an absolute path. Siblings that would read the same add their folder, so they stay distinguishable.
 */
export function labelProjectCheckouts(entries: readonly Readonly<{ branch?: string | null; folder: string }>[]): string[] {
    const names = entries.map(entry => entry.branch?.trim() || entry.folder);
    return names.map((name, index) => name !== entries[index]!.folder && names.some((other, at) => at !== index && other === name)
        ? `${name} · ${entries[index]!.folder}` : name);
}

/**
 * Observed checkout facts folded into a Project built without them (`buildProjectsTreeProjects` yields
 * folder labels, no branch and no attention). The one owner of how a fact reads on a row: the
 * tree's Project sections and the phone list both call it with the facts they subscribed to.
 */
export function applyProjectsTreeCheckoutFacts(
    project: ProjectsTreeProject,
    factsOf: (checkout: ProjectsTreeCheckout, index: number) => ProjectsTreeCheckoutFacts | null,
): ProjectsTreeProject {
    let newFromSession = false;
    const checkouts = project.checkouts.map((checkout, index): ProjectsTreeCheckout => {
        const facts = factsOf(checkout, index);
        if (!facts) return checkout;
        if (facts.newFromSession) newFromSession = true;
        return {
            ...checkout,
            label: facts.branch ?? checkout.label,
            branch: facts.branch,
            isWorktree: facts.isWorktree,
            attention: facts.attention,
        };
    });
    const labels = labelProjectCheckouts(checkouts.map((checkout, index) => ({ branch: checkout.branch, folder: project.checkouts[index]!.label })));
    return { ...project, newFromSession, checkouts: checkouts.map((checkout, index) =>
        checkout.label === labels[index] ? checkout : { ...checkout, label: labels[index]! }) };
}

/** Share unchanged presentation values with the preceding projection, keyed by exact checkout address. */
function retainProjectsTreeProject(previous: ProjectsTreeProject | undefined, next: ProjectsTreeProject): ProjectsTreeProject {
    if (!previous) return next;
    const previousCheckouts = new Map(previous.checkouts.map(checkout => [projectsTreeCheckoutKey(checkout), checkout]));
    const checkouts = next.checkouts.map(checkout => {
        const prior = previousCheckouts.get(projectsTreeCheckoutKey(checkout));
        if (!prior) return checkout;
        // The key proves every address field equal; reuse that nested identity for the shallow comparison.
        return shallow(prior, checkout.workspaceAddress ? { ...checkout, workspaceAddress: prior.workspaceAddress } : checkout) ? prior : checkout;
    });
    const retained = { ...next, checkouts: shallow(previous.checkouts, checkouts) ? previous.checkouts : checkouts };
    return shallow(previous, retained) ? previous : retained;
}

/** The checkout opened last; ties (and never-opened checkouts) keep the projection's order. */
function mostRecentlyOpenedIndex(refs: ReadonlyArray<Readonly<{ lastOpenedAtMs?: number | null }>>): number {
    let lead = 0;
    refs.forEach((ref, index) => {
        if ((ref.lastOpenedAtMs ?? -1) > (refs[lead]!.lastOpenedAtMs ?? -1)) lead = index;
    });
    return lead;
}

/**
 * The Project projection's groups (`projectProjectListV1`, in their order) as tree input: a Project is
 * named after its checkout the person sees first; each checkout keeps its exact ref.
 */
export function buildProjectsTreeProjects<TRef extends Readonly<{
    id: string; serverId?: string; machineId: string; rootPath: string;
    label?: string | null; source?: Readonly<{ sourceId: string }>; lastOpenedAtMs?: number | null;
}>>(input: Readonly<{
    groups: ReadonlyArray<Readonly<{ projectKey: Readonly<{ projectKey: string }>; items: readonly TRef[] }>>;
    projectName: (ref: TRef) => string;
    /** Every referenced Machine has a name from the machine-name owner, even one this Home no longer lists. */
    machine: (machineId: string) => ProjectsTreeMachineFacts;
    /** Only current authorized catalog rows from the same Home/Account as these accepted refs. */
    sources?: readonly Pick<ProjectSourceV1, 'id' | 'name' | 'audience'>[];
    teamName?: (teamId: string) => string | null;
    checkoutFacts?: (ref: TRef) => ProjectsTreeCheckoutFacts | null;
    /** The preceding output of this producer; unchanged Projects and checkouts keep their identities. */
    previousProjects?: ProjectsTreeProject[];
}>): ProjectsTreeProject[] {
    const previousByKey = new Map(input.previousProjects?.map(project => [project.key, project]));
    const projects = input.groups.flatMap((group) => {
        const first = group.items[0];
        if (!first) return [];
        const sourceIds = new Set(group.items.flatMap(ref => ref.source ? [ref.source.sourceId] : []));
        const source = sourceIds.size === 1
            ? input.sources?.find(candidate => sourceIds.has(candidate.id)) ?? null
            : null;
        const teamId = source ? readSourceTeamId(source) : null;
        const factsByRef = group.items.map(ref => input.checkoutFacts?.(ref) ?? null);
        const checkouts = group.items.map((ref): ProjectsTreeCheckout => {
            const machine = input.machine(ref.machineId);
            return {
                refId: ref.id,
                ...(ref.serverId ? { workspaceAddress: { serverId: ref.serverId, workspaceId: ref.id,
                    machineId: ref.machineId, rootPath: ref.rootPath } } : {}),
                machineId: ref.machineId,
                machineName: machine.name,
                label: folderName(ref.rootPath),
                branch: null,
                isWorktree: null,
                path: formatPathRelativeToHome(ref.rootPath, machine.homeDir ?? undefined),
                attention: null,
                offline: machine.online === null ? undefined : !machine.online,
            };
        });
        const project: ProjectsTreeProject = {
            key: group.projectKey.projectKey,
            name: first.label?.trim() ? input.projectName(first) : source?.name ?? input.projectName(first),
            teamLabel: teamId ? input.teamName?.(teamId) ?? null : null,
            newFromSession: false,
            checkouts,
            lead: mostRecentlyOpenedIndex(group.items),
        };
        return [retainProjectsTreeProject(previousByKey.get(project.key),
            applyProjectsTreeCheckoutFacts(project, (_checkout, index) => factsByRef[index] ?? null))];
    });
    return input.previousProjects && shallow(input.previousProjects, projects) ? input.previousProjects : projects;
}

/**
 * The phone tree (plan 10 §2 Phone, lab p-projects TREEp): two levels instead of three — a Project, and
 * under it each checkout, read like the column's checkout rows (its label, then "Machine · path"). A Project row says where it lives in its second
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
            ? `${single.machineName} · ${checkoutWhere(single)}`
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
            opens: single ? null : projectOpenTarget(project),
            // Collapsed, the second line already says how many; the count beside it belongs to the open Project.
            count: single || !expanded ? null : checkouts.length,
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
                title: checkout.label,
                titleQualifier: null,
                subtitle: `${checkout.machineName} · ${checkout.path}`,
                machineId: checkout.machineId,
                glyph: 'branch',
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

/**
 * The Projects search: a Project stays when its name, its Team, or any checkout's Machine, label or path holds the
 * query (case-insensitive). An empty query keeps the very same list, so the rows keep their identity.
 */
export function filterProjectsTreeByQuery(projects: readonly ProjectsTreeProject[], query: string): readonly ProjectsTreeProject[] {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length === 0) return projects;
    const holds = (text: string | null | undefined) => typeof text === 'string' && text.toLocaleLowerCase().includes(needle);
    return projects.filter((project) => holds(project.name) || holds(project.teamLabel)
        || project.checkouts.some((checkout) => holds(checkout.machineName) || holds(checkout.label) || holds(checkout.path)));
}
