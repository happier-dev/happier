import { afterEach, describe, expect, it, vi } from 'vitest';

import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';

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
  describeProjectCommandApprovalTitle,
  readProjectCommandApproval,
  readProjectServiceEffectApproval,
} = await import('./ProjectCommandApprovalFacts');

afterEach(() => {
  standardCleanup();
});

const workspace = {
  serverId: 'home',
  machineId: 'devbox',
  workspaceId: 'checkout',
  rootPath: '/src/happier',
};

describe('Project command approval facts', () => {
  it('discloses the same executable and argv boundaries for ad-hoc and service approval', async () => {
    const executable = 'C:\\Program Files\\tool.exe';
    const argv = ['', 'a b', 'say "hello"', 'tail'];
    const expected = '"C:\\\\Program Files\\\\tool.exe" "" "a b" "say \\"hello\\"" tail';
    const presentation = readProjectCommandApproval({
      actionId: 'projects.compute.exec',
      actionArgs: { workspace, executable, argv, cwd: '/src/happier' } as never,
    });
    expect(presentation).toMatchObject({ kind: 'exec', command: expected });
    expect(readProjectServiceEffectApproval({ serverId: 'home', sourceMachineId: 'devbox',
      reviewedEffect: { command: { executable, args: argv } },
    })).toMatchObject({ kind: 'service', command: expected });
    const screen = await renderScreen(<ProjectCommandApprovalFacts presentation={presentation!} testID="facts" />);
    expect(screen.getTextContent()).toContain(`$ ${expected}`);
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
    expect(describeProjectCommandApprovalTitle(presentation!)).toBe(
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
    expect(describeProjectCommandApprovalTitle(script!)).toBe('Run test?');
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
});
