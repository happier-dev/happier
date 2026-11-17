import type {
  AppGroupRowV1,
  LeftBehindRowV1,
  MachineProcessesAnswerV1,
  NotHappierRowV1,
  OwnerRowV1,
  ProcessOwnershipLevelV1,
  ProcessRowV1,
} from '@happier-dev/protocol/machines/processes/machineProcessesV1';

import { selectMachineProcessesLeftBehind } from '@/sync/domains/machines/processes/selectMachineProcessesLeftBehind';
import { attributeMachineUsage, type MachineUsageFacts } from '@happier-dev/protocol/machines/resources/machineUsageAttribution';

/**
 * The Processes tab's one presentation model (plan 30 §10, lab `rp`): what rows the tree shows, in which
 * order, folded how, narrowed by a search, and the totals that close it. Pure: the tab, plan 60's read-only
 * tool body and the Overview's "Using the most" (VU-7) all draw from this, so they can never disagree.
 */

export type ProcessesSortKey = 'memory' | 'cpu';
export type ProcessesSort = Readonly<{
  key: ProcessesSortKey;
  direction: 'ascending' | 'descending';
}>;
export type ProcessesGroup =
  | 'happier'
  | 'leftBehind'
  | 'notHappier'
  | 'otherPeople';

type Figures = Readonly<{
  cpuPercent: number | null;
  memoryBytes: number | null;
}>;
type Node = Readonly<{
  key: string;
  parentKey: string | null;
  group: ProcessesGroup;
}>;

export type ProcessesOwnerItem = Node &
  Figures &
  Readonly<{
    kind: 'owner';
    owner: OwnerRowV1;
    processCount: number;
    /** The owner's root process (a session's runner): Stop and Kill tree name it. */
    rootRef: string | null;
    rootLevel: ProcessRowV1['level'];
    ports: NonNullable<ProcessRowV1['ports']>;
    hasChildren: boolean;
    /** While searching: how many of its processes match. */
    matchCount: number | null;
  }>;
export type ProcessesProcessItem = Node &
  Figures &
  Readonly<{
    kind: 'process';
    ownerKey: string;
    owner: OwnerRowV1;
    row: ProcessRowV1;
    hasChildren: boolean;
  }>;
export type ProcessesFoldItem = Node &
  Figures &
  Readonly<{ kind: 'fold'; count: number; reason: 'idle' | 'mcp' }>;
export type ProcessesLeftBehindItem = Node &
  Figures &
  Readonly<{ kind: 'leftBehind'; row: LeftBehindRowV1 }>;
export type ProcessesHappierItem = Node &
  Figures &
  Readonly<{ kind: 'happier'; ownerCount: number; processCount: number }>;
export type ProcessesAppItem = Node &
  Figures &
  Readonly<{ kind: 'app'; app: AppGroupRowV1; count: number }>;
export type ProcessesAppMemberItem = Node &
  Figures &
  Readonly<{ kind: 'appMember'; row: NotHappierRowV1 }>;
export type ProcessesOtherPeopleItem = Node &
  Figures &
  Readonly<{ kind: 'otherPeople'; count: number; names: readonly string[] }>;

export type ProcessesItem =
  | ProcessesOwnerItem
  | ProcessesProcessItem
  | ProcessesFoldItem
  | ProcessesLeftBehindItem
  | ProcessesHappierItem
  | ProcessesAppItem
  | ProcessesAppMemberItem
  | ProcessesOtherPeopleItem;

export type MachineProcessesViewInput = Readonly<{
  answer: MachineProcessesAnswerV1;
  scope: 'happier' | 'all';
  sort: ProcessesSort;
  query?: string;
  /** The owner's name as the app shows it (session title, service title), so a search finds it by name. */
  ownerTitle?: (owner: OwnerRowV1) => string | null;
  /** Rows that have left the list (a stop in flight); the exit animation owns them. */
  hidden?: ReadonlySet<string>;
  /** Fold rows the person opened. */
  unfolded?: ReadonlySet<string>;
  /** Owners only, biggest first (the Overview's "Using the most", VU-7). */
  ownersOnly?: boolean;
  /** Only Left behind (`filter=leftBehind`); its count and figures are unchanged. */
  leftBehindOnly?: boolean;
  limit?: number;
}>;

export type MachineProcessesMatch = Readonly<
  { matched: number; total: number } & Figures
>;

export type MachineProcessesView = Readonly<{
  items: readonly ProcessesItem[];
  /** Branches a search opened so its matches are visible. */
  revealKeys: readonly string[];
  /** The canonical Left behind set for the rows shown: the group's count, size and cleanup refs. */
  leftBehind: ReturnType<typeof selectMachineProcessesLeftBehind>;
  match: MachineProcessesMatch | null;
}>;

/** A rounded 0 % (what the table prints as "0%"). */
const IDLE_CPU_PERCENT = 0.05;
/** One idle row is a row; two or more fold (lab `rp` F: "4 more at 0%", "2 MCP servers, idle"). */
const FOLD_MIN_ROWS = 2;

const ownerKeyOf = (owner: OwnerRowV1) => `o:${owner.rowId}`;
const processKeyOf = (row: ProcessRowV1) => `p:${row.rowId}`;

function compareFigures(sort: ProcessesSort) {
  const sign = sort.direction === 'descending' ? -1 : 1;
  return (
    left: Figures & { key: string },
    right: Figures & { key: string },
  ) => {
    const a = sort.key === 'cpu' ? left.cpuPercent : left.memoryBytes;
    const b = sort.key === 'cpu' ? right.cpuPercent : right.memoryBytes;
    if (a === null || b === null)
      return a === b ? left.key.localeCompare(right.key) : a === null ? 1 : -1;
    return a === b ? left.key.localeCompare(right.key) : (a - b) * sign;
  };
}

function sum(values: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value == null) return null;
    total += value;
  }
  return total;
}

function roleWords(role: ProcessRowV1['role']): string | undefined {
  return role?.replaceAll('_', ' ');
}

function matchesProcess(row: ProcessRowV1, query: string): boolean {
  return [
    row.name,
    row.displayName,
    row.command,
    roleWords(row.role),
    row.browserEngine,
    row.driverLabel,
    String(row.pid),
    ...(row.ports ?? []).map((port) => String(port.port)),
  ].some((value) => value?.toLocaleLowerCase().includes(query));
}

/** The root a person thinks of as the owner itself (a session's runner): the earliest of its top-level processes. */
function resolveOwnerRoot(owner: OwnerRowV1): ProcessRowV1 | null {
  const top = owner.members.filter(
    (row) =>
      row.parentRowId === owner.rowId ||
      !owner.members.some((other) => other.rowId === row.parentRowId),
  );
  return (
    [...top].sort(
      (left, right) =>
        left.startedAtMs - right.startedAtMs ||
        left.rowId.localeCompare(right.rowId),
    )[0] ?? null
  );
}

/**
 * Freeing this row's port ends a terminal (R42.5): the listener is the terminal's own shell, which is
 * its owner's root (drawn as the owner row when it is the only top-level process). A dev server the
 * shell started is a child and leaves the terminal open.
 */
export function processPortClosesTerminal(item: ProcessesItem): boolean {
  if (item.kind === 'owner') return item.owner.owner.kind === 'terminal';
  if (item.kind !== 'process' || item.owner.owner.kind !== 'terminal') return false;
  return resolveOwnerRoot(item.owner)?.rowId === item.row.rowId;
}

/** Fold trailing idle siblings (sorted by CPU) into one line, unless the person opened it. */
function foldIdle<T extends ProcessesItem>(
  siblings: readonly T[],
  input: MachineProcessesViewInput,
  parentKey: string | null,
  group: ProcessesGroup,
  isMcp: (item: T) => boolean,
): Readonly<{ shown: readonly ProcessesItem[]; folded: ReadonlySet<string> }> {
  if (input.sort.key !== 'cpu' || input.query?.trim())
    return { shown: siblings, folded: new Set() };
  let start = siblings.length;
  while (start > 0) {
    const cpuPercent = siblings[start - 1]!.cpuPercent;
    if (cpuPercent === null || cpuPercent >= IDLE_CPU_PERCENT) break;
    start -= 1;
  }
  const idle = siblings.slice(start);
  const key = `f:${parentKey ?? group}`;
  if (idle.length < FOLD_MIN_ROWS || input.unfolded?.has(key))
    return { shown: siblings, folded: new Set() };
  const fold: ProcessesFoldItem = {
    kind: 'fold',
    key,
    parentKey,
    group,
    count: idle.length,
    reason: idle.every(isMcp) ? 'mcp' : 'idle',
    cpuPercent: sum(idle.map((item) => item.cpuPercent)),
    memoryBytes: sum(idle.map((item) => item.memoryBytes)),
  };
  return {
    shown: [...siblings.slice(0, start), fold],
    folded: new Set(idle.map((item) => item.key)),
  };
}

type OwnerBuild = Readonly<{
  owner: ProcessesOwnerItem;
  descendants: readonly ProcessesItem[];
  matched: number;
  /** Processes the search kept only because something under them matches: every one of these must open. */
  branchKeys: readonly string[];
}>;

function buildOwner(
  owner: OwnerRowV1,
  input: MachineProcessesViewInput,
  query: string,
): OwnerBuild | null {
  const ownerKey = ownerKeyOf(owner);
  const root = resolveOwnerRoot(owner);
  // The root folds into its owner row when it is the owner's only top-level process.
  const topLevel = owner.members.filter(
    (row) =>
      row.parentRowId === owner.rowId ||
      !owner.members.some((other) => other.rowId === row.parentRowId),
  );
  const absorbedRoot = topLevel.length === 1 ? root : null;
  const parentOf = (row: ProcessRowV1): string => {
    if (
      !row.parentRowId ||
      row.parentRowId === owner.rowId ||
      row.parentRowId === absorbedRoot?.rowId
    )
      return ownerKey;
    return owner.members.some((other) => other.rowId === row.parentRowId)
      ? `p:${row.parentRowId}`
      : ownerKey;
  };
  const members = owner.members.filter(
    (row) => row.rowId !== absorbedRoot?.rowId,
  );
  const children = new Map<string, ProcessRowV1[]>();
  for (const row of members) {
    const parent = parentOf(row);
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const ownerTitle = input.ownerTitle?.(owner)?.toLocaleLowerCase() ?? '';
  const ownerMatches =
    query.length > 0 &&
    (ownerTitle.includes(query) ||
      (absorbedRoot !== null && matchesProcess(absorbedRoot, query)));
  // While searching, a process stays when it or something under it matches; the owner opens to show it.
  const keep = new Set<string>();
  const branchKeys: string[] = [];
  let matched = 0;
  if (query && !ownerMatches) {
    const visit = (key: string): boolean => {
      let any = false;
      for (const row of children.get(key) ?? []) {
        const self = matchesProcess(row, query);
        if (self) matched += 1;
        const below = visit(processKeyOf(row));
        if (below) branchKeys.push(processKeyOf(row));
        if (self || below) {
          keep.add(processKeyOf(row));
          any = true;
        }
      }
      return any;
    };
    if (!visit(ownerKey)) return null;
  } else if (ownerMatches) {
    matched = owner.members.length;
  }
  const compare = compareFigures(input.sort);
  const descendants: ProcessesItem[] = [];
  const emit = (parentKey: string) => {
    const rows = (children.get(parentKey) ?? [])
      .filter(
        (row) =>
          (!query || ownerMatches || keep.has(processKeyOf(row))) &&
          !input.hidden?.has(processKeyOf(row)),
      )
      .map((row): ProcessesProcessItem => ({
        kind: 'process',
        key: processKeyOf(row),
        parentKey,
        group: 'happier',
        ownerKey,
        owner,
        row,
        cpuPercent: row.browserGroup ? row.browserGroup.totals.cpuPercent ?? null : row.cpuPercent ?? null,
        memoryBytes: row.browserGroup ? row.browserGroup.totals.memoryBytes : row.memoryBytes,
        hasChildren: (children.get(processKeyOf(row)) ?? []).length > 0,
      }))
      .sort(compare);
    const { shown } = foldIdle(
      rows,
      input,
      parentKey,
      'happier',
      (item) => item.row.role === 'mcp_server',
    );
    for (const item of shown) {
      descendants.push(item);
      if (item.kind === 'process') emit(item.key);
    }
  };
  if (!input.ownersOnly) emit(ownerKey);
  return {
    owner: {
      kind: 'owner',
      key: ownerKey,
      parentKey: null,
      group: 'happier',
      owner,
      cpuPercent: owner.totals.cpuPercent ?? null,
      memoryBytes: owner.totals.memoryBytes,
      processCount: owner.totals.processCount,
      rootRef: owner.root?.ref ?? null,
      rootLevel: owner.root?.level ?? 'unknown',
      ports: absorbedRoot?.ports ?? [],
      hasChildren: members.length > 0 && !input.ownersOnly,
      matchCount: query ? matched : null,
    },
    descendants,
    matched,
    branchKeys,
  };
}

export function buildMachineProcessesView(
  input: MachineProcessesViewInput,
): MachineProcessesView {
  const { answer } = input;
  const query = input.query?.trim().toLocaleLowerCase() ?? '';
  const compare = compareFigures(input.sort);
  const items: ProcessesItem[] = [];
  const revealKeys: string[] = [];
  let matched = 0;

  const owners = answer.owners
    .map((owner) => buildOwner(owner, input, query))
    .filter(
      (build): build is OwnerBuild =>
        build !== null && !input.hidden?.has(build.owner.key),
    )
    .sort((left, right) => compare(left.owner, right.owner));
  for (const build of owners) matched += build.matched;

  if (input.scope === 'all' && !input.ownersOnly) {
    // All processes: Happier's own work is one row; its owners stay one tab away.
    if (owners.length > 0) {
      items.push({
        kind: 'happier',
        key: 'happier',
        parentKey: null,
        group: 'happier',
        ownerCount: owners.length,
        processCount: owners.reduce(
          (total, build) => total + build.owner.processCount,
          0,
        ),
        cpuPercent: sum(owners.map((build) => build.owner.cpuPercent)),
        memoryBytes: sum(owners.map((build) => build.owner.memoryBytes)),
      });
    }
  } else {
    const shownOwners =
      input.limit === undefined ? owners : owners.slice(0, input.limit);
    const { shown, folded } = foldIdle(
      shownOwners.map((build) => build.owner),
      input,
      null,
      'happier',
      () => false,
    );
    for (const owner of shown) {
      items.push(owner);
      if (owner.kind !== 'owner') continue;
      const build = shownOwners.find(
        (candidate) => candidate.owner.key === owner.key,
      )!;
      if (folded.has(owner.key)) continue;
      items.push(...build.descendants);
      if (query && build.matched > 0 && build.descendants.length > 0)
        revealKeys.push(owner.key, ...build.branchKeys);
    }
  }

  const leftBehind = selectMachineProcessesLeftBehind(
    answer.leftBehind,
    query ? { query } : {},
  );
  if (!input.ownersOnly) {
    const leftItems = leftBehind.items
      .filter((row) => !input.hidden?.has(`l:${row.ref}`))
      .map((row): ProcessesLeftBehindItem => ({
        kind: 'leftBehind',
        key: `l:${row.ref}`,
        parentKey: null,
        group: 'leftBehind',
        row,
        cpuPercent: row.cpuPercent ?? null,
        memoryBytes: row.memoryBytes,
      }));
    // Left behind keeps the daemon's order (oldest confirmed first); the group's count is the selector's.
    items.push(...leftItems);
    matched += leftBehind.count;
  }

  // What the search ran over and what it matched among other apps' processes (All processes only).
  let externalTotal = 0;
  const externalMatches: (Figures & Readonly<{ count: number }>)[] = [];
  if (input.scope === 'all' && !input.ownersOnly) {
    const apps = (answer.notHappier ?? [])
      .map((app): ProcessesAppItem => ({
        kind: 'app',
        key: `a:${app.appGroup}`,
        parentKey: null,
        group: 'notHappier',
        app,
        count: app.members.length,
        cpuPercent: sum(app.members.map((row) => row.cpuPercent)),
        memoryBytes: sum(app.members.map((row) => row.memoryBytes)),
      }))
      .sort(compare);
    for (const app of apps) {
      externalTotal += app.count;
      // An app named by the search shows every member; otherwise only the members that match, under an opened app.
      const appMatches = query.length > 0 && app.app.appGroup.toLocaleLowerCase().includes(query);
      const members = app.app.members
        .filter((row) => !query || appMatches || row.name.toLocaleLowerCase().includes(query))
        .map((row): ProcessesAppMemberItem => ({
          kind: 'appMember',
          key: `m:${row.ref}`,
          parentKey: app.key,
          group: 'notHappier',
          row,
          cpuPercent: row.cpuPercent ?? null,
          memoryBytes: row.memoryBytes,
        }));
      if (query && members.length === 0) continue;
      if (query) {
        externalMatches.push(...members.map((member) => ({ count: 1, cpuPercent: member.cpuPercent, memoryBytes: member.memoryBytes })));
        if (!appMatches) revealKeys.push(app.key);
      }
      items.push(app);
      items.push(...members.filter((member) => !input.hidden?.has(member.key)).sort(compare));
    }
    const others = answer.otherPrincipals;
    if (others && others.count > 0) {
      externalTotal += others.count;
      const othersMatch = query.length > 0 && others.names.some((name) => name.toLocaleLowerCase().includes(query));
      if (!query || othersMatch) {
        if (othersMatch) externalMatches.push({ count: others.count, cpuPercent: others.cpuPercent ?? null, memoryBytes: others.memoryBytes });
        items.push({
          kind: 'otherPeople',
          key: 'others',
          parentKey: null,
          group: 'otherPeople',
          count: others.count,
          names: others.names,
          cpuPercent: others.cpuPercent ?? null,
          memoryBytes: others.memoryBytes,
        });
      }
    }
  }

  const total = answer.totals.happier.processCount + answer.leftBehind.length + externalTotal;
  const match = query
    ? {
        matched: matched + externalMatches.reduce((count, entry) => count + entry.count, 0),
        total,
        cpuPercent: sum([
          ...owners.map((build) =>
            build.matched > 0 ? build.owner.cpuPercent : 0,
          ),
          ...leftBehind.items.map((row) => row.cpuPercent),
          ...externalMatches.map((entry) => entry.cpuPercent),
        ]),
        memoryBytes: sum([
          ...owners.map((build) =>
            build.matched > 0 ? build.owner.memoryBytes : 0,
          ),
          ...leftBehind.items.map((row) => row.memoryBytes),
          ...externalMatches.map((entry) => entry.memoryBytes),
        ]),
      }
    : null;
  return {
    items: input.leftBehindOnly ? items.filter((item) => item.kind === 'leftBehind') : items,
    revealKeys,
    leftBehind,
    match,
  };
}

export type MachineProcessesVitalsFacts = MachineUsageFacts;

export type MachineProcessesTotals = Readonly<{
  happier: Figures & Readonly<{ processCount: number }>;
  leftBehind: Figures & Readonly<{ processCount: number }>;
  /** The machine's use not counted under Happier, from the same vitals the tiles show; `null` when not reported. */
  everythingElse: Figures;
}>;

/** "Happier in total" and "Everything else on <machine>" (the two rows that close the tree, and VU-7's). */
export function selectMachineProcessesTotals(
  answer: MachineProcessesAnswerV1,
  vitals: MachineProcessesVitalsFacts | null,
): MachineProcessesTotals {
  const happier = {
    processCount: answer.totals.happier.processCount,
    cpuPercent: answer.totals.happier.cpuPercent ?? null,
    memoryBytes: answer.totals.happier.memoryBytes,
  };
  const leftBehind = {
    processCount: answer.totals.leftBehind.processCount,
    cpuPercent: answer.totals.leftBehind.cpuPercent ?? null,
    memoryBytes: answer.totals.leftBehind.memoryBytes,
  };
  return {
    happier,
    leftBehind,
    everythingElse: attributeMachineUsage(answer.totals, vitals).everythingElse,
  };
}

/**
 * PROC-17: a row takes emphasis when it uses at least one full core (100 ÷ effective CPU capacity percent of the
 * machine) or is left behind. Unknown core counts never emphasise on CPU.
 */
export function isProcessRowEmphasized(
  row: Readonly<{
    cpuPercent: number | null | undefined;
    level?: ProcessOwnershipLevelV1;
  }>,
  cpuCapacityCores: number | null,
): boolean {
  if (row.level === 'left_behind') return true;
  if (
    !cpuCapacityCores ||
    cpuCapacityCores <= 0 ||
    row.cpuPercent === null ||
    row.cpuPercent === undefined
  )
    return false;
  return row.cpuPercent >= 100 / cpuCapacityCores;
}

/** A live sample never reorders rows under the pointer: known rows keep their place, new rows join the end. */
export function mergeStableProcessOrder(
  previous: readonly string[],
  fresh: readonly string[],
): readonly string[] {
  const present = new Set(fresh);
  const kept = previous.filter((key) => present.has(key));
  const known = new Set(kept);
  return [...kept, ...fresh.filter((key) => !known.has(key))];
}

/** Apply a held order: siblings keep their relative place (the Collection flattens by parent in caller order). */
export function applyProcessOrder(
  items: readonly ProcessesItem[],
  order: readonly string[] | null,
): readonly ProcessesItem[] {
  if (!order) return items;
  const rank = new Map(order.map((key, index) => [key, index]));
  return items
    .map((item, index) => ({
      item,
      rank: rank.get(item.key) ?? order.length + index,
    }))
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => entry.item);
}
