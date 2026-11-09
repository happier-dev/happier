import { describe, expect, it } from 'vitest';

import { createProcessesAnswer, processRow } from './testkit/processesAnswerFixture';
import {
  buildMachineProcessesView,
  isProcessRowEmphasized,
  mergeStableProcessOrder,
  selectMachineProcessesTotals,
  type ProcessesItem,
} from './processesPresentation';
import { resolveOwnershipLabel } from './ownershipLabelPresentation';
import { resolveMachineCpuCapacityCores } from '@/components/machines/vitals/machineVitalsPresentation';

const keys = (items: readonly ProcessesItem[]) => items.map((item) => item.key);
const byKey = (items: readonly ProcessesItem[], key: string) =>
  items.find((item) => item.key === key);

describe('buildMachineProcessesView', () => {
  it('shows browser group figures while retaining helper refs and unchanged owner totals', () => {
    const browser = processRow('browser', 'driver', { role: 'browser', browserEngine: 'chromium', browserHelper: false,
      driverLabel: 'node playwright test', memoryBytes: 10, cpuPercent: 1,
      browserGroup: { memberRefs: ['browser', 'helper'], totals: { processCount: 2, memoryBytes: 70, cpuPercent: 3 } } });
    const answer = createProcessesAnswer({ owners: [{ rowId: 'session:browser', owner: { kind: 'session', sessionId: 'browser' },
      state: 'running', members: [processRow('runner', 'session:browser', { memoryBytes: 100, cpuPercent: 0 }),
        processRow('driver', 'runner', { memoryBytes: 20, cpuPercent: 1 }), browser,
        processRow('helper', 'browser', { memoryBytes: 60, cpuPercent: 2, browserEngine: 'chromium', browserHelper: true })],
      totals: { processCount: 4, memoryBytes: 190, cpuPercent: 4 } }] });
    const view = buildMachineProcessesView({ answer, scope: 'happier', sort: { key: 'memory', direction: 'descending' } });
    expect(byKey(view.items, 'p:browser')).toMatchObject({ memoryBytes: 70, cpuPercent: 3, hasChildren: true });
    expect(byKey(view.items, 'p:helper')).toMatchObject({ memoryBytes: 60, parentKey: 'p:browser', row: { ref: 'helper' } });
    expect(byKey(view.items, 'o:session:browser')).toMatchObject({ processCount: 4, memoryBytes: 190, cpuPercent: 4 });
    expect(buildMachineProcessesView({ answer, scope: 'happier', sort: { key: 'memory', direction: 'descending' }, query: 'playwright' })
      .items.some(item => item.key === 'p:browser')).toBe(true);
  });
  it('lists owners biggest first with their own totals, and nests what each started under it (the runner folds into its owner)', () => {
    const view = buildMachineProcessesView({
      answer: createProcessesAnswer(),
      scope: 'happier',
      sort: { key: 'memory', direction: 'descending' },
    });
    const owners = view.items.filter((item) => item.kind === 'owner');
    expect(owners.map((item) => item.key)).toEqual([
      'o:session:refactor',
      'o:service:website',
      'o:happier',
    ]);
    const session = byKey(view.items, 'o:session:refactor');
    expect(session).toMatchObject({
      kind: 'owner',
      parentKey: null,
      processCount: 8,
      rootRef: 'runner',
    });
    // The session's runner is the owner row itself: what it started sits one level under the owner.
    expect(byKey(view.items, 'p:runner')).toBeUndefined();
    expect(byKey(view.items, 'p:agent')).toMatchObject({
      parentKey: 'o:session:refactor',
    });
    expect(byKey(view.items, 'p:vitest')).toMatchObject({
      parentKey: 'p:shell',
    });
    // Children keep the sort inside their parent: the type checker (1.3 GB) before the agent (620 MB).
    const siblings = view.items
      .filter((item) => item.parentKey === 'o:session:refactor')
      .map((item) => item.key);
    expect(siblings.indexOf('p:tsgo')).toBeLessThan(
      siblings.indexOf('p:agent'),
    );
    // A one-process service is a leaf owner carrying its port.
    expect(byKey(view.items, 'o:service:website')).toMatchObject({
      hasChildren: false,
      ports: [{ port: 3000 }],
    });
    expect(view.leftBehind.count).toBe(3);
    expect(
      keys(view.items.filter((item) => item.group === 'leftBehind')),
    ).toEqual(['l:left-next', 'l:left-chrome', 'l:left-postgres']);
  });

  it('folds idle rows into one line per level only when sorted by CPU', () => {
    const answer = createProcessesAnswer();
    const memory = buildMachineProcessesView({
      answer,
      scope: 'happier',
      sort: { key: 'memory', direction: 'descending' },
    });
    expect(memory.items.some((item) => item.kind === 'fold')).toBe(false);
    const cpu = buildMachineProcessesView({
      answer,
      scope: 'happier',
      sort: { key: 'cpu', direction: 'descending' },
    });
    const fold = cpu.items.find(
      (item) => item.kind === 'fold' && item.parentKey === 'o:session:refactor',
    );
    expect(fold).toMatchObject({ kind: 'fold', count: 2, reason: 'mcp' });
    expect(byKey(cpu.items, 'p:mcp-github')).toBeUndefined();
    const opened = buildMachineProcessesView({
      answer,
      scope: 'happier',
      sort: { key: 'cpu', direction: 'descending' },
      unfolded: new Set([fold!.key]),
    });
    expect(byKey(opened.items, 'p:mcp-github')).toBeDefined();
  });

  it('narrows to matches inside their owner, recounts Left behind to the rows shown and says how many of all match', () => {
    const view = buildMachineProcessesView({
      answer: createProcessesAnswer(),
      scope: 'happier',
      sort: { key: 'memory', direction: 'descending' },
      query: '5173',
    });
    expect(keys(view.items)).toEqual(['o:session:refactor', 'p:vite']);
    expect(view.revealKeys).toEqual(['o:session:refactor']);
    expect(byKey(view.items, 'o:session:refactor')).toMatchObject({
      matchCount: 1,
    });
    expect(view.leftBehind.count).toBe(0);
    const dev = buildMachineProcessesView({
      answer: createProcessesAnswer(),
      scope: 'happier',
      sort: { key: 'memory', direction: 'descending' },
      query: 'dev',
    });
    // The rows shown under Left behind are exactly the selector's set — the cleanup button's count and refs.
    expect(
      dev.items
        .filter((item) => item.group === 'leftBehind')
        .map((item) => (item.kind === 'leftBehind' ? item.row.ref : null)),
    ).toEqual(dev.leftBehind.refs);
    expect(dev.leftBehind.refs).toEqual(['left-next']);
    expect(dev.match).toMatchObject({ matched: 3, total: 13 });
  });

  it('shows All processes as Happier folded into one row, other apps by app without commands, and others as one aggregate', () => {
    const answer = createProcessesAnswer({
      notHappier: [
        {
          appGroup: 'Docker Desktop',
          members: [
            {
              name: 'com.docker.backend',
              appGroup: 'Docker Desktop',
              pid: 900,
              ref: 'docker-backend',
              memoryBytes: 640,
              cpuPercent: 0.1,
            },
            {
              name: 'com.docker.virtualization',
              appGroup: 'Docker Desktop',
              pid: 901,
              ref: 'docker-vm',
              memoryBytes: 5_000,
              cpuPercent: 0.4,
            },
          ],
        },
        {
          appGroup: 'Slack',
          members: [
            {
              name: 'Slack',
              appGroup: 'Slack',
              pid: 950,
              ref: 'slack',
              memoryBytes: 100,
              cpuPercent: 0,
            },
          ],
        },
      ],
      otherPrincipals: {
        count: 214,
        memoryBytes: 21_000,
        cpuPercent: 12,
        names: ['ben', 'root'],
      },
    });
    const view = buildMachineProcessesView({
      answer,
      scope: 'all',
      sort: { key: 'memory', direction: 'descending' },
    });
    expect(view.items[0]).toMatchObject({
      kind: 'happier',
      key: 'happier',
      ownerCount: 3,
    });
    expect(view.items.filter((item) => item.kind === 'owner')).toHaveLength(0);
    expect(
      keys(
        view.items.filter(
          (item) => item.group === 'notHappier' && item.parentKey === null,
        ),
      ),
    ).toEqual(['a:Docker Desktop', 'a:Slack']);
    expect(
      keys(view.items.filter((item) => item.parentKey === 'a:Docker Desktop')),
    ).toEqual(['m:docker-vm', 'm:docker-backend']);
    expect(
      view.items.find((item) => item.kind === 'otherPeople'),
    ).toMatchObject({ count: 214, names: ['ben', 'root'] });
    for (const item of view.items)
      if (item.kind === 'appMember')
        expect(Object.keys(item.row)).not.toContain('command');
  });

  const dockerAnswer = () => createProcessesAnswer({
    notHappier: [{ appGroup: 'Docker Desktop', members: [
      { name: 'com.docker.backend', appGroup: 'Docker Desktop', pid: 900, ref: 'docker-backend', memoryBytes: 640, cpuPercent: 0.1 },
      { name: 'com.docker.virtualization', appGroup: 'Docker Desktop', pid: 901, ref: 'docker-vm', memoryBytes: 5_000, cpuPercent: 0.4 },
    ] }, { appGroup: 'Slack', members: [{ name: 'Slack', appGroup: 'Slack', pid: 950, ref: 'slack', memoryBytes: 100, cpuPercent: 0 }] }],
  });

  it('counts an external app’s matching members in the match summary and opens the app to show only them', () => {
    const view = buildMachineProcessesView({ answer: dockerAnswer(), scope: 'all', sort: { key: 'memory', direction: 'descending' }, query: 'backend' });
    expect(keys(view.items.filter((item) => item.group === 'notHappier'))).toEqual(['a:Docker Desktop', 'm:docker-backend']);
    expect(view.revealKeys).toContain('a:Docker Desktop');
    // One matching member: its own figures, never the zero a Happier-only count would give.
    expect(view.match).toMatchObject({ matched: 1, memoryBytes: 640, cpuPercent: 0.1 });
    const byApp = buildMachineProcessesView({ answer: dockerAnswer(), scope: 'all', sort: { key: 'memory', direction: 'descending' }, query: 'docker desktop' });
    expect(keys(byApp.items.filter((item) => item.kind === 'appMember'))).toEqual(['m:docker-vm', 'm:docker-backend']);
    expect(byApp.match).toMatchObject({ matched: 2, memoryBytes: 5_640 });
    // The scope's total counts the processes the search ran over, external apps included.
    expect(byApp.match!.total).toBe(view.match!.total);
    expect(view.match!.total).toBeGreaterThan(buildMachineProcessesView({ answer: dockerAnswer(), scope: 'happier', sort: { key: 'memory', direction: 'descending' }, query: 'backend' }).match!.total);
  });

  it('opens every branch above a nested match, not only its owner', () => {
    const view = buildMachineProcessesView({ answer: createProcessesAnswer(), scope: 'happier', sort: { key: 'memory', direction: 'descending' }, query: 'vitest' });
    expect(keys(view.items)).toEqual(expect.arrayContaining(['o:session:refactor', 'p:shell', 'p:vitest']));
    expect(view.revealKeys).toEqual(expect.arrayContaining(['o:session:refactor', 'p:shell']));
    // The match itself is not a branch to open, and an unrelated owner opens nothing.
    expect(view.revealKeys).not.toContain('p:vitest');
    expect(view.revealKeys).not.toContain('o:service:website');
  });

  it('finds an owned row by the display name the daemon gave it', () => {
    const answer = createProcessesAnswer();
    const vite = answer.owners.flatMap((owner) => owner.members).find((row) => row.ref === 'vite')!;
    vite.displayName = 'Storybook';
    vite.command = 'node node_modules/.bin/dev';
    const view = buildMachineProcessesView({ answer, scope: 'happier', sort: { key: 'memory', direction: 'descending' }, query: 'storybook' });
    expect(keys(view.items)).toContain('p:vite');
  });

  it('lets a stopped row leave without changing anything else', () => {
    const view = buildMachineProcessesView({
      answer: createProcessesAnswer(),
      scope: 'happier',
      sort: { key: 'memory', direction: 'descending' },
      hidden: new Set(['o:service:website']),
    });
    expect(byKey(view.items, 'o:service:website')).toBeUndefined();
    expect(byKey(view.items, 'o:happier')).toBeDefined();
  });

  it('owners-only builds the read-only Using the most rows (VU-7), biggest N first', () => {
    const view = buildMachineProcessesView({
      answer: createProcessesAnswer(),
      scope: 'happier',
      sort: { key: 'memory', direction: 'descending' },
      ownersOnly: true,
      limit: 2,
    });
    expect(keys(view.items)).toEqual([
      'o:session:refactor',
      'o:service:website',
    ]);
  });
});

describe('the Left behind filter (widgets\u2019 Clean up)', () => {
  it('keeps only what ended sessions left running, with the same count and totals', () => {
    const answer = createProcessesAnswer();
    const all = buildMachineProcessesView({ answer, scope: 'happier', sort: { key: 'memory', direction: 'descending' } });
    const only = buildMachineProcessesView({ answer, scope: 'happier', sort: { key: 'memory', direction: 'descending' }, leftBehindOnly: true });
    expect(only.items.length).toBeGreaterThan(0);
    expect(only.items.every((item) => item.kind === 'leftBehind')).toBe(true);
    expect(only.items.map((item) => item.key)).toEqual(all.items.filter((item) => item.kind === 'leftBehind').map((item) => item.key));
    expect(only.leftBehind).toEqual(all.leftBehind);
  });
});

describe('totals, labels, emphasis and stable order', () => {
  it('splits the machine into Happier and everything else from the same answer and vitals', () => {
    const totals = selectMachineProcessesTotals(createProcessesAnswer(), {
      usedMemoryBytes: 20 * 1024 ** 3,
      cpuBusyPercent: 12,
    });
    expect(totals.happier.processCount).toBe(10);
    expect(totals.everythingElse.memoryBytes).toBe(
      // Left behind is listed above the totals, so it is not part of everything else either.
      20 * 1024 ** 3 - (totals.happier.memoryBytes ?? 0) - (totals.leftBehind.memoryBytes ?? 0),
    );
    expect(totals.everythingElse.cpuPercent).toBeCloseTo(
      12 - (totals.happier.cpuPercent ?? 0) - (totals.leftBehind.cpuPercent ?? 0),
    );
    expect(
      selectMachineProcessesTotals(createProcessesAnswer(), null)
        .everythingElse,
    ).toEqual({ memoryBytes: null, cpuPercent: null });
  });

  it('labels only what is not proven', () => {
    expect(resolveOwnershipLabel('proven')).toBeNull();
    expect(resolveOwnershipLabel('likely')).toMatchObject({
      labelKey: 'machineProcesses.ownership.likely',
    });
    expect(resolveOwnershipLabel('left_behind')).toMatchObject({
      labelKey: 'machineProcesses.ownership.leftBehind',
    });
    expect(resolveOwnershipLabel('not_happier')).toMatchObject({
      labelKey: 'machineProcesses.ownership.notHappiers',
    });
  });

  it('takes emphasis at one full core or when left behind', () => {
    const capacity = resolveMachineCpuCapacityCores({ logicalCores: 18, effectiveCores: 1.26 });
    expect(isProcessRowEmphasized({ cpuPercent: 77.5, level: 'proven' }, capacity)).toBe(false);
    expect(isProcessRowEmphasized({ cpuPercent: 80, level: 'proven' }, capacity)).toBe(true);
    expect(isProcessRowEmphasized({ cpuPercent: 100, level: 'proven' }, 0.5)).toBe(false);
    expect(isProcessRowEmphasized({ cpuPercent: 25, level: 'proven' }, 4)).toBe(
      true,
    );
    expect(
      isProcessRowEmphasized({ cpuPercent: 24.9, level: 'proven' }, 4),
    ).toBe(false);
    expect(
      isProcessRowEmphasized({ cpuPercent: 0, level: 'left_behind' }, 4),
    ).toBe(true);
    expect(
      isProcessRowEmphasized({ cpuPercent: 99, level: 'proven' }, null),
    ).toBe(false);
  });

  it('keeps the order under the pointer: known rows hold their place, new ones join the end', () => {
    expect(mergeStableProcessOrder(['a', 'b', 'c'], ['c', 'd', 'a'])).toEqual([
      'a',
      'c',
      'd',
    ]);
  });
});
