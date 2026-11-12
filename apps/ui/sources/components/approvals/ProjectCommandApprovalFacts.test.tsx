import { afterEach, describe, expect, it, vi } from 'vitest';

import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ProjectPrepareInputV1Schema } from '@happier-dev/protocol/actions/projectActionFamily';
import { ProjectSetupReviewV1Schema } from '@happier-dev/protocol/actions/projectSetupConsentFailure';
import { MachinePoolViewV1Schema } from '@happier-dev/protocol/machines/pools';
import { LocalServiceStartApprovalReviewV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';

/** The value beside a facts row's key (the shared approval fields draw label then value). */
type FactNode = { props: { children?: unknown } };
function factValue(host: { findAll: (predicate: (node: FactNode) => boolean) => FactNode[] } | null | undefined): unknown {
    return host?.findAll((node) => typeof node.props.children === 'string').at(-1)?.props.children;
}


(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installSessionSubagentCommonModuleMocks({
  storage: () =>
    vi.importActual<typeof import('@/sync/domains/state/storage')>(
      '@/sync/domains/state/storage',
    ),
  text: () => vi.importActual<typeof import('@/text')>('@/text'),
});
const {
  ProjectCommandApprovalFacts,
  describeProjectCommandApprovalDecisions,
  describeProjectCommandApprovalTitle,
  readProjectCommandApproval,
  readProjectServiceEffectApproval,
} = await import('./ProjectCommandApprovalFacts');
const { getStorage } = await import('@/sync/domains/state/storage');
const originalMachinePools = getStorage().getState().machinePoolListByServerId;

afterEach(() => {
  standardCleanup();
  getStorage().setState({ machinePoolListByServerId: originalMachinePools });
});

const workspace = {
  serverId: 'home',
  machineId: 'devbox',
  workspaceId: 'checkout',
  rootPath: '/src/happier',
};

describe('Project command approval facts', () => {
  it('discloses the retained native Start effect as the parent Restart decision', async () => {
    const start = { machineId: 'devbox', targetId: 'web', workspace,
      declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest', name: 'web' } },
      expectedEffectDigest: 'a'.repeat(64) };
    const review = LocalServiceStartApprovalReviewV1Schema.parse({ request: start, target: workspace, reviewedEffectDigest: start.expectedEffectDigest,
      setup: { required: false, project: { serverId: workspace.serverId, projectId: 'project' },
        reviewedEffectDigest: 'b'.repeat(64), reviewedEffect: {} },
      reviewedEffect: { command: { source: { kind: 'command', command: 'serve replacement web' } } } });
    const approval = { actionId: 'localServices.actions.restartManaged' as const,
      actionArgs: { requestId: 'restart', action: 'restart_managed',
        target: { kind: 'managed_service', machineId: 'devbox', managedServiceId: 'old' } },
      preview: { hostReviewedContent: { serviceStartReview: review },
        hostReviewedChildren: { children: [{ action: 'localServices.launcher.start', role: 'service.restart.start', input: start }] } } };
    const presentation = readProjectCommandApproval(approval);
    expect(presentation).toMatchObject({ kind: 'service', name: 'web', command: 'serve replacement web' });
    if (!presentation) throw new Error('Missing parent Restart effect review');
    expect(describeProjectCommandApprovalTitle(presentation, 'devbox')).toBe('Restart web?');
    expect(describeProjectCommandApprovalDecisions(presentation)).toEqual({ approve: 'Restart', reject: 'Not now' });
    const screen = await renderScreen(<ProjectCommandApprovalFacts presentation={presentation} testID="facts" />);
    expect(screen.getTextContent()).toContain('serve replacement web');
    expect(readProjectCommandApproval({ ...approval, preview: { ...approval.preview,
      hostReviewedChildren: { children: [{ action: 'localServices.launcher.start', role: 'service.restart.start',
        input: { ...start, targetId: 'other' } }] } } })).toBeNull();
  });
  it('discloses incoming setup in the same Move approval for an agent request', async () => {
    const destination = { kind: 'workers', destination: { kind: 'machine', machineId: 'worker' } };
    const address = { serverId: 'home', refId: 'checkout' };
    const setupReview = { reviewedEffectDigest: 'a'.repeat(64), reviewedEffect: { commands: [{ kind: 'command', command: 'install on destination' }] } };
    const presentation = readProjectCommandApproval({ actionId: 'projects.service.relocate', actionArgs: {
      workspace: address, sourceMachineId: 'devbox', serviceName: 'web', requestId: 'move',
      currentTarget: { kind: 'managed_service', managedServiceId: 'old', machineId: 'incumbent' },
      destination, selectedTarget: { machineId: 'worker' }, setupReview,
      desiredPlacement: { workspace: address, serviceName: 'web', expectedRevision: 'absent', expected: { kind: 'absent' }, value: { runsOn: destination, unavailable: 'fail' } },
    } });
    expect(presentation).toMatchObject({ kind: 'service', setupReview, destination: { kind: 'machine', machineId: 'worker' } });
    if (!presentation) throw new Error('Missing Move review');
    expect(describeProjectCommandApprovalDecisions(presentation).approve).toBe('Move service');
    const screen = await renderScreen(<ProjectCommandApprovalFacts presentation={presentation} testID="facts" />);
    expect(screen.getTextContent()).toContain('install on destination');
    await screen.unmount();
  });
  it('renders the native declared Service review with its exact target and setup before approval', async () => {
    const request = { machineId: 'worker', targetId: 'web', workspace,
      declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest', name: 'web' } },
      choice: { kind: 'workers', destination: { kind: 'pool', poolId: '11111111-1111-4111-8111-111111111111', selection: 'automatic' } } };
    const target = { ...workspace, machineId: 'worker', workspaceId: 'worker-checkout', rootPath: '/copies/happier' };
    const review = { request, target, reviewedEffectDigest: 'a'.repeat(64),
      reviewedEffect: { command: { source: { kind: 'command', command: 'serve web' } } },
      setup: { required: true, project: { serverId: workspace.serverId, projectId: 'project' },
        reviewedEffectDigest: 'b'.repeat(64), reviewedEffect: { commands: [{ kind: 'command', command: 'install dependencies' }] } } };
    const presentation = readProjectCommandApproval({ actionId: 'localServices.launcher.start', actionArgs: request,
      preview: { serviceStartReview: review } });
    expect(presentation).toMatchObject({ kind: 'service', destination: { kind: 'machine', machineId: 'worker' }, workspace: target });
    if (!presentation) throw new Error('Missing qualified Service review');
    // A requested Start reads as starting that Service where it runs, and decides as the Services page does.
    expect(presentation).toMatchObject({ name: 'web' });
    expect(describeProjectCommandApprovalTitle(presentation, 'devbox', 'worker box')).toBe('Start web on worker box?');
    expect(describeProjectCommandApprovalDecisions(presentation)).toEqual({ approve: 'Start', reject: 'Not now' });
    const screen = await renderScreen(<ProjectCommandApprovalFacts presentation={presentation} testID="facts" />);
    expect(screen.getTextContent()).toContain('serve web');
    expect(screen.getTextContent()).toContain('install dependencies');
    expect(factValue(screen.findHostByTestId('facts.rows.row:checkout'))).toBe(target.rootPath);
    expect(screen.findByTestId('facts.rows.row:files')).not.toBeNull();
    expect(readProjectCommandApproval({ actionId: 'localServices.launcher.start', actionArgs: { ...request, machineId: 'other' },
      preview: { serviceStartReview: review } })).toBeNull();
    const local = { ...request, machineId: workspace.machineId, choice: { kind: 'primary' } };
    expect(readProjectCommandApproval({ actionId: 'localServices.launcher.start', actionArgs: local,
      preview: { serviceStartReview: { ...review, request: local, target: workspace } } }))
      .toMatchObject({ destination: { kind: 'primary' } });
  });
  it('says nothing about files for a Service that starts where its checkout is, and keeps the copy a worker needs', async () => {
    const request = { machineId: 'devbox', targetId: 'web', workspace,
      declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest', name: 'web' } },
      choice: { kind: 'primary' } };
    const review = { request, target: workspace, reviewedEffectDigest: 'a'.repeat(64),
      reviewedEffect: { command: { source: { kind: 'command', command: 'serve web' } } },
      setup: { required: true, project: { serverId: workspace.serverId, projectId: 'project' },
        reviewedEffectDigest: 'b'.repeat(64), reviewedEffect: { commands: [{ kind: 'command', command: 'install dependencies' }] } } };
    const presentation = readProjectCommandApproval({ actionId: 'localServices.launcher.start', actionArgs: request,
      preview: { serviceStartReview: review } });
    if (!presentation) throw new Error('Missing Service review');
    const here = await renderScreen(<ProjectCommandApprovalFacts presentation={presentation} testID="facts" />);
    expect(here.findByTestId('facts.rows.row:checkout')).not.toBeNull();
    expect(here.findByTestId('facts.rows.row:files')).toBeNull();
    await here.unmount();
  });

  it.each(['projects.script.run', 'projects.prepare'] as const)('renders distinct checkout identities for %s on the same Machine', async actionId => {
    const read = (selected: typeof workspace) => readProjectCommandApproval({ actionId,
      actionArgs: actionId === 'projects.prepare' ? { workspace: selected, phase: 'setup' }
        : { workspace: selected, selection: { kind: 'named', name: 'test' },
          choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'shared-worker' } } },
    });
    const other = { ...workspace, workspaceId: 'second-checkout', rootPath: '/src/happier-next' };
    expect(read(workspace)).toMatchObject({ workspace });
    expect(read(other)).toMatchObject({ workspace: other });
    expect(read(workspace)).not.toEqual(read(other));
    for (const selected of [workspace, other]) {
      const presentation = read(selected);
      if (!presentation) throw new Error('Expected a valid Project approval');
      const screen = await renderScreen(<ProjectCommandApprovalFacts presentation={presentation} testID="facts" />);
      expect(factValue(screen.findHostByTestId('facts.rows.row:checkout'))).toBe(selected.rootPath);
      await screen.unmount();
    }
  });

  it('names the requested pool from its current Home-scoped definition', async () => {
    const poolId = '11111111-1111-4111-8111-111111111111';
    const pool = MachinePoolViewV1Schema.parse({
      pool: { id: poolId, name: 'Build workers', description: null, revision: 1,
        createdAt: 1, updatedAt: 1, members: [] },
      availability: { state: 'known', connectedCount: 0, enabledCount: 0 },
    });
    getStorage().setState({ machinePoolListByServerId: { home: [pool] } });
    const presentation = readProjectCommandApproval({
      actionId: 'projects.compute.exec',
      actionArgs: { workspace, executable: 'tool', argv: [], cwd: workspace.rootPath,
        choice: { kind: 'workers', destination: { kind: 'pool', poolId, selection: 'automatic' } } },
    });
    if (!presentation) throw new Error('Expected the pool request to parse');
    const screen = await renderScreen(<ProjectCommandApprovalFacts presentation={presentation} testID="facts" />);
    expect(screen.getTextContent()).toContain('Build workers');
    expect(screen.getTextContent()).not.toContain(poolId);
  });

  it('discloses the same executable and argv boundaries for ad-hoc and service approval', async () => {
    const executable = 'C:\\Program Files\\tool.exe';
    const argv = ['', 'a b', 'say "hello"', 'tail'];
    const expected = '"C:\\\\Program Files\\\\tool.exe" "" "a b" "say \\"hello\\"" tail';
    const presentation = readProjectCommandApproval({
      actionId: 'projects.compute.exec',
      actionArgs: { workspace, executable, argv, cwd: '/src/happier/packages/app' } as never,
    });
    expect(presentation).toMatchObject({ kind: 'exec', command: expected });
    expect(readProjectServiceEffectApproval({ serverId: 'home', sourceMachineId: 'devbox',
      reviewedEffect: { command: { executable, args: argv } },
    })).toMatchObject({ kind: 'service', command: expected });
    const screen = await renderScreen(<ProjectCommandApprovalFacts presentation={presentation!} testID="facts" />);
    expect(screen.getTextContent()).toContain(`$ ${expected}`);
    expect(factValue(screen.findHostByTestId('facts.rows.row:checkout'))).toBe(workspace.rootPath);
    await screen.unmount();
  });

  it('shows the exact one-off command, the worker it goes to and that only a fresh copy is used', async () => {
    const presentation = readProjectCommandApproval({
      actionId: 'projects.compute.exec',
      actionArgs: {
        workspace,
        executable: 'yarn',
        argv: ['vitest', 'run', 'sync.test.ts', '--repeat', '20'],
        cwd: '/src/happier',
        choice: {
          kind: 'workers',
          destination: { kind: 'machine', machineId: 'hz-build-1' },
        },
      } as never,
    });
    expect(presentation).not.toBeNull();
    expect(describeProjectCommandApprovalTitle(presentation!, 'devbox')).toBe(
      'Run this command on a worker?',
    );
    const screen = await renderScreen(
      <ProjectCommandApprovalFacts
        presentation={presentation!}
        testID="facts"
      />,
    );
    expect(screen.getTextContent()).toContain(
      '$ yarn vitest run sync.test.ts --repeat 20',
    );
    expect(screen.getTextContent()).toContain('hz-build-1');
    expect(screen.getTextContent()).toContain(
      'A fresh copy of devbox’s checkout. Nothing copies back.',
    );
    expect(screen.getTextContent()).toContain(
      'Allowed by Workers › Allow explicit ad-hoc commands',
    );
    await screen.unmount();
  });

  it('reads a named Script request on this checkout, and nothing for other or malformed Actions', () => {
    const script = readProjectCommandApproval({
      actionId: 'projects.script.run',
      actionArgs: {
        workspace,
        selection: { kind: 'named', name: 'test' },
      } as never,
    });
    expect(script).toMatchObject({
      kind: 'script',
      name: 'test',
      destination: { kind: 'primary' },
    });
    expect(describeProjectCommandApprovalTitle(script!, 'devbox')).toBe('Run test?');
    expect(
      readProjectCommandApproval({
        actionId: 'projects.compute.exec',
        actionArgs: { workspace } as never,
      }),
    ).toBeNull();
    expect(
      readProjectCommandApproval({
        actionId: 'session.spawn_new',
        actionArgs: {} as never,
      }),
    ).toBeNull();
  });

  it('reads a setup request as its machine question and ignores teardown', () => {
    const setup = readProjectCommandApproval({
      actionId: 'projects.prepare',
      actionArgs: { workspace, phase: 'setup' } as never,
    });
    expect(setup).toMatchObject({ kind: 'setup', destination: { kind: 'primary' } });
    expect(describeProjectCommandApprovalTitle(setup!, 'devbox')).toBe('Run setup on devbox?');
    expect(
      readProjectCommandApproval({
        actionId: 'projects.prepare',
        actionArgs: { workspace, phase: 'teardown' } as never,
      }),
    ).toBeNull();
  });

  it('carries the canonical target review into setup facts only for the approved effect basis', () => {
    const setupReview = ProjectSetupReviewV1Schema.parse({ reviewedEffectDigest: 'reviewed', reviewedEffect: {
      commands: [{ kind: 'command', command: 'echo setup', cwd: '.', os: 'linux' }],
      configEnvironment: { MODE: 'development' },
    } });
    const actionArgs = ProjectPrepareInputV1Schema.parse({ workspace, phase: 'setup', expectedEffectDigest: 'reviewed', consentScope: 'thisTime' });
    const input = { actionId: 'projects.prepare' as const, actionArgs, preview: { setupReview } };
    expect(readProjectCommandApproval(input)).toMatchObject({ kind: 'setup', setupReview });
    expect(readProjectCommandApproval({ ...input, actionArgs: { ...actionArgs, expectedEffectDigest: 'stale' } }))
      .toMatchObject({ kind: 'setup', setupReview: null });
  });
  it('discloses the remembered consent only when the agent asked for Until it changes', async () => {
    const setupReview = ProjectSetupReviewV1Schema.parse({ reviewedEffectDigest: 'reviewed', reviewedEffect: {
      commands: [{ kind: 'command', command: 'mise install', cwd: '.', os: 'linux' }],
    } });
    const read = (consentScope?: 'thisTime' | 'untilChanged') => readProjectCommandApproval({ actionId: 'projects.prepare',
      actionArgs: ProjectPrepareInputV1Schema.parse({ workspace, phase: 'setup', expectedEffectDigest: 'reviewed',
        ...(consentScope ? { consentScope } : {}), ...(consentScope === 'untilChanged' ? { heldOperationId: 'operation-1' } : {}) }),
      preview: { setupReview } })!;

    const remembered = read('untilChanged');
    const withDisclosure = await renderScreen(<ProjectCommandApprovalFacts presentation={remembered} testID="facts" />);
    expect(withDisclosure.findByTestId('facts.rememberedConsent')).not.toBeNull();
    // The same reviewed steps and Where/Files/As stay beside the disclosure; there is no second card.
    expect(withDisclosure.getTextContent()).toContain('mise install');
    expect(withDisclosure.findByTestId('facts.review')).not.toBeNull();
    await withDisclosure.unmount();
    // The decision names what approving does; Not now stays the other choice.
    expect(describeProjectCommandApprovalDecisions(remembered)).toEqual({ approve: 'Allow until it changes', reject: 'Not now' });
    // The question agrees with the consent: it covers the Project on any of the person's machines, so it names none.
    expect(describeProjectCommandApprovalTitle(remembered, 'devbox')).toBe('Run setup and remember it for this project?');
    expect(describeProjectCommandApprovalTitle(read('thisTime'), 'devbox')).toBe('Run setup on devbox?');

    for (const ordinary of [read('thisTime'), read()]) {
      const screen = await renderScreen(<ProjectCommandApprovalFacts presentation={ordinary} testID="facts" />);
      expect(screen.findByTestId('facts.rememberedConsent')).toBeNull();
      await screen.unmount();
      expect(describeProjectCommandApprovalDecisions(ordinary)).toEqual({ approve: 'Run setup', reject: 'Not now' });
    }
  });
  it('renders the reviewed setup steps with Where, Files and As, and says plainly when the steps could not be read', async () => {
    const setupReview = ProjectSetupReviewV1Schema.parse({ reviewedEffectDigest: 'reviewed', reviewedEffect: {
      commands: [
        { kind: 'command', command: 'mise install', cwd: '.', os: 'linux' },
        { kind: 'command', command: 'yarn install --immutable', cwd: '.', os: 'linux' },
      ],
    } });
    const actionArgs = ProjectPrepareInputV1Schema.parse({ workspace, phase: 'setup' });
    const reviewed = readProjectCommandApproval({ actionId: 'projects.prepare', actionArgs, preview: { setupReview } });
    const withSteps = await renderScreen(<ProjectCommandApprovalFacts presentation={reviewed!} testID="facts" />);
    expect(withSteps.getTextContent()).toContain('mise install');
    expect(withSteps.getTextContent()).toContain('yarn install --immutable');
    expect(withSteps.getTextContent()).toContain('This checkout, as it is now.');
    expect(withSteps.findByTestId('facts.stepsUnavailable')).toBeNull();
    await withSteps.unmount();

    const unread = readProjectCommandApproval({ actionId: 'projects.prepare', actionArgs });
    const withoutSteps = await renderScreen(<ProjectCommandApprovalFacts presentation={unread!} testID="facts" />);
    expect(withoutSteps.findByTestId('facts.stepsUnavailable')).not.toBeNull();
    expect(withoutSteps.getTextContent()).not.toContain('mise install');
    expect(withoutSteps.getTextContent()).toContain('This checkout, as it is now.');
    await withoutSteps.unmount();
  });
});
