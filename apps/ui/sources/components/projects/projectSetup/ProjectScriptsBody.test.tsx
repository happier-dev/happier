import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
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
  responses: {} as Record<string, unknown>,
  /** A typed Action refusal the daemon returned instead of a result. */
  failures: {} as Record<string, unknown>,
  trustMutations: [] as unknown[],
}));

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
  createFrontDoorActionExecute: () => async (actionId: string, input: any) => {
    shared.calls.push({ actionId, input });
    if (actionId === 'projects.inspect')
      return { ok: true, result: shared.inspection };
    if (shared.failures[actionId]) return shared.failures[actionId];
    return { ok: true, result: shared.responses[actionId] ?? {} };
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
  return createTextModuleMock({ translate: (key: string) => key });
});

const { ProjectScriptsBody } = await import('./ProjectScriptsBody');
const { storage } = await import('@/sync/domains/state/storageStore');
const { actionOperationStore } =
  await import('@/sync/domains/actionOperations/actionOperationStore');
const { workspaceFileEditorDraftCache } = await import(
  '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorDraftCache'
);
const { buildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
const previous = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

afterEach(async () => {
  standardCleanup();
  shared.trustMutations = [];
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
  shared.responses = {};
  shared.failures = {};
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
});
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
    document: {
      status: 'valid',
      bytes,
      original,
      manifest,
      diagnostics: Object.keys(extra).map((key) => ({
        code: 'unrecognized_key',
        path: [key],
        message: `Unrecognized key: ${key}`,
      })),
    },
  };
}

const declared = {
  version: 1,
  scripts: { test: { source: nativeRef('test') } },
};

function operation(state: 'accepted' | 'failed', revision: number) {
  return {
    version: 1,
    operationId: 'op-1',
    revision,
    actionId: 'projects.script.run',
    state,
    scope: { accountId: 'account-1', machineId: 'm1' },
    title: 'projects.script.run',
    createdAt: 1_000,
    ...(state === 'failed'
      ? {
          startedAt: 1_100,
          settledAt: 2_000,
          error: { errorCode: 'process_settled', error: 'process_settled' },
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

async function render(presentation: 'page' | 'widget', ready: string) {
  connection ??= await restoreServerAccountForTest({
    serverUrl: 'https://scripts-body.test', serverIdentityId: workspace.serverId, accountId: 'account-1',
    request: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
      if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
      // The approving Account's Project Trust row (D18 "Until it changes") is an HTTP boundary.
      if (path === '/v1/account/project-trust/read') return Response.json({ status: 'absent' });
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
      throw new Error(`${ready} not rendered; calls: ${shared.calls.map((call) => call.actionId).join(',')}; text: ${screen.getTextContent().slice(0, 200)}; ids: ${ids}`);
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
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.script:test');
    expect(screen.findByTestId('project-setup-authored')).toBeNull();
    const origin = (workspaceId: string) => ({ kind: 'project', accountId: 'account-1', page: 'scripts',
      workspace: { ...workspace, workspaceId } });
    await act(async () => {
      storage.setState({ sessions: {
        other: createSessionFixture({ id: 'other', updatedAt: 9,
          metadata: { machineId: 'm1', path: '/repo', host: 'h', work: { authoringOriginV1: origin('w2') } } as never }),
      } });
    });
    expect(screen.findByTestId('project-setup-authored')).toBeNull();
    await act(async () => {
      storage.setState({ sessions: {
        ...storage.getState().sessions,
        setup: createSessionFixture({ id: 'setup', updatedAt: 5,
          metadata: { machineId: 'm1', path: '/repo', host: 'h', work: { authoringOriginV1: origin('w1') } } as never }),
      } });
    });
    await vi.waitFor(() => expect(screen.findByTestId('project-setup-authored')).not.toBeNull());
  });
});

describe('ProjectScriptsBody runs', () => {
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

  it('opens the setup review when a run needs setup consent, then prepares with the reviewed effect', async () => {
    shared.inspection = {
      definition: presentDefinition({
        ...declared,
        workspace: { setup: [{ kind: 'command', command: 'yarn install' }] },
      }),
      detection,
      importCandidates: [],
    };
    shared.responses['projects.script.run'] = {
      kind: 'pendingApproval',
      code: 'project_setup_consent_required',
      reviewedEffectDigest: 'a'.repeat(64),
    };
    const screen = await render('page', 'scripts.script:test');
    expect(screen.findByTestId('scripts.setup.review')).toBeNull();
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.script:test.run');
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('scripts.setup.review')).toBeTruthy(),
    );
    expect(
      screen.findByTestId('scripts.setup.review.effect:step:0'),
    ).toBeTruthy();
    shared.responses['projects.prepare'] = {
      kind: 'success',
      reviewedEffectDigest: 'a'.repeat(64),
    };
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.setup.review.run');
    });
    expect(
      shared.calls.find((call) => call.actionId === 'projects.prepare')?.input,
    ).toMatchObject({
      workspace,
      phase: 'setup',
      expectedEffectDigest: 'a'.repeat(64),
    });
    // "Until it changes" (the review's default) is the person's own grant for this Project's exact effect.
    expect(shared.trustMutations).toEqual([expect.objectContaining({
      project: { serverId: workspace.serverId, projectId: 'w1' }, expectedRevision: 'absent',
      content: { t: 'plain', v: expect.objectContaining({ reviewedEffectDigest: 'a'.repeat(64) }) },
    })]);
  });

  it.each(['ask', 'fail'] as const)(
    'shows the no-worker refusal with the configured fallback offer (%s) and never falls back on its own',
    async (unavailable) => {
      shared.inspection = {
        definition: presentDefinition({
          version: 1,
          scripts: { test: { source: nativeRef('test'), execution: 'portable' } },
        }),
        detection,
        importCandidates: [],
      };
      shared.failures['projects.script.run'] = {
        ok: false,
        errorCode: unavailable === 'ask' ? 'choice_required' : 'no_available_machine',
        error: unavailable === 'ask' ? 'choice_required' : 'no_available_machine',
        details: { kind: 'no_worker_can_accept', unavailable, reason: 'no_available_machine' },
      };
      const screen = await render('page', 'scripts.script:test');
      expect(screen.findByTestId('scripts.script:test.noWorker')).toBeNull();
      await act(async () => {
        await screen.pressByTestIdAsync('scripts.script:test.run');
      });
      await vi.waitFor(() =>
        expect(screen.findByTestId('scripts.script:test.noWorker')).toBeTruthy(),
      );
      const runs = () => shared.calls.filter((call) => call.actionId === 'projects.script.run');
      // The refusal is reported; nothing reran on the primary checkout by itself.
      expect(runs()).toHaveLength(1);
      expect(screen.findByTestId('scripts.script:test.noWorker.dontRun')).toBeTruthy();
      if (unavailable === 'fail') {
        expect(screen.findByTestId('scripts.script:test.noWorker.runHere')).toBeNull();
        // "Don't run" puts the refusal away and runs nothing.
        await act(async () => {
          await screen.pressByTestIdAsync('scripts.script:test.noWorker.dontRun');
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
    expect(shared.calls.some((call) => call.actionId === 'projects.manifest.update')).toBe(false);
  });
});

describe('ProjectScriptsBody native previews and tools', () => {
  const invocation = (args: string[], requestedVersion?: string) => ({
    tool: 'yarn', args, cwd: '/repo', ...(requestedVersion ? { requestedVersion } : {}),
  });

  it('leads declared and found rows with the runner argv from inspection, never the bare target', async () => {
    shared.inspection = {
      definition: presentDefinition(declared),
      detection,
      importCandidates: [{
        source: nativeRef('lint'), usage: 'script', availability: 'unavailable', preselected: false,
        invocation: invocation(['lint'], '4.5.3'),
      }],
      commands: [{
        name: 'test', usage: 'script', source: nativeRef('test'), availability: 'available',
        invocation: invocation(['test']),
      }],
    };
    const screen = await render('page', 'scripts.script:test');
    expect(textOf(screen, 'scripts.script:test.status')).toContain('yarn test');
    expect(screen.findByTestId('scripts.detected:0.command')?.props.children).toBe('yarn lint');
  });

  it('shows installed tool versions only when inspection knows them, in the meta line and editor rows', async () => {
    const manifest = {
      ...declared,
      environment: { kind: 'toolchain', tool: 'mise', configPath: '.mise.toml' },
    };
    shared.inspection = {
      definition: presentDefinition(manifest),
      detection,
      importCandidates: [],
      tools: [
        { tool: 'node', file: '.mise.toml', requestedVersion: '22', availability: 'available', version: '22.11.0' },
        { tool: 'protoc', file: '.mise.toml', requestedVersion: '28.3', availability: 'unresolved' },
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
      expect(screen.findByTestId('project-manifest-editor.tool:node')).toBeTruthy(),
    );
    expect(screen.findByTestId('project-manifest-editor.tool:node.version')?.props.children).toBe('22.11.0');
    expect(screen.findByTestId('project-manifest-editor.tool:protoc')).toBeTruthy();
    expect(screen.findByTestId('project-manifest-editor.tool:protoc.version')).toBeNull();
  });
});
