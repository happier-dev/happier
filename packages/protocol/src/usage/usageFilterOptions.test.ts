import { describe, expect, it } from 'vitest';

import { projectProjectListV1 } from '../projects/projectListProjectionV1.js';
import type { UsageQueryResultSlice } from './resolveUsagePageAggregation.js';
import { projectUsageOptionFacts, readUsageScopeOptions } from './usageFilterOptions.js';

const entry = (key: string, label?: string) => ({
  key,
  ...(label ? { label } : {}),
  eventCount: 1,
  tokens: {
    input: 1,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 1,
  },
  cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
});

describe('readUsageScopeOptions Projects (owner 11-08)', () => {
  it('qualifies colliding Projects by Machine or checkout place and uses the shared fallback when human places coincide', () => {
    const slices = [{ accounting: {
      scopeKeys: [{ dimension: 'project', keys: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        projectMachines: [
          { key: 'a', machineIds: ['laptop'] }, { key: 'b', machineIds: ['desktop'] },
          { key: 'c', machineIds: ['laptop'] }, { key: 'd', machineIds: ['laptop'] },
        ] }],
      breakdowns: { project: [entry('a', 'happier'), entry('b', 'happier'), entry('c', 'tmp'), entry('d', 'tmp'),
        entry('e', 'docs'), entry('f', 'unknown place'), entry('g', 'unknown place')] },
    } }] as unknown as UsageQueryResultSlice[];
    expect([...readUsageScopeOptions(slices, 'projects', [], undefined, {
      machineNames: { laptop: 'Laptop', desktop: 'Desktop' },
      projectFacts: new Map([['a', { baselineMachineId: 'laptop' }], ['b', { baselineMachineId: 'desktop' }],
        ['c', { baselineMachineId: 'laptop', rootPath: '/work/first/tmp' }],
        ['d', { baselineMachineId: 'laptop', rootPath: 'C:\\work\\second\\tmp' }]]),
    })]).toEqual([
      ['a', 'happier · Laptop'], ['b', 'happier · Desktop'],
      ['c', 'tmp · first'], ['d', 'tmp · second'],
      ['e', 'docs'], ['f', 'unknown place · 1'], ['g', 'unknown place · 2'],
    ]);
  });

  it('uses a checkout tail for numeric place names and never borrows an accounting Machine as a qualifier', () => {
    const projects = [entry('a', 'workspace'), entry('b', 'workspace')];
    const machines = { box: 'Dev box', owner: 'Owner machine' };
    const projectFacts = new Map([
      ['a', { baselineMachineId: 'box', rootPath: '/private/19/workspace/' }],
      ['b', { baselineMachineId: 'box', rootPath: 'C:\\private\\21\\workspace\\' }],
    ]);
    const read = (rows: typeof projects, facts?: typeof projectFacts) => readUsageScopeOptions(
      [{ accounting: {
        scopeKeys: [{ dimension: 'project', keys: ['a', 'b'],
          projectMachines: [{ key: 'a', machineIds: ['owner'] }, { key: 'b', machineIds: ['box'] }] }],
        breakdowns: { project: rows },
      } }] as unknown as UsageQueryResultSlice[],
      'projects', [], undefined, { projectFacts: facts, machineNames: machines },
    );

    const admitted = read(projects, projectFacts);
    expect(admitted).toEqual(new Map([['a', 'workspace · 19/workspace'], ['b', 'workspace · 21/workspace']]));
    expect(read([...projects].reverse(), new Map([...projectFacts].reverse()))).toEqual(admitted);
    expect(read(projects)).toEqual(new Map([['a', 'workspace · 1'], ['b', 'workspace · 2']]));
  });

  it('offers every scope key even when its ranked breakdown omits members', () => {
    // Accounting transport boundary: complete identities accompany a ranked chart.
    const slices = [{ accounting: {
      scopeKeys: [
        { dimension: 'project', keys: ['named', 'unnamed-a', 'unnamed-b', 'unknown'] },
        { dimension: 'agent', keys: ['claude', 'codex'] },
        { dimension: 'machine', keys: ['machine-a', 'machine-b'] },
        { dimension: 'source', keys: ['runtime', 'native'] },
      ],
      breakdowns: { project: [entry('named', 'Named project'), entry('unnamed-a')] },
    } }] as unknown as UsageQueryResultSlice[];
    expect([...readUsageScopeOptions(slices, 'projects')]).toEqual([
      ['named', 'Named project'], ['unnamed-a', 'No project name'], ['unnamed-b', 'No project name'], ['unknown', 'No project name'],
    ]);
    expect([...readUsageScopeOptions(slices, 'agents').keys()]).toEqual(['claude', 'codex']);
    expect([...readUsageScopeOptions(slices, 'machines').keys()]).toEqual(['machine-a', 'machine-b']);
    expect([...readUsageScopeOptions(slices, 'sources').keys()]).toEqual(['runtime', 'native']);
  });

  it('advances only conflicting titles when a Machine name matches another checkout’s parent', () => {
    const slices = [{ accounting: {
      scopeKeys: [{ dimension: 'project', keys: ['a', 'b', 'c'], projectMachines: [
        { key: 'a', machineIds: ['dev'] }, { key: 'b', machineIds: ['build'] }, { key: 'c', machineIds: ['build'] },
      ] }],
      breakdowns: { project: ['a', 'b', 'c'].map(key => entry(key, 'tmp')) },
    } }] as unknown as UsageQueryResultSlice[];
    const options = readUsageScopeOptions(slices, 'projects', [], undefined, {
      machineNames: { dev: 'Dev', build: 'Build' },
      projectFacts: new Map([['a', { baselineMachineId: 'dev' }],
        ['b', { baselineMachineId: 'build', rootPath: '/work/Dev/tmp' }],
        ['c', { baselineMachineId: 'build', rootPath: '/work/Other/tmp' }]]),
    });
    expect([...options.values()]).toEqual(['tmp · Dev', 'tmp · /work/Dev/tmp', 'tmp · Other']);
  });

  it('keeps a unique accounting title when an unlabeled checkout supplies a basename', () => {
    const { projectGroups } = projectProjectListV1({ serverId: 'home', workspaceRefs: [
      { id: 'checkout', projectKey: 'app', serverId: 'home', machineId: 'dev', rootPath: '/work/repo', createdAtMs: 0 },
    ] });
    const slices = [{ accounting: { breakdowns: { project: [entry('app', 'App')] } } }] as unknown as UsageQueryResultSlice[];
    expect([...readUsageScopeOptions(slices, 'projects', [], undefined, {
      projectFacts: projectUsageOptionFacts(projectGroups, []),
    })]).toEqual([['app', 'App']]);
  });
  it('offers a grouped Project once, under its current anchor, for usage stamped by any of its checkouts', () => {
    const slices = [
      {
        accounting: {
          breakdowns: {
            project: [entry('payments', 'Payments'), entry('nldw6')],
          },
        },
      },
    ] as unknown as UsageQueryResultSlice[];
    const anchorOf = (key: string) => (key === 'nldw6' ? 'payments' : key);
    expect([
      ...readUsageScopeOptions(slices, 'projects', [], anchorOf),
    ]).toEqual([['payments', 'Payments']]);
    // Without the census the stamped keys stay as they are.
    expect(
      [...readUsageScopeOptions(slices, 'projects')].map(([key]) => key),
    ).toEqual(['payments', 'nldw6']);
  });
});
