import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { readProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';

import {
  createSessionFixture,
  createDeferred,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
installDisconnectedServerSocketBoundary();

/**
 * Actions are the boundary: `projects.inspect` reads the checkout's definition on its Machine,
 * `projects.script.run` / `projects.prepare` / `projects.manifest.update` reach the daemon, and
 * `session.authoring.open` opens the editable setup draft. The body, the Project Action client, the
 * editor model, the operation store and the shared setup-authoring owner below them are real.
 * The code editor is a WebView/Monaco platform surface, so it is replaced by a plain element.
 */
const shared = vi.hoisted(() => ({
  calls: [] as Array<{ actionId: string; input: any }>,
  inspection: null as unknown,
  inspectionPending: null as Promise<unknown> | null,
  responses: {} as Record<string, unknown>,
  /** A typed Action refusal the daemon returned instead of a result. */
  failures: {} as Record<string, unknown>,
  trustMutations: [] as unknown[],
  /** The device class the platform adapter reports; unset keeps the real one. */
  device: null as 'phone' | null,
  operationRead: vi.fn(),
}));

// Network observation of the retained operation; the shared reader and store stay real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: (...args: unknown[]) =>
      shared.operationRead(...args),
  }),
);

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
  createFrontDoorActionExecute: (_runtime?: unknown, options?: { actionOperationOpenOutput?: (address: unknown) => Promise<void> }) => async (actionId: string, input: any) => {
    shared.calls.push({ actionId, input });
    if (actionId === 'projects.inspect')
      return { ok: true, result: shared.inspectionPending ? await shared.inspectionPending : shared.inspection };
    if (shared.failures[actionId]) return shared.failures[actionId];
    if (actionId === 'projects.execution.output.open') await options?.actionOperationOpenOutput?.(input);
    return { ok: true, result: await (shared.responses[actionId] ?? {}) };
  },
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({
    execute: async (actionId: string, input: any) => {
      shared.calls.push({ actionId, input });
      return {
        ok: true,
        result: { kind: 'unavailable', reason: 'origin_unavailable' },
      };
    },
  }),
}));

// The device class is a platform adapter boundary; phone cases set it, every other case keeps the real one.
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
  return { ...actual, useDeviceType: () => shared.device ?? actual.useDeviceType() };
});

vi.mock('@/components/ui/code/editor/CodeEditor', async () => {
  const React = await import('react');
  return {
    CodeEditor: React.forwardRef((props: any, _ref: any) =>
      React.createElement('CodeEditor', props),
    ),
  };
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  const parameterized = createTextModuleMock();
  return createTextModuleMock({ translate: (key, params) =>
    // Memory summaries disclose the stored amount through the translation parameter.
    key === 'projects.scripts.editor.needsAbout' ? parameterized.t(key, params) : key,
  });
});

const { ProjectScriptsBody } = await import('./ProjectScriptsBody');
const { storage } = await import('@/sync/domains/state/storageStore');
const { actionOperationStore } =
  await import('@/sync/domains/actionOperations/actionOperationStore');
const { workspaceFileEditorDraftCache } =
  await import('@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorDraftCache');
const { buildWorkspaceCacheKey } =
  await import('@/sync/domains/workspaces/workspaceScope');
const previous = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null =
  null;

afterEach(async () => {
  standardCleanup();
  shared.trustMutations = [];
  shared.operationRead.mockReset();
  await connection?.dispose();
  connection = null;
  storage.setState(previous);
  actionOperationStore.reset();
  // Unsaved drafts deliberately outlive the editor; each case starts from the file itself.
  workspaceFileEditorDraftCache.setDraft({
    accountId: 'account-1',
    workspaceCacheKey: buildWorkspaceCacheKey(workspace),
    filePath: '.happier/project.json',
    draft: null,
  });
  shared.calls = [];
  shared.inspection = null;
  shared.inspectionPending = null;
  shared.responses = {};
  shared.failures = {};
  shared.device = null;
});

const workspace = {
  serverId: 'srv_scripts_body',
  workspaceId: 'w1',
  machineId: 'm1',
  rootPath: '/repo',
};
const nativeRef = (target: string) => ({
  kind: 'native',
  tool: 'package_script',
  file: 'package.json',
  target,
} as const);
const detection = {
  entries: [
    { source: nativeRef('test'), usage: 'script' },
    { source: nativeRef('lint'), usage: 'script' },
  ],
  environments: [],
  devcontainers: [],
  coverage: 'complete',
  diagnostics: [],
};
const hash = 'a'.repeat(64);

function presentDefinition(
  manifest: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const original = { ...manifest, ...extra };
  const bytes = `${JSON.stringify(original, null, 2)}\n`;
  return {
    basis: { kind: 'present', hash },
    document: readProjectManifestDocument(bytes),
  };
}

const declared = {
  version: 1,
  scripts: { test: { source: nativeRef('test') } },
};

function operation(
  state: 'accepted' | 'failed' | 'succeeded',
  revision: number,
): ActionOperationSnapshotV1 {
  return {
    version: 1,
    operationId: 'op-1',
    revision,
    actionId: 'projects.script.run',
    state,
    scope: { accountId: 'account-1', machineId: 'm1' },
    title: 'projects.script.run',
    createdAt: 1_000,
    ...(state !== 'accepted'
      ? {
          startedAt: 1_100,
          settledAt: 2_000,
          ...(state === 'failed'
            ? {
                error: {
                  errorCode: 'process_settled',
                  error: 'process_settled',
                },
              }
            : {}),
        }
      : {}),
    domainRef: {
      kind: 'projectCommand',
      purpose: 'script',
      serverId: workspace.serverId,
      machineId: 'm1',
      workspaceRefId: 'w1',
      cwd: '/repo',
      sourceWorkspace: workspace,
      script: { name: 'test', source: nativeRef('test') },
    },
    cancellation: 'supported',
  };
}

async function render(
  presentation: 'page' | 'widget',
  ready: string,
  host: Readonly<{ outputScopeId?: string }> = {},
) {
  connection ??= await restoreServerAccountForTest({
    serverUrl: 'https://scripts-body.test',
    serverIdentityId: workspace.serverId,
    accountId: 'account-1',
    request: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption')
        return Response.json({ mode: 'plain', updatedAt: 1 });
      if (path === '/v1/account/encryption/currentness')
        return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v2/account/settings')
        return Response.json({ content: null, version: 0 });
      // The approving Account's Project Trust row (D18 "Until it changes") is an HTTP boundary.
      if (path === '/v1/account/project-trust/read')
        return Response.json({ status: 'absent' });
      if (path === '/v1/account/project-trust/mutate') {
        shared.trustMutations.push(JSON.parse(String(init?.body)));
        return Response.json({ status: 'updated', revision: 1, cursor: 1 });
      }
      return Response.json({}, { status: 404 });
    },
  });
  storage.setState({
    profileScope: { serverId: workspace.serverId, accountId: 'account-1' },
    projectAccountRows: {
      scope: { serverId: workspace.serverId, accountId: 'account-1' },
      status: 'ready',
      coverage: 'complete',
      workspaceRefs: [
        {
          id: 'w1',
          serverId: workspace.serverId,
          machineId: 'm1',
          rootPath: '/repo',
          createdAtMs: 1,
          projectKey: 'w1',
        },
      ],
      relationships: [],
      organizations: [],
      revisionsByPhysicalKey: {},
    },
  });
  const screen = await renderScreen(
    <ProjectScriptsBody
      workspace={workspace}
      presentation={presentation}
      testID="scripts"
      outputScopeId={host.outputScopeId}
    />,
  );
  await vi.waitFor(
    () => {
      if (screen.findByTestId(ready)) return;
      const ids = screen
        .findAll((node) => typeof node.props?.testID === 'string')
        .map((node) => node.props.testID)
        .slice(0, 30)
        .join(', ');
      throw new Error(
        `${ready} not rendered; calls: ${shared.calls.map((call) => call.actionId).join(',')}; text: ${screen.getTextContent().slice(0, 200)}; ids: ${ids}`,
      );
    },
    { timeout: 5_000 },
  );
  return screen;
}

function textOf(
  screen: Awaited<ReturnType<typeof render>>,
  testID: string,
): string {
  const node = screen.findByTestId(testID);
  const collect = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : Array.isArray(value)
        ? value.map(collect).join('')
        : value && typeof value === 'object' && 'props' in value
          ? collect((value as { props: { children?: unknown } }).props.children)
          : '';
  return collect(node?.props.children);
}

describe('ProjectScriptsBody setup affordance', () => {
  it('offers Set up with an agent beside what was found when the checkout has no project file', async () => {
    shared.inspection = {
      definition: { basis: { kind: 'absent' }, document: null },
      detection,
      importCandidates: [],
    };
    const screen = await render('widget', 'scripts.detected:0');
    expect(screen.findByTestId('scripts.found')).toBeTruthy();
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.setup');
    });
    expect(
      shared.calls.some((call) => call.actionId === 'session.authoring.open'),
    ).toBe(true);
  });

  it('leads the Scripts page with the no-project-file hero, Create project file and its setup entry', async () => {
    shared.inspection = {
      definition: { basis: { kind: 'absent' }, document: null },
      detection,
      importCandidates: [],
    };
    const screen = await render('page', 'scripts.detected:0');
    expect(screen.findByTestId('scripts.noProjectFile')).toBeTruthy();
    expect(screen.findByTestId('scripts.create')).toBeTruthy();
    expect(screen.findByTestId('scripts.setup')).toBeTruthy();
  });

  it('keeps setup quiet once a project file declares the scripts', async () => {
    shared.inspection = {
      definition: presentDefinition(declared),
      detection,
      importCandidates: [],
    };
    const screen = await render('widget', 'scripts.script:test');
    expect(screen.findByTestId('scripts.setup')).toBeNull();
  });

  it('says which Session last authored this checkout, and nothing for another checkout’s authoring', async () => {
    shared.inspection = {
      definition: presentDefinition(declared),
      detection,
      importCandidates: [],
    };
    const screen = await render('page', 'scripts.script:test');
    expect(screen.findByTestId('project-setup-authored')).toBeNull();
    const origin = (workspaceId: string) => ({
      kind: 'project',
      accountId: 'account-1',
      page: 'scripts',
      workspace: { ...workspace, workspaceId },
    });
    await act(async () => {
      storage.setState({
        sessions: {
          other: createSessionFixture({
            id: 'other',
            updatedAt: 9,
            metadata: {
              machineId: 'm1',
              path: '/repo',
              host: 'h',
              work: { authoringOriginV1: origin('w2') },
            } as never,
          }),
        },
      });
    });
    expect(screen.findByTestId('project-setup-authored')).toBeNull();
    await act(async () => {
      storage.setState({
        sessions: {
          ...storage.getState().sessions,
          setup: createSessionFixture({
            id: 'setup',
            updatedAt: 5,
            metadata: {
              machineId: 'm1',
              path: '/repo',
              host: 'h',
              work: { authoringOriginV1: origin('w1') },
            } as never,
          }),
        },
      });
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('project-setup-authored')).not.toBeNull(),
    );
  });
});

describe('ProjectScriptsBody runs', () => {
  it('keeps the first row pending while a second independent Run is admitted and settles', async () => {
    shared.inspection = { definition: presentDefinition({ version: 1, scripts: {
      test: { source: nativeRef('test') }, lint: { source: nativeRef('lint') },
    } }), detection, importCandidates: [] };
    const gate = createDeferred<{ operation: ActionOperationSnapshotV1 }>();
    shared.responses['projects.script.run'] = gate.promise;
    const screen = await render('page', 'scripts.script:test.run');
    try {
      await screen.pressByTestIdAsync('scripts.script:test.run');
      await vi.waitFor(() => expect(screen.findByTestId('scripts.script:test.run')?.props.disabled).toBe(true));
      shared.responses['projects.script.run'] = { operation: { ...operation('accepted', 1), operationId: 'op-lint' } };
      await screen.pressByTestIdAsync('scripts.script:lint.run');
      await vi.waitFor(() => expect(shared.calls.filter(call => call.actionId === 'projects.script.run')).toHaveLength(2));
      expect(screen.findByTestId('scripts.script:test.run')?.props.disabled).toBe(true);
      expect(screen.findByTestId('scripts.script:lint.run')?.props.disabled).toBe(false);
    } finally {
      await act(async () => { gate.resolve({ operation: operation('accepted', 1) }); });
    }
  });
  it('withdraws current readiness on this checkout operation update until the same inspection owner refreshes', async () => {
    const manifest = { version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] }, scripts: { test: { source: nativeRef('test') } } };
    shared.inspection = { definition: presentDefinition(manifest), detection, importCandidates: [],
      setupReadiness: { kind: 'current', reviewedEffectDigest: 'current-effect', completedAtMs: 123 } };
    const screen = await render('page', 'scripts.setup');
    expect(screen.getTextContent()).toContain('projects.scripts.setup.readySince');
    const initialReads = shared.calls.filter(call => call.actionId === 'projects.inspect').length;
    await act(async () => actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{ ...operation('accepted', 1), scope: { accountId: 'other-account', machineId: 'm1' } }] }));
    expect(shared.calls.filter(call => call.actionId === 'projects.inspect')).toHaveLength(initialReads);
    let finish!: (value: unknown) => void;
    shared.inspectionPending = new Promise(resolve => { finish = resolve; });
    const accepted = operation('accepted', 1);
    if (accepted.domainRef?.kind !== 'projectCommand') throw new Error('Expected project command fixture');
    const setupAttempt = { ...accepted, operationId: 'new-attempt', actionId: 'projects.prepare',
      domainRef: { ...accepted.domainRef, purpose: 'setup' as const, script: undefined } };
    await act(async () => actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [setupAttempt] }));
    await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('projects.scripts.setup.readySince'));
    expect(screen.findByTestId('scripts.script:test')).not.toBeNull();
    // Inspection may race the owner's setup invalidation. A held/live operation still cannot be Ready.
    await act(async () => finish({ definition: presentDefinition(manifest), detection, importCandidates: [], setupReadiness: { kind: 'current', reviewedEffectDigest: 'current-effect', completedAtMs: 123 } }));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('projects.scripts.run.waitsForSetup'));
    expect(screen.getTextContent()).not.toContain('projects.scripts.setup.readySince');
    shared.inspectionPending = null;
    const beforeProgress = shared.calls.filter(call => call.actionId === 'projects.inspect').length;
    await act(async () => actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{ ...setupAttempt, revision: 2, progress: { kind: 'phase', phase: 'setup', label: 'new output' } }] }));
    expect(shared.calls.filter(call => call.actionId === 'projects.inspect')).toHaveLength(beforeProgress);
    await act(async () => actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{ ...setupAttempt, revision: 3, state: 'succeeded', settledAt: 2_000 }] }));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('projects.scripts.setup.readySince'));
    let fail!: (error: unknown) => void;
    shared.inspectionPending = new Promise((_resolve, reject) => { fail = reject; });
    await act(async () => actionOperationStore.setMachineObservation({ serverId: workspace.serverId, machineId: workspace.machineId }, 'unavailable'));
    await act(async () => fail({ code: 'project_definition_inspection_failed' }));
    expect(screen.findByTestId('scripts.script:test')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain('projects.scripts.setup.readySince');
    expect(screen.findByTestId('scripts.inspection-action')).not.toBeNull();
    shared.inspectionPending = null;
    await act(async () => screen.pressByTestIdAsync('scripts.inspection-action'));
    await vi.waitFor(() => expect(screen.findByTestId('scripts.inspection-action')).toBeNull());
    expect(screen.findByTestId('scripts.script:test')).not.toBeNull();
  });
  it('uses current target readiness and never promotes historical setup completion to Ready', async () => {
    const manifest = {
      version: 1,
      workspace: { setup: [{ kind: 'command', command: 'echo setup' }] },
      scripts: { test: { source: nativeRef('test') } },
    };
    shared.inspection = {
      definition: presentDefinition(manifest),
      detection,
      importCandidates: [],
      setupReadiness: {
        kind: 'unknown',
        code: 'project_setup_requester_review_unavailable',
      },
    };
    const historical = operation('succeeded', 1);
    actionOperationStore.mergeSnapshots({
      serverId: workspace.serverId,
      snapshots: [
        {
          ...historical,
          actionId: 'projects.prepare',
          domainRef: {
            ...historical.domainRef,
            purpose: 'setup',
            script: undefined,
          },
        },
      ],
    });
    const screen = await render('page', 'scripts.setup');
    expect(screen.getTextContent()).not.toContain(
      'projects.scripts.setup.readySince',
    );
    expect(screen.getTextContent()).toContain(
      'projects.scripts.run.waitsForSetup',
    );
    await screen.unmount();
    shared.inspection = {
      definition: presentDefinition(manifest),
      detection,
      importCandidates: [],
      setupReadiness: {
        kind: 'current',
        reviewedEffectDigest: 'current-effect',
        completedAtMs: 123,
      },
    };
    actionOperationStore.reset();
    const current = await render('page', 'scripts.setup');
    expect(current.getTextContent()).toContain(
      'projects.scripts.setup.readySince',
    );
    expect(current.getTextContent()).not.toContain(
      'projects.scripts.run.waitsForSetup',
    );
  });
  it('runs a declared script through projects.script.run and shows that operation’s own status', async () => {
    shared.inspection = {
      definition: presentDefinition(declared),
      detection,
      importCandidates: [],
    };
    shared.responses['projects.script.run'] = {
      operation: operation('accepted', 1),
    };
    const screen = await render('page', 'scripts.script:test');
    expect(textOf(screen, 'scripts.script:test.status')).toContain(
      'projects.scripts.run.notRun',
    );
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.script:test.run');
    });
    expect(
      shared.calls.find((call) => call.actionId === 'projects.script.run')
        ?.input,
    ).toMatchObject({
      workspace,
      selection: { kind: 'named', name: 'test' },
    });
    await vi.waitFor(() =>
      expect(textOf(screen, 'scripts.script:test.status')).toContain(
        'projects.scripts.run.accepted',
      ),
    );
    await act(async () => {
      actionOperationStore.mergeSnapshots({
        serverId: workspace.serverId,
        snapshots: [operation('failed', 2) as never],
      });
    });
    await vi.waitFor(() =>
      expect(textOf(screen, 'scripts.script:test.status')).toContain(
        'projects.scripts.run.failed',
      ),
    );
  });

  it('remembers a late setup review on the retained Script without starting a different preparation', async () => {
    shared.inspection = {
      definition: presentDefinition({
        ...declared,
        workspace: { setup: [{ kind: 'command', command: 'yarn install' }] },
      }),
      detection,
      importCandidates: [],
    };
    const held: ActionOperationSnapshotV1 = {
      ...operation('accepted', 2),
      setupReview: {
        kind: 'pendingApproval' as const,
        code: 'project_setup_consent_required',
        reviewedEffectDigest: 'a'.repeat(64),
        reviewedEffect: { commands: [{ source: { kind: 'command', command: 'yarn install' } }] },
      },
    };
    // Acceptance can arrive before the producer publishes its review hold.
    shared.responses['projects.script.run'] = {
      operation: operation('accepted', 1),
    };
    const screen = await render('page', 'scripts.script:test');
    expect(screen.findByTestId('scripts.setup.review')).toBeNull();
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.script:test.run');
      actionOperationStore.mergeSnapshots({
        serverId: workspace.serverId,
        snapshots: [held],
      });
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('scripts.setup.review')).toBeTruthy(),
    );
    expect(
      screen.findByTestId('scripts.setup.review.effect:step:0'),
    ).toBeTruthy();
    shared.operationRead
      .mockResolvedValueOnce({ kind: 'found', operation: held })
      .mockResolvedValueOnce({
        kind: 'found',
        operation: { ...held, revision: 3, setupReview: undefined },
      });
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.setup.review.run');
    });
    expect(
      shared.calls.filter((call) => call.actionId === 'projects.prepare'),
    ).toEqual([]);
    expect(
      shared.calls.filter((call) => call.actionId === 'projects.script.run'),
    ).toHaveLength(1);
    // "Until it changes" (the review's default) is the person's own grant for this Project's exact effect.
    expect(shared.trustMutations).toEqual([
      expect.objectContaining({
        project: { serverId: workspace.serverId, projectId: 'w1' },
        expectedRevision: 'absent',
        content: {
          t: 'plain',
          v: expect.objectContaining({ reviewedEffectDigest: 'a'.repeat(64) }),
        },
      }),
    ]);
  });

  it.each(['ask', 'fail'] as const)(
    'shows the no-worker refusal with the configured fallback offer (%s) and never falls back on its own',
    async (unavailable) => {
      shared.inspection = {
        definition: presentDefinition({
          version: 1,
          scripts: {
            test: { source: nativeRef('test'), execution: 'portable' },
          },
        }),
        detection,
        importCandidates: [],
      };
      shared.failures['projects.script.run'] = {
        ok: false,
        errorCode:
          unavailable === 'ask' ? 'choice_required' : 'no_available_machine',
        error:
          unavailable === 'ask' ? 'choice_required' : 'no_available_machine',
        details: {
          kind: 'no_worker_can_accept',
          unavailable,
          reason: 'no_available_machine',
        },
      };
      const screen = await render('page', 'scripts.script:test');
      expect(screen.findByTestId('scripts.script:test.noWorker')).toBeNull();
      await act(async () => {
        await screen.pressByTestIdAsync('scripts.script:test.run');
      });
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('scripts.script:test.noWorker'),
        ).toBeTruthy(),
      );
      const runs = () =>
        shared.calls.filter((call) => call.actionId === 'projects.script.run');
      // The refusal is reported; nothing reran on the primary checkout by itself.
      expect(runs()).toHaveLength(1);
      expect(
        screen.findByTestId('scripts.script:test.noWorker.dontRun'),
      ).toBeTruthy();
      if (unavailable === 'fail') {
        expect(
          screen.findByTestId('scripts.script:test.noWorker.runHere'),
        ).toBeNull();
        // "Don't run" puts the refusal away and runs nothing.
        await act(async () => {
          await screen.pressByTestIdAsync(
            'scripts.script:test.noWorker.dontRun',
          );
        });
        expect(screen.findByTestId('scripts.script:test.noWorker')).toBeNull();
        expect(runs()).toHaveLength(1);
        return;
      }
      delete shared.failures['projects.script.run'];
      await act(async () => {
        await screen.pressByTestIdAsync('scripts.script:test.noWorker.runHere');
      });
      await vi.waitFor(() => expect(runs()).toHaveLength(2));
      expect(runs()[1]?.input).toMatchObject({ choice: { kind: 'primary' } });
    },
  );

  it('offers to set up the missing worker copy through Sync and never retries the Run by itself', async () => {
    const { Modal } = await import('@/modal');
    const show = vi.spyOn(Modal, 'show').mockImplementation(() => 'modal' as never);
    shared.inspection = {
      definition: presentDefinition({ version: 1, scripts: { test: { source: nativeRef('test'), execution: 'portable' } } }),
      detection,
      importCandidates: [],
    };
    shared.failures['projects.script.run'] = {
      ok: false, errorCode: 'worker_copy_missing', error: 'worker_copy_missing',
      details: { kind: 'no_worker_can_accept', unavailable: 'fail', reason: 'worker_copy_missing',
        workerCopy: { serverId: workspace.serverId, sourceWorkspaceRefId: workspace.workspaceId,
          sourceMachineId: workspace.machineId, targetMachineId: 'm2' } },
    };
    const screen = await render('page', 'scripts.script:test');
    await act(async () => { await screen.pressByTestIdAsync('scripts.script:test.run'); });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.script:test.noWorker.setUpCopy')).toBeTruthy());
    await act(async () => { await screen.pressByTestIdAsync('scripts.script:test.noWorker.setUpCopy'); });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]?.[0]).toMatchObject({ props: { options: { targetMachineId: 'm2', purpose: 'worker_clean_copy' } } });
    expect(shared.calls.filter((call) => call.actionId === 'projects.script.run')).toHaveLength(1);
  });

  it('reads what agents are told only once its disclosure is opened', async () => {
    shared.inspection = {
      definition: presentDefinition({ version: 1, scripts: { test: { source: nativeRef('test'), execution: 'portable' } } }),
      detection,
      importCandidates: [],
    };
    const screen = await render('page', 'scripts.script:test');
    await vi.waitFor(() => expect(screen.findAllByTestId('scripts.agents.guide').length).toBeGreaterThan(0));
    expect(screen.findByTestId('scripts.agents.guide.state')).toBeNull();
    expect(screen.findByTestId('scripts.agents.guide.text')).toBeNull();
    await act(async () => {
      screen.findAllByTestId('scripts.agents.guide').find((node) => typeof node.props.onExpandedChange === 'function')?.props.onExpandedChange(true);
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('scripts.agents.guide.state') ?? screen.findByTestId('scripts.agents.guide.text')).toBeTruthy(),
    );
  });

  it('adds a found script to the project file with one guarded write of its reference', async () => {
    shared.inspection = {
      definition: presentDefinition(declared),
      detection,
      importCandidates: [],
    };
    shared.responses['projects.manifest.update'] = {
      status: 'conflict',
      current: { basis: { kind: 'absent' }, document: null },
    };
    // The found disclosure opens by default on the page.
    const screen = await render('page', 'scripts.found.header');
    await vi.waitFor(() =>
      expect(screen.findByTestId('scripts.detected:0.add')).toBeTruthy(),
    );
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.detected:0.add');
    });
    const update = shared.calls.find(
      (call) => call.actionId === 'projects.manifest.update',
    );
    expect(update?.input.expectedBasis).toEqual({ kind: 'present', hash });
    expect(JSON.parse(update?.input.bytes).scripts.lint).toEqual({
      source: nativeRef('lint'),
    });
    expect(JSON.parse(update?.input.bytes).scripts.test).toEqual({
      source: nativeRef('test'),
    });
  });
});

describe('ProjectScriptsBody project file editor', () => {
  it.each([false, true])('preserves loaded sub-GB and fractional-GB memory demand and exact byte edits (phone=%s)', async phone => {
    shared.device = phone ? 'phone' : null;
    const initial = { version: 1, scripts: {
      test: { source: nativeRef('test'), memoryDemand: { bytes: 512 * 2 ** 20, basis: { kind: 'measured' } } },
      lint: { source: nativeRef('lint'), memoryDemand: { bytes: 1.5 * 2 ** 30, basis: { kind: 'declared' } } },
    } };
    shared.inspection = { definition: presentDefinition(initial), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.edit');
    await act(async () => { await screen.pressByTestIdAsync('scripts.edit'); });
    const first = phone ? 'project-manifest-editor.section:scripts:test' : 'project-manifest-editor.script:test';
    await vi.waitFor(() => expect(screen.findByTestId(first)).toBeTruthy());
    expect(screen.getTextContent()).toContain('512 MB');
    expect(screen.getTextContent()).toContain('1.5 GB');
    if (phone) await screen.pressByTestIdAsync(first);
    for (const [name, bytes, edited] of [['test', 512 * 2 ** 20, 1], ['lint', 1.5 * 2 ** 30, Number.MAX_SAFE_INTEGER]] as const) {
      await screen.pressByTestIdAsync(`project-manifest-editor.script:${name}`);
      const testID = `project-manifest-editor.script:${name}.memory`;
      await vi.waitFor(() => expect(screen.findByTestId(testID)).toBeTruthy());
      expect(screen.findByTestId(testID)?.props.value).toBe(String(bytes));
      await act(async () => { screen.findAllByTestId(testID)[0]?.props.onBlur?.(); });
      if (name === 'test') expect(screen.findByTestId('project-manifest-editor.save')?.props.disabled).toBe(true);
      await act(async () => { screen.changeTextByTestId(testID, String(edited)); });
      await act(async () => { screen.findAllByTestId(testID)[0]?.props.onBlur?.(); });
    }
    shared.responses['projects.manifest.update'] = { status: 'refused', code: 'write_failed' };
    await screen.pressByTestIdAsync('project-manifest-editor.save');
    const update = shared.calls.find(call => call.actionId === 'projects.manifest.update');
    const saved = JSON.parse(update?.input.bytes);
    expect(saved.scripts.test.memoryDemand).toEqual({ bytes: 1, basis: { kind: 'declared' } });
    expect(saved.scripts.lint.memoryDemand).toEqual({ bytes: Number.MAX_SAFE_INTEGER, basis: { kind: 'declared' } });
  });

  it('keeps the Form usable while reporting unrecognized keys, and saves through projects.manifest.update', async () => {
    shared.inspection = {
      definition: presentDefinition(declared, { sevices: {} }),
      detection,
      importCandidates: [],
    };
    const screen = await render('page', 'scripts.edit');
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.edit');
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('project-manifest-editor')).toBeTruthy(),
    );
    expect(
      screen.findByTestId('project-manifest-editor.unknownKeys'),
    ).toBeTruthy();
    expect(
      screen.findByTestId('project-manifest-editor.script:test'),
    ).toBeTruthy();
    await act(async () => {
      await screen.pressByTestIdAsync(
        'project-manifest-editor.script:test.execution:portable',
      );
    });
    shared.responses['projects.manifest.update'] = {
      status: 'refused',
      code: 'write_failed',
    };
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.save');
    });
    const update = shared.calls.find(
      (call) => call.actionId === 'projects.manifest.update',
    );
    const saved = JSON.parse(update?.input.bytes);
    expect(saved.scripts.test.execution).toBe('portable');
    // The unrecognized key is preserved; it confers nothing and is never dropped by a Form save.
    expect(saved.sevices).toEqual({});
    await vi.waitFor(() =>
      expect(screen.findByTestId('project-manifest-editor.error')).toBeTruthy(),
    );
  });

  it('authors steps, scripts, the Devcontainer namespace and found references in the Form, then saves them in one guarded write', async () => {
    const devcontainer = { configPath: '.devcontainer/devcontainer.json' };
    shared.inspection = {
      definition: presentDefinition(
        {
          version: 1,
          workspace: {
            setup: [
              { kind: 'command', command: 'yarn install', futureStep: { keep: 1 } },
              { kind: 'command', command: 'yarn build', futureStep: { keep: 2 } },
            ],
          },
          scripts: {
            test: { source: nativeRef('test') },
            lint: { source: { kind: 'command', command: 'eslint .', futureSource: { keep: 'script' } } },
          },
          services: { web: { source: { kind: 'command', command: 'yarn dev', futureSource: { keep: 'service' } } } },
        },
        { sevices: {} },
      ),
      detection: { ...detection, devcontainers: [devcontainer] },
      importCandidates: [
        {
          source: nativeRef('test'),
          usage: 'script',
          availability: 'available',
          preselected: true,
        },
        {
          source: {
            kind: 'native',
            tool: 'just',
            file: 'justfile',
            target: 'fmt',
          },
          usage: 'script',
          availability: 'unavailable',
          code: 'tool_not_found',
          preselected: false,
        },
        {
          source: nativeRef('e2e'),
          usage: 'script',
          availability: 'available',
          preselected: false,
        },
      ],
    };
    const screen = await render('page', 'scripts.edit');
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.edit');
    });
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('project-manifest-editor.step:1'),
      ).toBeTruthy(),
    );
    const commit = async (testID: string, value: string) => {
      await vi.waitFor(() => expect(screen.findByTestId(testID)).toBeTruthy());
      await act(async () => {
        screen.changeTextByTestId(testID, value);
      });
      await act(async () => {
        screen.findAllByTestId(testID)[0]?.props.onBlur?.();
      });
    };
    // Setup: edit a literal step, then move it first.
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.step:1');
    });
    await commit(
      'project-manifest-editor.step:1.command',
      'yarn build:protocol',
    );
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.step:1.moveUp');
    });
    // Scripts: rename in place and declare a memory need.
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.script:lint');
    });
    await commit('project-manifest-editor.script:lint.name', 'check');
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.script:check');
    });
    await commit('project-manifest-editor.script:check.command', 'eslint src');
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.service:web');
    });
    await commit('project-manifest-editor.service:web.command', 'yarn dev:web');
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.script:test');
    });
    await commit('project-manifest-editor.script:test.memory', String(8 * 2 ** 30));
    // The namespace is its own choice beside the toolchain.
    await act(async () => {
      screen
        .findAllByTestId('project-manifest-editor.devcontainer')[0]
        ?.props.onSelect(JSON.stringify(devcontainer));
    });
    // Found references: a missing tool stays visible and cannot be checked; an available one is added.
    expect(
      screen.findHostByTestId('project-manifest-editor.found:1')?.props.accessibilityState?.disabled,
      JSON.stringify(screen.findAllByTestId('project-manifest-editor.found:1').map(node => ({
        type: typeof node.type === 'string' ? node.type : 'component', disabled: node.props.disabled,
        accessibilityState: node.props.accessibilityState, ariaDisabled: node.props['aria-disabled'],
      }))),
    ).toBe(true);
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.found:2');
    });
    // Add a literal script.
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.addScript');
    });
    await act(async () => {
      screen.changeTextByTestId(
        'project-manifest-editor.addScript.name',
        'dev',
      );
      screen.changeTextByTestId(
        'project-manifest-editor.addScript.command',
        'yarn dev',
      );
    });
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.addScript.save');
    });
    shared.responses['projects.manifest.update'] = {
      status: 'refused',
      code: 'write_failed',
    };
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.save');
    });
    const update = shared.calls.find(
      (call) => call.actionId === 'projects.manifest.update',
    );
    expect(update?.input.expectedBasis).toEqual({ kind: 'present', hash });
    const saved = JSON.parse(update?.input.bytes);
    expect(saved.workspace.setup).toEqual([
      { kind: 'command', command: 'yarn build:protocol', futureStep: { keep: 2 } },
      { kind: 'command', command: 'yarn install', futureStep: { keep: 1 } },
    ]);
    expect(Object.keys(saved.scripts)).toEqual(['test', 'check', 'e2e', 'dev']);
    expect(saved.scripts.check).toEqual({
      source: { kind: 'command', command: 'eslint src', futureSource: { keep: 'script' } },
    });
    expect(saved.services.web.source).toEqual({ kind: 'command', command: 'yarn dev:web', futureSource: { keep: 'service' } });
    expect(saved.scripts.test.memoryDemand).toEqual({
      bytes: 8 * 2 ** 30,
      basis: { kind: 'declared' },
    });
    expect(saved.scripts.e2e).toEqual({ source: nativeRef('e2e') });
    expect(saved.scripts.dev).toEqual({
      source: { kind: 'command', command: 'yarn dev' },
    });
    expect(saved.devcontainer).toEqual(devcontainer);
    expect(saved.scripts.fmt).toBeUndefined();
    // Unknown content survives every Form edit.
    expect(saved.sevices).toEqual({});
  });

  it('removes a declaration from the Form and unchecks its found reference', async () => {
    shared.inspection = {
      definition: presentDefinition({
        version: 1,
        scripts: {
          test: { source: nativeRef('test') },
          lint: { source: nativeRef('lint') },
        },
      }),
      detection,
      importCandidates: [
        {
          source: nativeRef('test'),
          usage: 'script',
          availability: 'available',
          preselected: true,
        },
      ],
    };
    const screen = await render('page', 'scripts.edit');
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.edit');
    });
    await vi.waitFor(() =>
      expect(
        screen.findAllByTestId('project-manifest-editor.found:0')[0]?.props.selected,
      ).toBe(true),
    );
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.script:lint');
    });
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('project-manifest-editor.script:lint.remove'),
      ).toBeTruthy(),
    );
    await act(async () => {
      await screen.pressByTestIdAsync(
        'project-manifest-editor.script:lint.remove',
      );
    });
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.found:0');
    });
    expect(
      screen.findAllByTestId('project-manifest-editor.found:0')[0]?.props.selected,
    ).toBe(false);
    shared.responses['projects.manifest.update'] = {
      status: 'refused',
      code: 'write_failed',
    };
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.save');
    });
    const update = shared.calls.find(
      (call) => call.actionId === 'projects.manifest.update',
    );
    expect(JSON.parse(update?.input.bytes).scripts).toEqual({});
  });

  it('imports a colliding native reference under an explicit name without replacing the existing declaration', async () => {
    shared.inspection = { definition: presentDefinition({ version: 1, scripts: { test: {
      source: { kind: 'command', command: 'echo original' }, future: { keep: true },
    } } }), detection, importCandidates: [{ source: nativeRef('test'), usage: 'script', availability: 'available', preselected: false },
      { source: nativeRef('missing'), usage: 'script', availability: 'unavailable', preselected: false }] };
    const screen = await render('page', 'scripts.edit');
    await act(async () => { await screen.pressByTestIdAsync('scripts.edit'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.found:0')).toBeTruthy());
    expect(screen.findByTestId('project-manifest-editor.found:0')?.props.disabled).not.toBe(true);
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.found:0'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.found:0.name')).toBeTruthy());
    await act(async () => { screen.changeTextByTestId('project-manifest-editor.found:0.name', 'native-test'); });
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.found:0.save'); });
    expect(screen.findAllByTestId('project-manifest-editor.found:1')[0]?.props.disabled).toBe(true);
    shared.responses['projects.manifest.update'] = { status: 'refused', code: 'write_failed' };
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.save'); });
    const saved = JSON.parse(shared.calls.find(call => call.actionId === 'projects.manifest.update')?.input.bytes);
    expect(saved.scripts.test).toEqual({ source: { kind: 'command', command: 'echo original' }, future: { keep: true } });
    expect(saved.scripts['native-test']).toEqual({ source: nativeRef('test') });
    expect(saved.scripts.missing).toBeUndefined();
  });

  it('opens an invalid project file in JSON, keeps its bytes and turns Form and Save off', async () => {
    const bytes = '{ "version": 1, ';
    shared.inspection = {
      definition: {
        basis: { kind: 'present', hash },
        document: {
          status: 'invalid',
          bytes,
          diagnostics: [
            {
              code: 'invalid_json',
              path: [],
              message: 'Unexpected end of JSON input',
              offset: bytes.length,
            },
          ],
        },
      },
      detection,
      importCandidates: [],
    };
    const screen = await render('page', 'scripts.invalid');
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.openEditor');
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('project-manifest-editor.raw')).toBeTruthy(),
    );
    expect(
      screen.findByTestId('project-manifest-editor.code')?.props.value,
    ).toBe(bytes);
    expect(screen.findByTestId('project-manifest-editor.invalid')).toBeTruthy();
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.save');
    });
    expect(
      shared.calls.some((call) => call.actionId === 'projects.manifest.update'),
    ).toBe(false);
  });
});

describe('ProjectScriptsBody setup row', () => {
  const withSetup = { ...declared, workspace: { setup: [{ kind: 'command', command: 'yarn install' }] } };
  function setupOperation(state: 'running' | 'failed') {
    return {
      version: 1, operationId: 'setup-1', revision: 1, actionId: 'projects.prepare', state,
      scope: { accountId: 'account-1', machineId: 'm1' }, title: 'projects.prepare', createdAt: 1_000, startedAt: 1_100,
      ...(state === 'failed' ? { settledAt: 2_000, error: { errorCode: 'process_settled', error: 'process_settled' } } : {}),
      domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: workspace.serverId, machineId: 'm1', workspaceRefId: 'w1',
        cwd: '/repo', sourceWorkspace: workspace, terminalId: 't-setup' },
      cancellation: 'supported',
    };
  }

  it('swaps Run again for Stop while setup runs and requests the real cancellation', async () => {
    shared.inspection = { definition: presentDefinition(withSetup), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.setup');
    expect(screen.findByTestId('scripts.setup.run')).toBeTruthy();
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [setupOperation('running') as never] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.stop')).toBeTruthy());
    expect(screen.findByTestId('scripts.setup.run')).toBeNull();
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.stop'); });
    await vi.waitFor(() => expect(shared.calls.find((call) => call.actionId === 'action.operations.cancel')?.input)
      .toMatchObject({ operationId: 'setup-1' }));
  });

  it('opens the same setup review from a compact host and prepares from it', async () => {
    shared.inspection = { definition: presentDefinition(withSetup), detection, importCandidates: [] };
    const screen = await render('widget', 'scripts.setup');
    expect(screen.findByTestId('scripts.setup.review')).toBeNull();
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup'); });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.review')).toBeTruthy());
    shared.responses['projects.prepare'] = { kind: 'success', reviewedEffectDigest: 'a'.repeat(64) };
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.review.run'); });
    expect(shared.calls.find((call) => call.actionId === 'projects.prepare')?.input).toMatchObject({ workspace, phase: 'setup' });
  });

  it('names where the reviewed file came from without claiming it is committed', async () => {
    shared.inspection = { definition: presentDefinition(withSetup), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.setup');
    const { error: _error, settledAt: _settledAt, ...held } = setupOperation('failed') as Record<string, unknown>;
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{
        ...held, state: 'accepted',
        setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'a'.repeat(64),
          reviewedEffect: { presentation: { bindings: [], provenance: {
            file: '.happier/project.json', kind: 'repository', headCommit: 'a41c9e2f00', branch: 'v0.3', fileState: 'modified' } } } },
      } as never] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.review.provenance')).toBeTruthy());
    const text = textOf(screen, 'scripts.setup.review.provenance');
    expect(text).toContain('projects.scripts.setup.provenanceAtBranch');
    expect(text).toContain('projects.scripts.setup.provenanceModified');
  });

  it('keeps a failed setup’s output one press away, in the host’s bottom terminal', async () => {
    shared.inspection = { definition: presentDefinition(withSetup), detection, importCandidates: [] };
    const outputScopeId = `project:${encodeURIComponent(workspace.serverId)}:w1`;
    const screen = await render('page', 'scripts.setup', { outputScopeId });
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [setupOperation('failed') as never] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.failed')).toBeTruthy());
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.openOutput'); });
    await vi.waitFor(() => expect(shared.calls.find((call) => call.actionId === 'session.terminals.open')?.input).toMatchObject({
      scopeId: outputScopeId,
      target: { kind: 'terminal_view', terminalId: 't-setup', machineId: 'm1', cwd: '/repo' },
    }));
  });
});

describe('ProjectScriptsBody output', () => {
  const outputScopeId = `project:${encodeURIComponent(workspace.serverId)}:w1`;
  const withTerminal = () => ({ ...operation('accepted', 1), domainRef: { ...operation('accepted', 1).domainRef, terminalId: 't1' } });

  it('opens a run’s output as its host’s bottom terminal tab, borrowing the same PTY, not a modal', async () => {
    const { Modal } = await import('@/modal');
    const show = vi.spyOn(Modal, 'show');
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    const screen = await render('widget', 'scripts.script:test', { outputScopeId });
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [withTerminal() as never] });
    });
    await act(async () => { await screen.pressByTestIdAsync('scripts.script:test'); });
    await vi.waitFor(() => expect(shared.calls.some((call) => call.actionId === 'projects.execution.output.open')).toBe(true));
    await vi.waitFor(() => expect(shared.calls.some((call) => call.actionId === 'session.terminals.open')).toBe(true));
    expect(shared.calls.find((call) => call.actionId === 'session.terminals.open')?.input).toMatchObject({
      scopeId: outputScopeId,
      target: { kind: 'terminal_view', machineId: 'm1', terminalId: 't1', terminalKey: 'project-command:t1', cwd: '/repo' },
      title: 'test · m1',
    });
    expect(show).not.toHaveBeenCalled();
    show.mockRestore();
  });

  it('opens the operation detail where the host has no terminal or refuses the tab', async () => {
    const { Modal } = await import('@/modal');
    const show = vi.spyOn(Modal, 'show').mockImplementation(() => 'modal' as never);
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    shared.failures['session.terminals.open'] = { ok: false, errorCode: 'terminal_target_unavailable', error: 'terminal_target_unavailable' };
    const screen = await render('widget', 'scripts.script:test', { outputScopeId });
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [withTerminal() as never] });
    });
    await act(async () => { await screen.pressByTestIdAsync('scripts.script:test'); });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(show.mock.calls[0]?.[0]).toMatchObject({ props: { serverId: workspace.serverId, operationId: 'op-1' } });
    show.mockRestore();
  });
});

describe('ProjectScriptsBody on a phone', () => {
  it('lists the project file’s sections and pushes one in place, keeping the draft on Back', async () => {
    shared.device = 'phone';
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.edit');
    await act(async () => { await screen.pressByTestIdAsync('scripts.edit'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.section:scripts:test')).toBeTruthy());
    const footer = screen.findByTestId('project-manifest-editor.phoneActions');
    expect(footer).not.toBeNull();
    expect(footer?.findAllByProps({ testID: 'project-manifest-editor.save' }).length).toBeGreaterThan(0);
    expect(footer?.findAllByProps({ testID: 'project-manifest-editor.discard' }).length).toBeGreaterThan(0);
    expect(screen.findByTestId('project-manifest-editor.script:test')).toBeNull();
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.section:scripts:test'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.script:test')).toBeTruthy());
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.script:test.execution:portable'); });
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.sectionBack'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.section:scripts:test')).toBeTruthy());
    shared.responses['projects.manifest.update'] = { status: 'refused', code: 'write_failed' };
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.save'); });
    const update = shared.calls.find((call) => call.actionId === 'projects.manifest.update');
    expect(JSON.parse(update?.input.bytes).scripts.test.execution).toBe('portable');
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.discard'); });
    expect(screen.findByTestId('project-manifest-editor.save')?.props.disabled).toBe(true);
    expect(shared.calls.filter(call => call.actionId === 'projects.manifest.update')).toHaveLength(1);
  });

  it('opens a run’s output in the operation detail, never a desktop terminal tab', async () => {
    shared.device = 'phone';
    const { Modal } = await import('@/modal');
    const show = vi.spyOn(Modal, 'show').mockImplementation(() => 'modal' as never);
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.script:test', { outputScopeId: `project:${encodeURIComponent(workspace.serverId)}:w1` });
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{
        ...operation('accepted', 1), domainRef: { ...operation('accepted', 1).domainRef, terminalId: 't1' } } as never] });
    });
    await act(async () => { await screen.pressByTestIdAsync('scripts.script:test'); });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(shared.calls.some((call) => call.actionId === 'session.terminals.open')).toBe(false);
    show.mockRestore();
  });
});

describe('ProjectScriptsBody native previews and tools', () => {
  const invocation = (args: string[], requestedVersion?: string) => ({
    tool: 'yarn',
    args,
    cwd: '/repo',
    ...(requestedVersion ? { requestedVersion } : {}),
  });

  it('leads declared and found rows with the runner argv from inspection, never the bare target', async () => {
    shared.inspection = {
      definition: presentDefinition(declared),
      detection,
      importCandidates: [
        {
          source: nativeRef('lint'),
          usage: 'script',
          availability: 'unavailable',
          preselected: false,
          invocation: invocation(['lint'], '4.5.3'),
        },
      ],
      commands: [
        {
          name: 'test',
          usage: 'script',
          source: nativeRef('test'),
          availability: 'available',
          invocation: invocation(['test']),
        },
      ],
    };
    const screen = await render('page', 'scripts.script:test');
    expect(textOf(screen, 'scripts.script:test.status')).toContain('yarn test');
    expect(
      screen.findByTestId('scripts.detected:0.command')?.props.children,
    ).toBe('yarn lint');
  });

  it('shows installed tool versions only when inspection knows them, in the meta line and editor rows', async () => {
    const manifest = {
      ...declared,
      environment: {
        kind: 'toolchain',
        tool: 'mise',
        configPath: '.mise.toml',
      },
    };
    shared.inspection = {
      definition: presentDefinition(manifest),
      detection,
      importCandidates: [],
      tools: [
        {
          tool: 'node',
          file: '.mise.toml',
          requestedVersion: '22',
          availability: 'available',
          version: '22.11.0',
        },
        {
          tool: 'protoc',
          file: '.mise.toml',
          requestedVersion: '28.3',
          availability: 'unresolved',
        },
      ],
    };
    const screen = await render('page', 'scripts.edit');
    const header = screen.getTextContent();
    expect(header).toContain('node 22.11.0');
    // A requested version is intent, not an installed fact.
    expect(header).not.toContain('protoc 28.3');
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.edit');
    });
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('project-manifest-editor.tool:node'),
      ).toBeTruthy(),
    );
    expect(
      screen.findByTestId('project-manifest-editor.tool:node.version')?.props
        .children,
    ).toBe('22.11.0');
    expect(
      screen.findByTestId('project-manifest-editor.tool:protoc'),
    ).toBeTruthy();
    expect(
      screen.findByTestId('project-manifest-editor.tool:protoc.version'),
    ).toBeNull();
  });
});
