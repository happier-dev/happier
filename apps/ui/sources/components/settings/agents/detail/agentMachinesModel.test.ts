import { describe, expect, it } from 'vitest';

import type {
  MachineAgent,
  MachineAgentJob,
} from '@/agents/machineAgents/machineAgentTypes';
import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
import {
  MachineAgentInventoryItemSchema,
  type MachineAgentInventoryItem,
} from '@happier-dev/protocol/capabilities';

import { createMachineFixture } from '@/dev/testkit';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';

import {
  buildAgentMachineRows,
  countAgentMachineRowsToShow,
  listAgentMachines,
  type AgentMachinesMachine,
} from './agentMachinesModel';

function machine(
  machineId: string,
  overrides: Partial<AgentMachinesMachine> = {},
): AgentMachinesMachine {
  return {
    machineId,
    serverId: 'srv',
    name: machineId,
    sentenceName: machineId,
    namePending: false,
    os: 'Linux',
    online: true,
    lastSeenAt: null,
    ...overrides,
  };
}

/** Facts in the daemon's strict inventory shape, so the model reads what a machine really answers. */
function facts(
  overrides: Partial<MachineAgentInventoryItem> = {},
): MachineAgentInventoryItem {
  return MachineAgentInventoryItemSchema.parse({
    agentId: 'custom-acp',
    definitionId: 'goose-def',
    title: 'goose',
    installed: true,
    managed: true,
    version: '1.52.1',
    latestVersion: null,
    update: { supported: false, command: null },
    signIn: {
      status: 'signedIn',
      required: true,
      loginSupport: 'login_terminal',
    },
    platform: { supported: true },
    install: {
      available: true,
      mode: 'managed',
      sizeBytes: 118_000_000,
      guideUrl: null,
    },
    dependencies: [],
    ...overrides,
  });
}

function agent(
  itemFacts: MachineAgentInventoryItem | null,
  options: Partial<{ stale: boolean; job: MachineAgentJob | null; probeFailed: boolean }> = {},
): MachineAgent {
  return projectMachineAgent({
    agentId: 'custom-acp',
    definitionId: 'goose-def',
    title: 'goose',
    facts: itemFacts,
    checking: false,
    stale: options.stale ?? false,
    connectedServices: [],
    job: options.job ?? null,
    ...(options.probeFailed ? { unavailableReason: { reason: 'probe_failed' as const } } : {}),
  });
}

function rowsFor(
  entries: ReadonlyArray<readonly [AgentMachinesMachine, MachineAgent | null]>,
  pinnedVersion: string | null = '1.52.1',
) {
  return buildAgentMachineRows({
    machines: entries.map(([m]) => m),
    agentsByMachineId: new Map(entries.map(([m, a]) => [m.machineId, a])),
    inventoryStatusByMachineId: new Map(entries.map(([m, a]) => [m.machineId,
      !m.online ? 'offline' : a?.staleReason === 'error' ? 'error' : a ? 'ready' : 'loading'])),
    pinnedVersion,
  });
}

const kinds = (row: { actions: readonly { kind: string }[] }) =>
  row.actions.map((action) => action.kind);

describe('buildAgentMachineRows', () => {
  it('says "couldn\'t check" once at most: the unanswered machines wait behind "N more", after the ones with news', () => {
    const answers = new Map([['ready', 'ready'], ['a', 'error'], ['b', 'error'], ['c', 'error']] as const);
    const machines = [machine('a'), machine('b'), machine('ready'), machine('c')];
    const rows = buildAgentMachineRows({
      machines,
      agentsByMachineId: new Map(machines.map((m) => [m.machineId, m.machineId === 'ready' ? agent(facts()) : null])),
      inventoryStatusByMachineId: answers,
      pinnedVersion: null,
    });
    expect(rows[0]?.machine.machineId).toBe('ready');
    expect(countAgentMachineRowsToShow(rows)).toBe(1);
    const unanswered = rows.filter((row) => row.status.kind === 'unknown');
    expect(unanswered).toHaveLength(3);
    expect(countAgentMachineRowsToShow(unanswered)).toBe(1);
  });

  it('distinguishes a cold inventory failure from checking, offline and a detected missing install', () => {
    const rows = buildAgentMachineRows({
      machines: [machine('failed'), machine('checking'), machine('away', { online: false }), machine('missing')],
      agentsByMachineId: new Map([['missing', agent(facts({ installed: false, version: null }))]]),
      inventoryStatusByMachineId: new Map([['failed', 'error'], ['checking', 'loading'], ['away', 'error'], ['missing', 'ready']]),
      pinnedVersion: null,
    });
    expect(rows.map(row => [row.machine.machineId, row.status.kind, kinds(row)])).toEqual([
      ['failed', 'unknown', ['checkAgain']],
      ['checking', 'checking', []],
      ['missing', 'notInstalled', ['install']],
      ['away', 'offline', []],
    ]);
  });
  it('gives one row per known machine with its own status and actions from detection', () => {
    const rows = rowsFor([
      [machine('ready'), agent(facts())],
      [
        machine('signin'),
        agent(
          facts({
            signIn: {
              status: 'signedOut',
              required: true,
              loginSupport: 'login_terminal',
            },
          }),
        ),
      ],
      [machine('missing'), agent(facts({ installed: false, version: null }))],
    ]);

    expect(
      rows.map((row) => [row.machine.machineId, row.status.kind, kinds(row)]),
    ).toEqual([
      ['ready', 'ready', ['remove']],
      ['signin', 'needsSignIn', ['signIn', 'remove']],
      ['missing', 'notInstalled', ['install']],
    ]);
    expect(rows[0]?.version).toBe('1.52.1');
    expect(rows[2]?.version).toBeNull();
  });

  it('offers Update to the chosen registry version when the installed one differs', () => {
    const [row] = rowsFor(
      [[machine('mbp'), agent(facts({ version: '1.52.1' }))]],
      '1.54.0',
    );

    expect(kinds(row!)).toEqual(['update', 'remove']);
    expect(row!.status).toMatchObject({ kind: 'ready', updateTo: '1.54.0' });
  });

  it('shows a running install as progress with Cancel, and a failed one with Try again', () => {
    const running: MachineAgentJob = {
      jobId: 'j1',
      intent: 'install',
      startedAtMs: 1,
      logLine: null,
      outcome: null,
      steps: [
        {
          stepId: 'download',
          label: 'Downloading',
          state: 'running',
          bytesDone: 76,
          bytesTotal: 118,
        },
      ],
    };
    const failed: MachineAgentJob = {
      ...running,
      jobId: 'j2',
      steps: [],
      outcome: {
        kind: 'failed',
        code: 'download_failed',
        stepId: 'download',
        message: 'The download stopped.',
      },
    };
    const rows = rowsFor([
      [
        machine('a'),
        agent(facts({ installed: false, version: null }), { job: running }),
      ],
      [
        machine('b'),
        agent(facts({ installed: false, version: null }), { job: failed }),
      ],
    ]);

    expect(rows.map((row) => [row.status.kind, kinds(row)])).toEqual([
      ['installing', ['cancel']],
      ['failed', ['retry']],
    ]);
  });

  it('says why a machine cannot run it, offers nothing there, and sorts it after the machines that can', () => {
    const rows = rowsFor([
      [
        machine('win', { os: 'Windows' }),
        agent(
          facts({
            installed: false,
            version: null,
            platform: { supported: false, reason: 'arch' },
            fit: { kind: 'cant_run', reason: 'no_build_for_platform' },
          }),
        ),
      ],
      [machine('nl2'), agent(facts())],
    ]);

    expect(rows.map((row) => row.machine.machineId)).toEqual(['nl2', 'win']);
    expect(rows[1]).toMatchObject({
      status: { kind: 'unsupported', reason: 'arch' },
      actions: [],
      expandable: false,
    });
  });

  it('offers Try again only on an online machine whose check failed', () => {
    const rows = rowsFor([
      [machine('failed'), agent(facts(), { probeFailed: true })],
      [machine('away', { online: false }), agent(facts(), { stale: true })],
    ]);

    expect(rows.map((row) => [row.machine.machineId, row.status.kind, kinds(row)])).toEqual([
      ['away', 'offline', []],
      ['failed', 'unavailable', ['checkAgain']],
    ]);
    expect(rows[1]?.status).toMatchObject({ kind: 'unavailable', reason: { reason: 'probe_failed' } });
  });

  it('offers no Try again on a machine whose check is already on its way', () => {
    const rows = buildAgentMachineRows({
      machines: [machine('rechecking')],
      agentsByMachineId: new Map([['rechecking', agent(facts(), { probeFailed: true })]]),
      inventoryStatusByMachineId: new Map([['rechecking', 'loading']]),
      pinnedVersion: null,
    });
    expect(kinds(rows[0]!)).toEqual([]);
  });

  it('holds the machines\' own order until every online check has answered, then ranks them', () => {
    const entries = [
      [machine('bare'), agent(facts({ installed: false, version: null }))],
      [machine('pending'), null],
      [machine('installed'), agent(facts())],
    ] as const;
    const build = (pendingStatus: 'loading' | 'ready') => buildAgentMachineRows({
      machines: entries.map(([m]) => m),
      agentsByMachineId: new Map(entries.map(([m, a]) => [m.machineId, a])),
      inventoryStatusByMachineId: new Map([['bare', 'ready'], ['pending', pendingStatus], ['installed', 'ready']]),
      pinnedVersion: null,
    }).map((row) => row.machine.machineId);

    expect(build('loading')).toEqual(['bare', 'pending', 'installed']);
    expect(build('ready')).toEqual(['installed', 'bare', 'pending']);
  });

  it('keeps an offline machine last, with its last-known state and no actions', () => {
    const rows = rowsFor([
      [
        machine('away', { online: false, lastSeenAt: 10 }),
        agent(facts(), { stale: true }),
      ],
      [machine('never', { online: false }), null],
      [machine('here'), agent(facts())],
    ]);

    expect(
      rows.map((row) => [row.machine.machineId, row.status, kinds(row)]),
    ).toEqual([
      ['here', expect.objectContaining({ kind: 'ready' }), ['remove']],
      ['away', { kind: 'offline', tone: 'quiet', lastKnown: 'signedIn' }, []],
      ['never', { kind: 'offline', tone: 'quiet', lastKnown: 'unknown' }, []],
    ]);
  });

  it('hides Remove for an install made outside Happier and says so', () => {
    const [row] = rowsFor([[machine('mbp'), agent(facts({ managed: false }))]]);

    expect(kinds(row!)).toEqual([]);
    expect(row!.installedOutsideHappier).toBe(true);
  });
});

describe('listAgentMachines', () => {
  const pickerRow = (machine: ReturnType<typeof createMachineFixture>) =>
    ({
      machine,
      serverId: 'srv',
      candidate: { displayName: 'candidate', availability: 'online', observedAt: 5 },
    }) as unknown as Parameters<typeof listAgentMachines>[0][number];

  it('titles a machine whose name is still loading apart from the name copy puts in a sentence', () => {
    const [loading] = listAgentMachines([pickerRow(createMachineFixture({ id: 'm1', metadata: null, availability: undefined }))]);

    expect(loading!.name).toBe(getMachineDisplayName({ id: 'm1', metadata: null }));
    expect(loading!.sentenceName).toBe(t('machine.thisMachineInSentence'));
    expect(loading!.namePending).toBe(true);
  });

  it('names a loaded machine the same in the title and in a sentence', () => {
    const named = createMachineFixture({ id: 'm2', metadata: { ...createMachineFixture().metadata!, displayName: 'Studio Mac' } });
    const [machine] = listAgentMachines([pickerRow(named)]);

    expect(machine!.name).toBe('Studio Mac');
    expect(machine!.sentenceName).toBe('Studio Mac');
    expect(machine!.namePending).toBe(false);
  });
});
