import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { readSourceTeamId } from './sources/projectSourceGroups';
import { shallow } from 'zustand/vanilla/shallow';
import type { ProjectSurfaceTargetV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { readProjectSourceLink } from '@/sync/domains/workspaces/projectSourceLink';
import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { buildDeploymentEnvironmentHref, buildDeploymentProjectHref } from './deployments/deploymentNavigation';

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
    source?: ProjectSurfaceTargetV1['source'];
    /** The Team a Team project is shared with ("Acme"), drawn quietly after the name. */
    teamLabel?: string | null;
    /** Accepted Session checkout not yet viewed through the existing device presentation owner. */
    newFromSession?: boolean;
    checkouts: readonly ProjectsTreeCheckout[];
    /** Which checkout a press on the Project opens: the one opened most recently (default: the first). */
    lead?: number;
    /** The Environments this Project's Source deploys (pfc-redesign dProject tree), drawn after its checkouts. */
    environments?: readonly ProjectsTreeEnvironment[];
    /**
     * A Project that only deploys (no checkout on this Home; lab rdProj: plausible, status): its row opens its
     * deployments page and its Environments open on the Environment route.
     */
    deploymentSource?: Readonly<{ serverId: string; projectSourceId: string }>;
}>;

/** Where an Environment row opens: the Environment page, the same route Services and the Machine open. */
export type ProjectsTreeEnvironmentAddress = Readonly<{ serverId: string; projectSourceId: string; environmentId: string }>;

/** An Environment as its tree row reads it: the one environment row's rail facts (`useDeploymentEnvironmentRowParts`). */
export type ProjectsTreeEnvironment = ProjectsTreeEnvironmentAddress & Readonly<{
    title: string;
    titleQualifier: string | null;
    /**
     * The one fact at the row's end (lab rdProj: "v1.42", "● Deploy failed"): its state word while it needs a look or
     * deploys, otherwise its live version, otherwise how long ago it changed. Environment rows are one line.
     */
    fact: string | null;
    attention: ProjectsTreeAttention;
    /** The one environment row's trouble mark (failed rose, unverified amber), drawn before its state word. */
    needsYouStatus?: WorkStatusPresentation | null;
    /** The Machine it runs on: an Environment on a Machine discloses what runs there; without one it has nothing beneath. */
    machineId?: string | null;
}>;

/** Where a row under an Environment opens: a service's page on its Machine, or a database in its Environment. */
export type ProjectsTreeChildTarget =
    | Readonly<{ kind: 'href'; href: string }>
    | Readonly<{ kind: 'database'; database: string }>;

/**
 * One thing an open Environment runs (lab rdProj tree): a service on its Machine or one of its databases, as the
 * Environment's own reads say (`useProjectsTreeEnvironmentChildren`). The rows owner only places them.
 */
export type ProjectsTreeEnvironmentChild = Readonly<{
    key: string;
    title: string;
    kind: 'service' | 'database';
    /** A database's engine ("PostgreSQL 16"); nothing for a service. */
    subtitle: string | null;
    opens: ProjectsTreeChildTarget;
}>;

export type ProjectsTreeRow = Readonly<{
    key: string;
    source?: ProjectSurfaceTargetV1['source'];
    level: number;
    kind: 'project' | 'machine' | 'checkout' | 'environment' | 'service' | 'database';
    title: string;
    /** Quiet text on the title's line: the Team, the folded machine's name, or a machine leaf's label. */
    titleQualifier?: string | null;
    /** A second line: where a single checkout lives, or the open checkout's path. */
    subtitle?: string | null;
    /** The machine whose glyph a machine row (or a machine leaf) carries. */
    machineId?: string | null;
    /** Machine leaves draw the machine's glyph; checkout leaves under a machine draw a branch. */
    glyph: 'project' | 'machine' | 'branch' | 'environment' | 'service' | 'database';
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
    /** An Environment row: the Environment page it opens. Read through `projectsTreeRowEnvironment`. */
    environment?: ProjectsTreeEnvironmentAddress;
    /** An Environment row's one fact at its end; with `needsYouStatus`, that status's word in its tone. */
    fact?: string | null;
    /** An Environment row in trouble: its mark leads the state word, so the row needs no second dot. */
    needsYouStatus?: WorkStatusPresentation | null;
    /** A service or database under an Environment: where it opens. Read through `projectsTreeRowChild`. */
    child?: ProjectsTreeChildTarget;
}>;

export type ProjectsTreeOpenTarget = Readonly<{ refId: string; workspaceAddress?: WorkspaceAddressV1 }>;

/** What a press (or Enter) on a row opens; `null` for a row that only discloses (a machine). */
export function projectsTreeRowOpenTarget(row: Pick<ProjectsTreeRow, 'refId' | 'workspaceAddress' | 'opens'>): ProjectsTreeOpenTarget | null {
    if (row.refId) return row.workspaceAddress ? { refId: row.refId, workspaceAddress: row.workspaceAddress } : { refId: row.refId };
    return row.opens ?? null;
}

/** A row's mark, the same in the column and on the phone: a Project's folder, a Machine, a checkout's branch, an Environment. */
export function projectsTreeGlyphIcon(glyph: ProjectsTreeRow['glyph']): 'folder' | 'desktop' | 'git-branch' | 'hard-drives' | 'cube' | 'stack' {
    switch (glyph) {
        case 'project': return 'folder';
        case 'machine': return 'desktop';
        case 'branch': return 'git-branch';
        case 'environment': return 'hard-drives';
        // The marks Machine → Services and Services → Databases already give these.
        case 'service': return 'cube';
        case 'database': return 'stack';
    }
}

/**
 * What an open Environment runs, as the tree lists it (lab rdProj: api, worker, …, billing-db, cache): its services on
 * its Machine (the Machine's services list for this Environment), then its declared databases, each named once. A
 * service the Environment declares as a database is that database, the join What runs makes by Compose service name.
 */
export function buildProjectsTreeEnvironmentChildren(input: Readonly<{
    services: readonly Readonly<{ serviceId: string; composeService: string | null; name: string }>[];
    /** The Environment's declared databases, their engine already titled (`databaseEngineTitle`). */
    databases: readonly Readonly<{ service: string; engine: string }>[];
    serviceHref: (serviceId: string) => string;
}>): ProjectsTreeEnvironmentChild[] {
    const databases = new Set(input.databases.map(database => database.service));
    const services = input.services.flatMap((service): ProjectsTreeEnvironmentChild[] => {
        const name = service.composeService ?? service.name;
        return databases.has(name) ? [] : [{ key: service.serviceId, title: name, kind: 'service', subtitle: null,
            opens: { kind: 'href', href: input.serviceHref(service.serviceId) } }];
    });
    return [...services, ...input.databases.map((database): ProjectsTreeEnvironmentChild => ({ key: `database:${database.service}`,
        title: database.service, kind: 'database', subtitle: database.engine, opens: { kind: 'database', database: database.service } }))];
}

/** Where a service or database row opens; `null` for every other row. */
export function projectsTreeRowChild(row: Pick<ProjectsTreeRow, 'child'>): ProjectsTreeChildTarget | null {
    return row.child ?? null;
}

/** The Environment an Environment row opens; `null` for every other row. */
export function projectsTreeRowEnvironment(row: Pick<ProjectsTreeRow, 'environment'>): ProjectsTreeEnvironmentAddress | null {
    return row.environment ?? null;
}

/**
 * A Project's Environments as rows one level under it, after its checkouts; the one on screen is selected. Each opens
 * on its Project's Deployments page (the Project's lead checkout, then the Environment), so it keeps the Project around it.
 */
type EnvironmentRowsContext = Readonly<{
    openEnvironmentId: string | null | undefined;
    /** The person's own disclosure for an Environment row (folded until opened). */
    isOpen: (key: string) => boolean;
    children: ReadonlyMap<string, readonly ProjectsTreeEnvironmentChild[]> | undefined;
}>;

function environmentRows(project: ProjectsTreeProject, context: EnvironmentRowsContext): ProjectsTreeRow[] {
    const opens = projectOpenTarget(project);
    return (project.environments ?? []).flatMap((environment): ProjectsTreeRow[] => {
        const key = `${project.key}/environment/${environment.environmentId}`;
        const address = { serverId: environment.serverId, projectSourceId: environment.projectSourceId, environmentId: environment.environmentId };
        const expandable = Boolean(environment.machineId);
        const expanded = expandable && context.isOpen(key);
        // With no checkout to open the Project on, the Environment and its databases open on the Environment route.
        const routed = opens === null;
        const row: ProjectsTreeRow = {
            key,
            level: 1,
            kind: 'environment',
            title: environment.title,
            titleQualifier: environment.titleQualifier,
            subtitle: null,
            fact: environment.fact,
            glyph: 'environment',
            expandable,
            expanded,
            refId: null,
            opens,
            attention: environment.needsYouStatus ? null : environment.attention,
            needsYouStatus: environment.needsYouStatus ?? null,
            selected: environment.environmentId === context.openEnvironmentId,
            environment: address,
            ...(routed ? { child: { kind: 'href' as const, href: buildDeploymentEnvironmentHref(address) } } : {}),
        };
        if (!expanded) return [row];
        const children = context.children?.get(environment.environmentId) ?? [];
        return [row, ...children.map((child): ProjectsTreeRow => ({
            key: `${key}/${child.key}`,
            level: 2,
            kind: child.kind,
            title: child.title,
            titleQualifier: null,
            subtitle: child.subtitle,
            glyph: child.kind,
            expandable: false,
            expanded: false,
            refId: null,
            opens,
            attention: null,
            selected: false,
            environment: address,
            child: routed && child.opens.kind === 'database'
                ? { kind: 'href', href: buildDeploymentEnvironmentHref({ ...address, database: child.opens.database }) } : child.opens,
        }))];
    });
}

/** A Project that only deploys: one row that opens its deployments page and discloses its Environments. */
function deploymentProjectRows(project: ProjectsTreeProject, open: boolean, context: EnvironmentRowsContext): ProjectsTreeRow[] {
    const environments = project.environments ?? [];
    if (!project.deploymentSource || environments.length === 0) return [];
    const row: ProjectsTreeRow = {
        key: project.key,
        level: 0,
        kind: 'project',
        title: project.name,
        titleQualifier: project.teamLabel ?? null,
        subtitle: null,
        glyph: 'project',
        expandable: true,
        expanded: open,
        refId: null,
        opens: null,
        attention: open ? null : mostUrgent(environments),
        selected: false,
        child: { kind: 'href', href: buildDeploymentProjectHref(project.deploymentSource) },
    };
    return open ? [row, ...environmentRows(project, context)] : [row];
}

function holdsEnvironment(project: ProjectsTreeProject, openEnvironmentId: string | null | undefined): boolean {
    return Boolean(openEnvironmentId) && (project.environments ?? []).some(environment => environment.environmentId === openEnvironmentId);
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

function mostUrgent(checkouts: readonly Readonly<{ attention: ProjectsTreeAttention }>[]): ProjectsTreeAttention {
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
    /** The Environment on screen, if any: its row is selected and its Project open. */
    openEnvironmentId?: string | null;
    expandedKeys: ReadonlySet<string>;
    collapsedKeys?: ReadonlySet<string>;
    /** What each opened Environment runs, by Environment id, once its reads land. */
    environmentChildren?: ReadonlyMap<string, readonly ProjectsTreeEnvironmentChild[]>;
}>): ProjectsTreeRow[] {
    const rows: ProjectsTreeRow[] = [];
    const isOpen = (key: string, holdsOpen: boolean) => (
        input.collapsedKeys?.has(key) === true ? false : input.expandedKeys.has(key) || holdsOpen
    );
    const environmentContext: EnvironmentRowsContext = { openEnvironmentId: input.openEnvironmentId,
        isOpen: (key) => isOpen(key, false), children: input.environmentChildren };
    // While one of a Project's Environments is open, that Environment is selected, not the checkout its page sits on.
    let onEnvironment = false;
    const leaf = (checkout: ProjectsTreeCheckout, level: number, key: string, underMachine: boolean): ProjectsTreeRow => {
        const selected = checkout.refId === input.openRefId && !onEnvironment;
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
        onEnvironment = holdsEnvironment(project, input.openEnvironmentId);
        if (checkouts.length === 0) {
            rows.push(...deploymentProjectRows(project, isOpen(project.key, onEnvironment), environmentContext));
            continue;
        }
        const environments = project.environments ?? [];
        const holdsOpen = checkouts.some((checkout) => checkout.refId === input.openRefId) || onEnvironment;
        const machines = groupByMachine(checkouts);

        if (checkouts.length === 1) {
            // One checkout is the Project row itself; its Environments, if any, are what it discloses. On one of
            // them, that Environment is what is selected, not the checkout its page sits on.
            const only = checkouts[0]!;
            const selected = only.refId === input.openRefId && !onEnvironment;
            const open = environments.length > 0 && isOpen(project.key, holdsOpen);
            rows.push({
                key: project.key,
                level: 0,
                kind: 'project',
                source: project.source,
                title: project.name,
                titleQualifier: project.teamLabel ?? null,
                subtitle: `${only.machineName} · ${selected ? only.path : checkoutWhere(only)}`,
                machineId: only.machineId,
                glyph: 'project',
                expandable: environments.length > 0,
                expanded: open,
                refId: only.refId,
                workspaceAddress: only.workspaceAddress,
                attention: open ? only.attention : mostUrgent([only, ...environments]),
                offline: only.offline,
                selected,
                newFromSession: project.newFromSession === true,
            });
            if (open) rows.push(...environmentRows(project, environmentContext));
            continue;
        }

        const projectOpen = isOpen(project.key, holdsOpen);
        const singleMachine = machines.length === 1;
        rows.push({
            key: project.key,
            level: 0,
            kind: 'project',
            source: project.source,
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
            attention: projectOpen ? null : mostUrgent([...checkouts, ...environments]),
            selected: false,
            newFromSession: project.newFromSession === true,
        });
        if (!projectOpen) continue;

        if (singleMachine) {
            for (const checkout of checkouts) rows.push(leaf(checkout, 1, `${project.key}/${projectsTreeCheckoutKey(checkout)}`, false));
            rows.push(...environmentRows(project, environmentContext));
            continue;
        }
        if (machines.every((group) => group.length === 1)) {
            // Many machines, one checkout each: no machine level; each checkout names its machine.
            for (const [checkout] of machines) rows.push(leaf(checkout!, 1, `${project.key}/${projectsTreeCheckoutKey(checkout!)}`, false));
            rows.push(...environmentRows(project, environmentContext));
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
        rows.push(...environmentRows(project, environmentContext));
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
    const retained = { ...next, source: shallow(previous.source, next.source) ? previous.source : next.source,
        checkouts: shallow(previous.checkouts, checkouts) ? previous.checkouts : checkouts };
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
    sources?: readonly ProjectSourceV1[];
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
            source: source && first.serverId && readProjectSourceLink({ serverId: first.serverId, sourceId: first.source?.sourceId ?? null,
                source: { serverId: first.serverId, source } }) ? { serverId: first.serverId, source } : undefined,
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
    openEnvironmentId?: string | null;
    expandedKeys: ReadonlySet<string>;
    collapsedKeys?: ReadonlySet<string>;
    environmentChildren?: ReadonlyMap<string, readonly ProjectsTreeEnvironmentChild[]>;
    describe: Readonly<{
        checkoutCount: (count: number) => string;
        machineCount: (count: number) => string;
        offlineCount: (count: number) => string;
    }>;
}>): ProjectsTreeRow[] {
    const rows: ProjectsTreeRow[] = [];
    const environmentContext: EnvironmentRowsContext = { openEnvironmentId: input.openEnvironmentId,
        isOpen: (key) => input.collapsedKeys?.has(key) !== true && input.expandedKeys.has(key), children: input.environmentChildren };
    for (const project of input.projects) {
        const checkouts = project.checkouts;
        if (checkouts.length === 0) {
            const open = input.collapsedKeys?.has(project.key) === true ? false
                : input.expandedKeys.has(project.key) || holdsEnvironment(project, input.openEnvironmentId);
            rows.push(...deploymentProjectRows(project, open, environmentContext));
            continue;
        }
        const machines = groupByMachine(checkouts);
        const environments = project.environments ?? [];
        const holdsOpen = checkouts.some((checkout) => checkout.refId === input.openRefId) || holdsEnvironment(project, input.openEnvironmentId);
        const single = checkouts.length === 1 ? checkouts[0]! : null;
        const offlineMachines = machines.filter((group) => group.every((checkout) => checkout.offline === true)).length;
        const subtitle = single
            ? `${single.machineName} · ${checkoutWhere(single)}`
            : machines.length === 1
                ? `${machines[0]![0]!.machineName} · ${input.describe.checkoutCount(checkouts.length)}`
                : [input.describe.machineCount(machines.length), offlineMachines > 0 ? input.describe.offlineCount(offlineMachines) : null]
                    .filter((part): part is string => part !== null).join(' · ');
        const expandable = !single || environments.length > 0;
        const expanded = expandable && (input.collapsedKeys?.has(project.key) === true
            ? false
            : input.expandedKeys.has(project.key) || holdsOpen);
        rows.push({
            key: project.key,
            level: 0,
            kind: 'project',
            title: project.name,
            titleQualifier: project.teamLabel ?? null,
            subtitle,
            source: project.source,
            machineId: single?.machineId ?? null,
            glyph: 'project',
            expandable,
            expanded,
            refId: single?.refId ?? null,
            workspaceAddress: single?.workspaceAddress,
            opens: single ? null : projectOpenTarget(project),
            // Collapsed, the second line already says how many; the count beside it belongs to the open Project.
            count: single || !expanded ? null : checkouts.length,
            attention: expanded ? (single ? single.attention : null) : mostUrgent([...checkouts, ...environments]),
            offline: single?.offline,
            selected: single?.refId === input.openRefId && !holdsEnvironment(project, input.openEnvironmentId),
            newFromSession: project.newFromSession === true,
        });
        if (!expanded) continue;
        for (const checkout of single ? [] : checkouts) {
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
        rows.push(...environmentRows(project, environmentContext));
    }
    return rows;
}

/**
 * The Projects search: a Project stays when its name, its Team, an Environment's name, or any checkout's Machine, label or path holds the
 * query (case-insensitive). An empty query keeps the very same list, so the rows keep their identity.
 */
export function filterProjectsTreeByQuery(projects: readonly ProjectsTreeProject[], query: string): readonly ProjectsTreeProject[] {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length === 0) return projects;
    const holds = (text: string | null | undefined) => typeof text === 'string' && text.toLocaleLowerCase().includes(needle);
    return projects.filter((project) => holds(project.name) || holds(project.teamLabel)
        || project.checkouts.some((checkout) => holds(checkout.machineName) || holds(checkout.label) || holds(checkout.path))
        || (project.environments ?? []).some((environment) => holds(environment.title)));
}
