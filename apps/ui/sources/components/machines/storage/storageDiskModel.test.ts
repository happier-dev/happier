import { describe, expect, it } from 'vitest';
import type {
  DiskNodeV1,
  PileItemRefV1,
} from '@happier-dev/protocol/storage/storageV1';

import { buildStorageDiskLevel, foldStorageDiskCrumbs, formatStorageDiskBytes, resolveStorageDiskOpenTarget, storageDiskNodeName, toStorageDiskChartPart, toStorageDiskCollectRow } from './storageDiskModel';

const node = (
  nodeId: string,
  parentId: string | undefined,
  bytes: number,
  over: Partial<DiskNodeV1> = {},
): DiskNodeV1 => ({
  nodeId,
  ...(parentId ? { parentId } : {}),
  name: nodeId.split('/').pop() ?? nodeId,
  kind: 'folder',
  size: {
    allocatedBytes: bytes,
    freesBytes: bytes,
    sharedBytes: 0,
    sharedExtentsUnmeasured: false,
    atLeast: false,
  },
  logicalBytes: bytes,
  items: 1,
  changedAt: 1,
  verdict: 'safe', collectable: true, flags: { happier: false, protection: 'none', atLeast: false, inUse: false },
  childCount: 0,
  ...over,
});
const ref = (itemId: string): PileItemRefV1 => ({
  itemId,
  path: itemId,
  identity: { dev: '1', ino: '2', kind: 'directory' },
  collectedAt: 1,
  collectedBy: { accountId: 'a', kind: 'person' },
});

const ROOT = '/Users/l';
function page(): DiskNodeV1[] {
  return [
    node(ROOT, '/Users', 311),
    node(`${ROOT}/Movies`, ROOT, 41, { deltaSincePrevious: 0 }),
    node(`${ROOT}/Development`, ROOT, 148, {
      deltaSincePrevious: 3,
      childCount: 2,
    }),
    node(`${ROOT}/Development/happier`, `${ROOT}/Development`, 96, {
      verdict: 'safe', collectable: true, flags: { happier: true, protection: 'none', atLeast: false, inUse: false },
    }),
    node(`${ROOT}/Development/website`, `${ROOT}/Development`, 21),
    node(`${ROOT}/Library`, ROOT, 64, { childCount: 1 }),
    node(`${ROOT}/Library/Developer`, `${ROOT}/Library`, 14),
    node(`${ROOT}/Documents`, ROOT, 22, {
      verdict: 'forbidden', collectable: false, flags: { happier: false, protection: 'forbidden', atLeast: false, inUse: false },
    }),
    node(`${ROOT}/Work`, ROOT, 0, { kind: 'mount' }),
    node(`${ROOT}#small`, ROOT, 1, { kind: 'small-items', items: 1204 }),
  ];
}

describe('one whole-disk view model for List, Map and Rings (plan 40 §4.11)', () => {
  it('preserves the daemon verdict and collectability instead of inferring safe from display flags', () => {
    for (const [verdict, collectable] of [['caution', true], ['check', false]] as const) {
      const observed = node(`${ROOT}/unclassified`, ROOT, 10, {
        verdict, collectable, reason: { code: 'facts_unavailable' },
      });
      expect(toStorageDiskCollectRow(observed)).toMatchObject({ verdict, collectable, reason: observed.reason });
    }
  });

  it('confirms Keep rather than blocking it, while Forbidden remains uncollectable', () => {
    const keep = node(`${ROOT}/Downloads`, ROOT, 10, {
      verdict: 'keep', collectable: true, flags: { happier: false, protection: 'keep', atLeast: false, inUse: false },
    });
    const forbidden = node(`${ROOT}/System`, ROOT, 10, {
      verdict: 'forbidden', collectable: false, flags: { happier: false, protection: 'forbidden', atLeast: false, inUse: false },
    });
    const rows = buildStorageDiskLevel({ nodes: [node(ROOT, '/Users', 20), keep, forbidden], rootId: ROOT, pile: [], sort: { by: 'size', direction: 'desc' } }).rows;
    expect(rows.find(row => row.key === keep.nodeId)?.collect).toBe('confirm');
    expect(rows.find(row => row.key === forbidden.nodeId)?.collect).toBe('none');
  });
  it('collects a Keep folder with its canonical reason and what is lost, so its confirmation names the loss (R42.1)', () => {
    const projects = node('/Users/l/projects', '/Users/l', 40, {
      verdict: 'keep', collectable: true, flags: { happier: false, protection: 'keep', atLeast: false, inUse: false },
      reason: { code: 'contains', detail: { what: 'main_checkout', project: 'happier' } },
      loses: [{ code: 'main_checkout', detail: { project: 'happier' } }, { code: 'changed_files', detail: { count: 3 } }],
    });
    expect(toStorageDiskCollectRow(projects)).toEqual({
      itemId: '/Users/l/projects', path: '/Users/l/projects', title: 'projects', verdict: 'keep', collectable: true,
      reason: projects.reason, loses: projects.loses,
    });
    const system = node('/System', '/', 9, { verdict: 'forbidden', collectable: false, flags: { happier: false, protection: 'forbidden', atLeast: false, inUse: false }, reason: { code: 'system' } });
    expect(toStorageDiskCollectRow(system)).toMatchObject({ verdict: 'forbidden', collectable: false, reason: { code: 'system' } });
    // A tile a level deeper carries its node, so pressing it collects through the same row.
    const level = buildStorageDiskLevel({ nodes: [node('/Users/l', '/Users', 50), projects], rootId: null, pile: [], sort: { by: 'size', direction: 'desc' } });
    expect(level.chart[0]!.children[0]!.node).toBe(projects);
  });

  it('serves the open folder’s children as rows biggest first, each with how it can be collected and its honest mark', () => {
    const level = buildStorageDiskLevel({
      nodes: page(),
      rootId: ROOT,
      pile: [],
      sort: { by: 'size', direction: 'desc' },
    });
    expect(level.root?.nodeId).toBe(ROOT);
    expect(level.rows.map((row) => row.key)).toEqual([
      `${ROOT}/Development`,
      `${ROOT}/Library`,
      `${ROOT}/Movies`,
      `${ROOT}/Documents`,
      `${ROOT}#small`,
      `${ROOT}/Work`,
    ]);
    const by = new Map(level.rows.map((row) => [row.key, row]));
    expect(by.get(`${ROOT}/Development`)).toMatchObject({
      collect: 'available',
      mark: 'folder',
      drillable: true,
    });
    expect(by.get(`${ROOT}/Documents`)).toMatchObject({
      collect: 'none',
      mark: 'protected',
      drillable: true,
    });
    expect(by.get(`${ROOT}/Work`)).toMatchObject({
      collect: 'none',
      mark: 'mount',
      drillable: false,
    });
    expect(by.get(`${ROOT}#small`)).toMatchObject({
      collect: 'none',
      mark: 'small',
    });
  });

  it('draws the same keys in the same order in the chart, with the next level nested, and the pile as a mark that never changes the layout', () => {
    const before = buildStorageDiskLevel({
      nodes: page(),
      rootId: ROOT,
      pile: [],
      sort: { by: 'size', direction: 'desc' },
    });
    const after = buildStorageDiskLevel({
      nodes: page(),
      rootId: ROOT,
      pile: [ref(`${ROOT}/Library/Developer`)],
      sort: { by: 'size', direction: 'desc' },
    });
    expect(before.chart.map((entry) => entry.key)).toEqual(
      before.rows.filter((row) => row.mark !== 'mount').map((row) => row.key),
    );
    const dev = before.chart.find(
      (entry) => entry.key === `${ROOT}/Development`,
    )!;
    expect(dev.children.map((entry) => [entry.key, entry.mark])).toEqual([
      [`${ROOT}/Development/happier`, 'happier'],
      [`${ROOT}/Development/website`, 'folder'],
    ]);
    // Values and order are identical: ticking only marks.
    const values = (level: typeof before) =>
      JSON.stringify(
        level.chart.map((entry) => [
          entry.key,
          entry.value,
          entry.children.map((kid) => [kid.key, kid.value]),
        ]),
      );
    expect(values(after)).toBe(values(before));
    expect(
      after.chart.find((entry) => entry.key === `${ROOT}/Library`)!.children[0],
    ).toMatchObject({ collected: true });
    expect(
      after.rows.find((row) => row.key === `${ROOT}/Library`),
    ).toMatchObject({ collect: 'available' });
  });

  it('says a folder Happier could not fully open as a lower bound on its row and on its Map tile and Rings arc alike', () => {
    const level = buildStorageDiskLevel({
      nodes: [
        node(ROOT, '/Users', 4_200),
        node(`${ROOT}/Movies`, ROOT, 3_000),
        node(`${ROOT}/private`, ROOT, 1_200, { verdict: 'safe', collectable: true, flags: { happier: false, protection: 'none', atLeast: true, inUse: false } }),
      ],
      rootId: ROOT,
      pile: [],
      sort: { by: 'size', direction: 'desc' },
    });
    const bounded = level.rows.find((row) => row.key === `${ROOT}/private`)!;
    const exact = level.chart.find((entry) => entry.key === `${ROOT}/Movies`)!;
    const limited = level.chart.find((entry) => entry.key === `${ROOT}/private`)!;
    expect(formatStorageDiskBytes(bounded.node)).toMatch(/^≥ /u);
    expect(toStorageDiskChartPart(limited).valueLabel).toBe(formatStorageDiskBytes(bounded.node));
    expect(toStorageDiskChartPart(exact).valueLabel).not.toContain('≥');
  });
  it('keeps the list order as the sort asks and marks a row inside a collected folder as covered', () => {
    const level = buildStorageDiskLevel({
      nodes: page(),
      rootId: ROOT,
      pile: [ref(ROOT)],
      sort: { by: 'name', direction: 'asc' },
    });
    expect(level.rows.slice(0, 4).map((row) => row.node.name)).toEqual([
      'Development',
      'Documents',
      'Library',
      'Movies',
    ]);
    expect(
      level.rows.find((row) => row.key === `${ROOT}/Movies`),
    ).toMatchObject({ collect: 'inside' });
    const since = buildStorageDiskLevel({
      nodes: page(),
      rootId: ROOT,
      pile: [],
      sort: { by: 'since', direction: 'desc' },
    });
    expect(since.rows[0]!.key).toBe(`${ROOT}/Development`);
  });

  it('reads the top of a scan (no folder opened) as the nodes whose parent is not in the page', () => {
    const level = buildStorageDiskLevel({
      nodes: page().slice(1),
      rootId: null,
      pile: [],
      sort: { by: 'size', direction: 'desc' },
    });
    expect(level.root).toBeNull();
    expect(level.rows[0]!.key).toBe(`${ROOT}/Development`);
  });
});

describe('what a chart activation opens', () => {
  const nodes = [
    node(ROOT, '/Users', 300),
    node(`${ROOT}/Development`, ROOT, 200, { childCount: 2 }),
    node(`${ROOT}/Development/happier`, `${ROOT}/Development`, 150, { childCount: 2 }),
    node(`${ROOT}/Development/happier/src`, `${ROOT}/Development/happier`, 100),
    node(`${ROOT}/Development/happier/debug.log`, `${ROOT}/Development/happier`, 30, { kind: 'file' }),
  ];
  const level = buildStorageDiskLevel({ nodes, rootId: ROOT, pile: [], sort: { by: 'size', direction: 'desc' } });
  const rows = new Map(level.rows.map((row) => [row.key, row]));
  const chartNodes = new Map<string, (typeof level.chart)[number]>();
  const visit = (list: typeof level.chart) => { for (const entry of list) { chartNodes.set(entry.key, entry); visit(entry.children); } };
  visit(level.chart);
  const open = (key: string) => resolveStorageDiskOpenTarget(key, rows, chartNodes);

  it('opens a folder on the third ring like one on the first, and a file or the level’s own smaller group nowhere', () => {
    expect(open(`${ROOT}/Development`)).toBe(`${ROOT}/Development`);
    expect(open(`${ROOT}/Development/happier/src`)).toBe(`${ROOT}/Development/happier/src`);
    expect(open(`${ROOT}/Development/happier/debug.log`)).toBeNull();
    expect(open('\u0000smaller')).toBeNull();
  });

  it('opens the folder that holds a smaller-items group, whichever layout drew it', () => {
    expect(open(`${ROOT}/Development/happier\u0000smaller`)).toBe(`${ROOT}/Development/happier`);
    expect(open(`${ROOT}/Development/happier/debug.log\u0000smaller`)).toBeNull();
  });
});

describe('storageDiskNodeName', () => {
  it('names the folded row by how many small items it holds, never by the producer name', () => {
    expect(storageDiskNodeName(node('/home/u#small', '/home/u', 1, { kind: 'small-items', name: 'Small items', items: 1204 })))
      .toBe('1,204 small items');
  });
  it('keeps a real folder name', () => {
    expect(storageDiskNodeName(node('/home/u/Movies', '/home/u', 1))).toBe('Movies');
  });
});

describe('the phone path', () => {
  const crumb = (label: string, nodeId?: string) => ({ key: nodeId ?? '', label, nodeId });
  const deep = [crumb('System disk'), crumb('home', '/home'), crumb('happier', '/home/happier'), crumb('j8d-resource', '/home/happier/j8d-resource')];

  it('folds the ancestors between the disk and the open folder into one crumb that goes up a level', () => {
    expect(foldStorageDiskCrumbs(deep, true).map((entry) => entry.label)).toEqual(['System disk', 'happier', 'j8d-resource']);
    const folded = foldStorageDiskCrumbs(deep, true)[1]!;
    expect(folded).toMatchObject({ folded: true, nodeId: '/home/happier' });
  });

  it('keeps a short path whole, and every ancestor on a wide screen', () => {
    const short = deep.slice(0, 3);
    expect(foldStorageDiskCrumbs(short, true)).toBe(short);
    expect(foldStorageDiskCrumbs(deep, false)).toBe(deep);
  });
});
