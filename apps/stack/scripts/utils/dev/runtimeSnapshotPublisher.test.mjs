import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveWorkspaceBuildMode, WORKSPACE_BUILD_MODE_ENV } from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

import {
  createBackgroundRuntimeSnapshotPublisher,
  createRuntimeSnapshotPublicationReloadDescriptors,
  createRuntimeSnapshotPublicationReloadExecutor,
  createRepositoryRuntimePublicationController,
  isRepositoryRuntimePublicationOwner,
  publishRepositoryRuntimeSnapshotInChildProcess,
  resolveRemoteRuntimePublicationComponents,
  RUNTIME_PUBLICATION_RESULT_PREFIX,
  wrapReloadExecutorWithRuntimeSnapshotPublication,
} from './runtimeSnapshotPublisher.mjs';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

for (const platform of ['linux', 'darwin', 'win32']) {
test(`repository publication preserves local authority and tracked results on ${platform}`, async () => {
  const children = [];
  const calls = [];
  const expectedResult = {
    snapshotId: 'snapshot-new',
    changed: true,
  };

  const result = await publishRepositoryRuntimeSnapshotInChildProcess({
    rootDir: '/work/happier',
    platform,
    authority: {
      producerStackName: 'repo-dev-a1cc5e0671',
      producerStackBaseDir: '/stacks/repo-dev-a1cc5e0671',
    },
    requestedComponents: ['daemon'],
    observedStartedSeq: 123,
    env: { HAPPIER_STACK_STACK: 'repo-dev-a1cc5e0671' },
    children,
    workerPath: '/work/happier/runtime-publication-worker.mjs',
    spawnProcImpl(label, command, args, env, options) {
      calls.push({ label, command, args, env, options });
      options.lineFilter({
        stream: 'stdout',
        line: `${RUNTIME_PUBLICATION_RESULT_PREFIX}${JSON.stringify(expectedResult)}`,
      });
      return {
        exitCode: null,
        completion: Promise.resolve({ code: 0, signal: null }),
      };
    },
  });

  assert.deepEqual(result, expectedResult);
  assert.deepEqual(children, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, 'runtime-publisher');
  assert.equal(resolveWorkspaceBuildMode({ env: calls[0].env }), 'qa-runtime');
  assert.equal(resolveWorkspaceBuildMode({ env: { ...calls[0].env, npm_lifecycle_event: 'prepack' } }), 'strict');
  const workerArgs = platform === 'linux' ? calls[0].args.slice(3) : calls[0].args;
  assert.equal(calls[0].command, platform === 'linux'
    ? fileURLToPath(new URL('../../../bin/hstack-exec', import.meta.url))
    : process.execPath);
  if (platform === 'linux') {
    assert.deepEqual(calls[0].args.slice(0, 3), [
      '--local', '--', process.execPath,
    ]);
    assert.equal(calls[0].env.HAPPIER_HSTACK_DISPATCH_CONTROL, '1');
  }
  assert.equal(workerArgs[0], '/work/happier/runtime-publication-worker.mjs');
  assert.deepEqual(
    JSON.parse(Buffer.from(workerArgs[1], 'base64url').toString('utf8')),
    {
      rootDir: '/work/happier',
      authority: {
        producerStackName: 'repo-dev-a1cc5e0671',
        producerStackBaseDir: '/stacks/repo-dev-a1cc5e0671',
      },
      requestedComponents: ['daemon'],
      observedStartedSeq: 123,
    },
  );
  assert.equal(
    calls[0].options.lineFilter({
      stream: 'stdout',
      line: `${RUNTIME_PUBLICATION_RESULT_PREFIX}${JSON.stringify(expectedResult)}`,
    }),
    false,
  );
});
}

for (const platform of ['darwin', 'linux']) {
test(`repository publication parses a real worker result on ${platform}`, {
  skip: platform === 'linux' && (process.platform !== 'linux' || process.env.HAPPIER_STACK_RUN_REAL_INTEGRATION_TESTS !== '1'),
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-runtime-publication-result-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workerPath = join(root, 'worker.mjs');
  await writeFile(workerPath, [
    "import { getPriority } from 'node:os';",
    "import { readFileSync } from 'node:fs';",
    `process.stdout.write(${JSON.stringify(RUNTIME_PUBLICATION_RESULT_PREFIX)} + JSON.stringify({`,
    "  snapshotId: 'snapshot-real-child',",
    '  changed: true,',
    `  buildMode: process.env.${WORKSPACE_BUILD_MODE_ENV},`,
    '  nice: getPriority(),',
    "  cgroup: process.platform === 'linux' ? readFileSync('/proc/self/cgroup', 'utf8') : null,",
    '}) + \'\\n\');',
    '',
  ].join('\n'));

  const result = await publishRepositoryRuntimeSnapshotInChildProcess({
    rootDir: platform === 'linux' ? fileURLToPath(new URL('../../../', import.meta.url)) : root,
    platform,
    authority: { producerStackName: 'repo-dev-a1cc5e0671' },
    observedStartedSeq: null,
    requestedComponents: ['web'],
    env: process.env,
    workerPath,
  });

  assert.equal(result.snapshotId, 'snapshot-real-child');
  assert.equal(result.changed, true);
  assert.equal(result.buildMode, 'qa-runtime');
  if (platform === 'linux') {
    assert.equal(result.nice, 10);
    assert.match(result.cgroup, /\/happier-jobs\.slice\//);
    t.diagnostic(JSON.stringify({ nice: result.nice, cgroup: result.cgroup }));
  }
});
}

test('repository publication preserves bounded child failure evidence', async () => {
  await assert.rejects(
    () => publishRepositoryRuntimeSnapshotInChildProcess({
      rootDir: '/work/happier',
      authority: { producerStackName: 'repo-dev-a1cc5e0671' },
      observedStartedSeq: null,
      requestedComponents: ['daemon'],
      env: process.env,
      spawnProcImpl(_label, _command, _args, _env, options) {
        options.lineFilter({
          stream: 'stderr',
          line: '[component-artifacts] daemon support publication changed before staging',
        });
        return {
          exitCode: null,
          completion: Promise.resolve({ code: 1, signal: null }),
        };
      },
    }),
    (error) => (
      error?.code === 'EEXIT'
      && error?.exitCode === 1
      && error?.signal === null
      && error.message.includes('[stderr]')
      && error.message.includes('daemon support publication changed before staging')
    ),
  );
});

test('only the managed checkout-pinned repository producer owns automatic publication', () => {
  const authority = { producerStackName: 'repo-dev-a1cc5e0671', explicit: false };

  assert.equal(isRepositoryRuntimePublicationOwner({
    stackMode: true,
    stackName: authority.producerStackName,
    authority,
  }), true);
  assert.equal(isRepositoryRuntimePublicationOwner({
    stackMode: true,
    stackName: 'main',
    authority,
  }), false);
  assert.equal(isRepositoryRuntimePublicationOwner({
    stackMode: true,
    stackName: 'qa-consumer',
    authority,
  }), false);
  assert.equal(isRepositoryRuntimePublicationOwner({
    stackMode: false,
    stackName: authority.producerStackName,
    authority,
  }), false);
  assert.equal(isRepositoryRuntimePublicationOwner({
    stackMode: true,
    stackName: 'qa-consumer',
    authority: { producerStackName: 'qa-consumer', explicit: true },
  }), false);
});

test('the repository controller publishes the resolver’s actual changed subset through the canonical publisher', async () => {
  const rootDir = '/work/happier';
  const authority = {
    producerStackName: 'repo-dev-a1cc5e0671',
    producerStackBaseDir: '/stacks/repo-dev-a1cc5e0671',
  };
  const env = { HAPPIER_STACK_STORAGE_DIR: '/stacks', [WORKSPACE_BUILD_MODE_ENV]: 'qa-runtime' };
  const runtimeStatePath = '/stacks/repo-dev-a1cc5e0671/stack.runtime.json';
  const resolved = [];
  const published = [];
  const stateWrites = [];
  const controller = createRepositoryRuntimePublicationController({
    rootDir,
    authority,
    env: { ...env, [WORKSPACE_BUILD_MODE_ENV]: 'strict' },
    runtimeStatePath,
    resolveRepositoryRuntimePublicationComponents: async (input) => {
      resolved.push(input);
      return { components: ['server'], currentSnapshotId: 'snapshot-old' };
    },
    publishRepositoryRuntimeSnapshot: async (input) => {
      published.push(input);
      return { snapshotId: 'snapshot-server-new', changedComponents: ['server'] };
    },
    recordStackRuntimeUpdate: async (path, patch) => stateWrites.push({ path, patch }),
  });

  await controller.markRefreshed(['server', 'daemon']);

  assert.deepEqual(resolved, [
    { rootDir, authority, env, requestedComponents: ['server'] },
    { rootDir, authority, env, requestedComponents: ['daemon'] },
  ]);
  assert.equal(published[0].observedStartedSeq, null);
  assert.deepEqual(published.map(({ observedStartedSeq, ...input }) => input), [{ rootDir, authority, env, requestedComponents: ['server'] }]);
  assert.deepEqual(stateWrites.at(-1), {
    path: runtimeStatePath,
    patch: {
      runtimePublication: {
        phase: 'current',
        components: {
          server: { phase: 'current', error: null },
          daemon: { phase: 'current', error: null },
        },
        currentSnapshotId: 'snapshot-server-new',
      },
    },
  });
});

test('a server-only successful refresh publishes the changed server and reuses unchanged artifacts', async () => {
  const publications = [];
  const statuses = [];
  const publisher = createBackgroundRuntimeSnapshotPublisher({
    resolveComponents: async ({ requestedComponents }) => ({
      components: requestedComponents,
      currentSnapshotId: 'snapshot-old',
    }),
    publishComponents: async ({ components }) => {
      publications.push(components);
      return {
        snapshotId: 'snapshot-server-new',
        changedComponents: ['server'],
        artifacts: {
          web: { reused: true },
          server: { reused: false },
          daemon: { reused: true },
        },
      };
    },
    publishStatus: async (status) => statuses.push(status),
  });

  const result = await publisher.markRefreshed(['server']);

  assert.equal(result?.snapshotId, 'snapshot-server-new');
  assert.deepEqual(publications, [['server']]);
  assert.deepEqual(statuses.at(-1), {
    phase: 'current',
    components: {
      server: { phase: 'current', error: null },
    },
    currentSnapshotId: 'snapshot-server-new',
  });
  assert.deepEqual(statuses.map((status) => status.components.server.phase), [
    'stale',
    'publishing',
    'current',
  ]);
});

test('a requested component whose identity is already current becomes current with the completed snapshot', async () => {
  const statuses = [];
  const publisher = createBackgroundRuntimeSnapshotPublisher({
    resolveComponents: async () => ({
      components: ['server'],
      currentSnapshotId: 'snapshot-old',
    }),
    publishComponents: async () => ({
      snapshotId: 'snapshot-server-new',
      changedComponents: ['server'],
    }),
    publishStatus: async (status) => statuses.push(status),
  });

  await publisher.markRefreshed(['server', 'daemon']);

  assert.deepEqual(statuses.at(-1), {
    phase: 'current',
    components: {
      server: { phase: 'current', error: null },
      daemon: { phase: 'current', error: null },
    },
    currentSnapshotId: 'snapshot-server-new',
  });
});

test('publication hints use the build owner canonical component order', async () => {
  const requests = [];
  const publisher = createBackgroundRuntimeSnapshotPublisher({
    resolveComponents: async ({ requestedComponents }) => {
      requests.push(requestedComponents);
      return { components: requestedComponents, currentSnapshotId: 'snapshot-old' };
    },
    publishComponents: async ({ requestedComponents }) => ({
      snapshotId: 'snapshot-new',
      components: requestedComponents,
    }),
  });

  await publisher.markRefreshed(['daemon', 'server']);

  assert.deepEqual(requests, [['server'], ['daemon']]);
});

test('a burst during publication reports queued progress on stderr and performs exactly one trailing identity recomputation', async (t) => {
  const firstPublishEntered = createDeferred();
  const releaseFirstPublish = createDeferred();
  const resolvedRequests = [];
  const publications = [];
  const requestObservations = [];
  let startedSeq = 100;
  const progress = [];
  const stdout = [];
  t.mock.method(process.stderr, 'write', (chunk) => { progress.push(String(chunk)); return true; });
  t.mock.method(process.stdout, 'write', (chunk) => { stdout.push(String(chunk)); return true; });
  const publisher = createBackgroundRuntimeSnapshotPublisher({
    captureObservedStartedSeq: () => startedSeq,
    resolveComponents: async ({ requestedComponents }) => {
      resolvedRequests.push(requestedComponents);
      return { components: requestedComponents, currentSnapshotId: 'snapshot-old' };
    },
    publishComponents: async ({ components, observedStartedSeq }) => {
      publications.push(components);
      requestObservations.push(observedStartedSeq);
      if (publications.length === 1) {
        firstPublishEntered.resolve();
        await releaseFirstPublish.promise;
      }
      return {
        snapshotId: `snapshot-${publications.length}`,
        changedComponents: components,
      };
    },
  });

  const first = publisher.markRefreshed(['server']);
  await firstPublishEntered.promise;
  startedSeq = 200;
  const second = publisher.markRefreshed(['server']);
  startedSeq = 300;
  const third = publisher.markRefreshed(['daemon']);
  startedSeq = 400;
  assert.ok(progress.some((message) => message.includes('daemon')), 'a queued component must be visible before the incumbent finishes');
  releaseFirstPublish.resolve();

  await Promise.all([first, second, third]);
  assert.deepEqual(stdout, [], 'publication progress must not contaminate JSON stdout');

  assert.deepEqual(resolvedRequests, [
    ['server'],
    ['server'],
    ['daemon'],
  ]);
  assert.deepEqual(publications, [
    ['server'],
    ['server'],
    ['daemon'],
  ]);
  assert.deepEqual(requestObservations, [100, 200, 300], 'dispatch delay must not replace the component admission observation');
});

test('startup watcher daemon dirtiness folds into restart reconciliation before daemon publication', async () => {
  const webResolutionEntered = createDeferred();
  const releaseWebResolution = createDeferred();
  const resolvedRequests = [];
  const publications = [];
  const publisher = createBackgroundRuntimeSnapshotPublisher({
    resolveComponents: async ({ requestedComponents }) => {
      resolvedRequests.push(requestedComponents);
      if (requestedComponents[0] === 'web') {
        webResolutionEntered.resolve();
        await releaseWebResolution.promise;
        return { components: [], currentSnapshotId: 'snapshot-old' };
      }
      if (requestedComponents[0] === 'server') {
        return { components: [], currentSnapshotId: 'snapshot-old' };
      }
      return { components: ['daemon'], currentSnapshotId: 'snapshot-old' };
    },
    publishComponents: async ({ components }) => {
      publications.push(components);
      return { snapshotId: 'snapshot-daemon-new', changedComponents: components };
    },
  });

  const reconciliation = publisher.reconcileAfterRestart();
  await webResolutionEntered.promise;
  const watcherRefresh = publisher.markRefreshed(['daemon']);
  releaseWebResolution.resolve();

  await Promise.all([reconciliation, watcherRefresh]);

  assert.deepEqual(resolvedRequests, [['web'], ['server'], ['daemon']]);
  assert.deepEqual(publications, [['daemon']]);
});

test('a daemon input change during daemon publication receives one bounded trailing pass', async () => {
  const firstPublicationEntered = createDeferred();
  const releaseFirstPublication = createDeferred();
  const resolvedRequests = [];
  const publications = [];
  const publisher = createBackgroundRuntimeSnapshotPublisher({
    resolveComponents: async ({ requestedComponents }) => {
      resolvedRequests.push(requestedComponents);
      return { components: requestedComponents, currentSnapshotId: 'snapshot-old' };
    },
    publishComponents: async ({ components }) => {
      publications.push(components);
      if (publications.length === 1) {
        firstPublicationEntered.resolve();
        await releaseFirstPublication.promise;
      }
      return { snapshotId: `snapshot-daemon-${publications.length}`, changedComponents: components };
    },
  });

  const first = publisher.markRefreshed(['daemon']);
  await firstPublicationEntered.promise;
  const changedDuringPublication = publisher.markRefreshed(['daemon']);
  releaseFirstPublication.resolve();

  await Promise.all([first, changedDuringPublication]);

  assert.deepEqual(resolvedRequests, [['daemon'], ['daemon']]);
  assert.deepEqual(publications, [['daemon'], ['daemon']]);
});

test('a failed publication retains the current snapshot and leaves services outside publisher authority', async () => {
  let currentSnapshotId = 'snapshot-old';
  const services = { server: 'running', daemon: 'running' };
  const statuses = [];
  const publisher = createBackgroundRuntimeSnapshotPublisher({
    resolveComponents: async ({ requestedComponents }) => ({
      components: requestedComponents,
      currentSnapshotId,
    }),
    publishComponents: async () => {
      throw new Error('publisher failed before pointer activation');
    },
    publishStatus: async (status) => statuses.push(status),
    logger: { error() {} },
  });

  const result = await publisher.markRefreshed(['server']);

  assert.equal(result, null);
  assert.equal(currentSnapshotId, 'snapshot-old');
  assert.deepEqual(services, { server: 'running', daemon: 'running' });
  assert.deepEqual(statuses.at(-1), {
    phase: 'failed',
    components: {
      server: { phase: 'failed', error: 'publisher failed before pointer activation' },
    },
    currentSnapshotId: 'snapshot-old',
  });
  assert.deepEqual(statuses.map((status) => status.components.server.phase), [
    'stale',
    'publishing',
    'failed',
  ]);
});

test('a later component failure does not withhold an earlier successful component snapshot', async () => {
  const publications = [];
  const statuses = [];
  const publisher = createBackgroundRuntimeSnapshotPublisher({
    resolveComponents: async ({ requestedComponents }) => ({
      components: requestedComponents,
      currentSnapshotId: 'snapshot-old',
    }),
    publishComponents: async ({ components }) => {
      publications.push(components);
      if (components[0] === 'daemon') {
        throw new Error('daemon source is not currently buildable');
      }
      return { snapshotId: 'snapshot-server-new', changedComponents: components };
    },
    publishStatus: async (status) => statuses.push(status),
    logger: { error() {} },
  });

  const result = await publisher.markRefreshed(['server', 'daemon']);

  assert.equal(result?.snapshotId, 'snapshot-server-new');
  assert.deepEqual(publications, [['server'], ['daemon']]);
  assert.deepEqual(statuses.at(-1), {
    phase: 'failed',
    components: {
      server: { phase: 'current', error: null },
      daemon: { phase: 'failed', error: 'daemon source is not currently buildable' },
    },
    currentSnapshotId: 'snapshot-server-new',
  });
});

test('a component identity failure does not prevent resolving and publishing its healthy neighbor', async () => {
  const resolutions = [];
  const publications = [];
  const statuses = [];
  const publisher = createBackgroundRuntimeSnapshotPublisher({
    resolveComponents: async ({ requestedComponents }) => {
      resolutions.push(requestedComponents);
      if (requestedComponents[0] === 'daemon') {
        throw new Error('daemon identity is unavailable');
      }
      return { components: requestedComponents, currentSnapshotId: 'snapshot-old' };
    },
    publishComponents: async ({ components }) => {
      publications.push(components);
      return { snapshotId: 'snapshot-server-new', changedComponents: components };
    },
    publishStatus: async (status) => statuses.push(status),
    logger: { error() {} },
  });

  const result = await publisher.markRefreshed(['server', 'daemon']);

  assert.equal(result?.snapshotId, 'snapshot-server-new');
  assert.deepEqual(resolutions, [['server'], ['daemon']]);
  assert.deepEqual(publications, [['server']]);
  assert.deepEqual(statuses.at(-1), {
    phase: 'failed',
    components: {
      server: { phase: 'current', error: null },
      daemon: { phase: 'failed', error: 'daemon identity is unavailable' },
    },
    currentSnapshotId: 'snapshot-server-new',
  });
});

test('a failed publication leaves requested components already matching the current snapshot current', async () => {
  const statuses = [];
  const publisher = createBackgroundRuntimeSnapshotPublisher({
    resolveComponents: async () => ({
      components: ['server'],
      currentSnapshotId: 'snapshot-old',
    }),
    publishComponents: async () => {
      throw new Error('server publication failed');
    },
    publishStatus: async (status) => statuses.push(status),
    logger: { error() {} },
  });

  await publisher.markRefreshed(['server', 'daemon']);

  assert.deepEqual(statuses.at(-1), {
    phase: 'failed',
    components: {
      server: { phase: 'failed', error: 'server publication failed' },
      daemon: { phase: 'current', error: null },
    },
    currentSnapshotId: 'snapshot-old',
  });
});

test("a failed publication waits for its component's next material refresh before retrying", async () => {
  const requested = [];
  let attempts = 0;
  const publisher = createBackgroundRuntimeSnapshotPublisher({
    resolveComponents: async ({ requestedComponents }) => ({
      components: requestedComponents,
      currentSnapshotId: 'snapshot-old',
    }),
    publishComponents: async ({ requestedComponents }) => {
      attempts += 1;
      requested.push(requestedComponents);
      if (attempts === 1) throw new Error('first publication failed');
      return { snapshotId: 'snapshot-new', changedComponents: requestedComponents };
    },
    logger: { error() {} },
  });

  await publisher.markRefreshed(['server']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requested, [['server']]);

  await publisher.markRefreshed(['daemon']);
  assert.deepEqual(requested, [['server'], ['daemon']]);

  await publisher.markRefreshed(['server']);
  assert.deepEqual(requested, [['server'], ['daemon'], ['server']]);
});

test('an input-change rejection gets one bounded trailing publication attempt', async () => {
  let attempts = 0;
  const publisher = createBackgroundRuntimeSnapshotPublisher({
    resolveComponents: async ({ requestedComponents }) => ({
      components: requestedComponents,
      currentSnapshotId: 'snapshot-old',
    }),
    publishComponents: async ({ requestedComponents }) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error(
          '[component-artifacts] daemon support publication changed before staging',
        );
      }
      return { snapshotId: 'snapshot-new', changedComponents: requestedComponents };
    },
    logger: { error() {} },
  });

  const result = await publisher.markRefreshed(['daemon']);

  assert.equal(attempts, 2);
  assert.equal(result?.snapshotId, 'snapshot-new');
});

test('shutdown does not let an already-started publication update runtime status afterward', async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const statuses = [];
  const publisher = createBackgroundRuntimeSnapshotPublisher({
    resolveComponents: async ({ requestedComponents }) => ({
      components: requestedComponents,
      currentSnapshotId: 'snapshot-old',
    }),
    publishComponents: async () => {
      entered.resolve();
      await release.promise;
      return { snapshotId: 'snapshot-new', changedComponents: ['server'] };
    },
    publishStatus: async (status) => statuses.push(status),
  });

  const publication = publisher.markRefreshed(['server']);
  await entered.promise;
  publisher.close();
  release.resolve();
  await publication;

  assert.deepEqual(statuses.at(-1), {
    phase: 'publishing',
    components: { server: { phase: 'publishing', error: null } },
    currentSnapshotId: 'snapshot-old',
  });
});

test('restart reconstruction compares every component identity instead of restoring a persisted publication queue', async () => {
  const resolvedRequests = [];
  const publications = [];
  const publisher = createBackgroundRuntimeSnapshotPublisher({
    resolveComponents: async ({ requestedComponents }) => {
      resolvedRequests.push(requestedComponents);
      return {
        components: ['server'],
        currentSnapshotId: 'snapshot-old',
      };
    },
    publishComponents: async ({ components }) => {
      publications.push(components);
      return { snapshotId: 'snapshot-server-new', changedComponents: components };
    },
  });

  const result = await publisher.reconcileAfterRestart();

  assert.equal(result?.snapshotId, 'snapshot-server-new');
  assert.deepEqual(resolvedRequests, [['web'], ['server'], ['daemon']]);
  assert.deepEqual(publications, [['server']]);
});

test('successful preparation marks its component publishable before stale activation is fenced', async () => {
  const marked = [];
  const publisher = {
    markRefreshed(components) {
      marked.push(components);
      return Promise.resolve();
    },
  };
  const executor = wrapReloadExecutorWithRuntimeSnapshotPublication({
    executor: {
      target: 'server',
      async restart() {
        return { restarted: true };
      },
      async build() {
        return { ok: true };
      },
    },
    publisher,
  });
  const skippedExecutor = wrapReloadExecutorWithRuntimeSnapshotPublication({
    executor: {
      target: 'daemon',
      async build() {
        return { skipped: true, reason: 'stale-generation' };
      },
      async restart() {
        throw new Error('a skipped preparation must not reach restart');
      },
    },
    publisher,
  });

  assert.deepEqual(await executor.build({}), { ok: true });
  assert.deepEqual(marked, [['server']], 'publication must not wait for live activation');
  assert.deepEqual(await executor.restart({}), { restarted: true });
  assert.deepEqual(await skippedExecutor.build({}), {
    skipped: true,
    reason: 'stale-generation',
  });
  assert.deepEqual(marked, [['server']], 'restart must not enqueue the same prepared component twice');
});

test('publication-only reload executors keep remotely hosted components subscribed to source changes', async () => {
  const marked = [];
  const executor = createRuntimeSnapshotPublicationReloadExecutor({
    component: 'server',
    publisher: {
      markRefreshed(components) {
        marked.push(components);
        return Promise.resolve();
      },
    },
  });

  assert.equal(executor.target, 'server');
  assert.deepEqual(await executor.build({ generation: 3 }), {
    publicationRequested: true,
  });
  assert.deepEqual(await executor.restart({ generation: 3 }), {
    restarted: false,
    reason: 'publication-only',
  });
  assert.deepEqual(marked, [['server']]);
});

test('runtime publication descriptors use the artifact identity owner for every component', () => {
  const calls = [];
  const descriptors = createRuntimeSnapshotPublicationReloadDescriptors({
    repoDir: '/work/happier',
  }, {
    resolveRuntimeComponentSourcePathsImpl({ component, sourceMetadata }) {
      calls.push({ component, sourceMetadata });
      return [`/work/happier/${component}/sources`];
    },
  });

  assert.deepEqual(descriptors.map(({ id, target, paths }) => ({ id, target, paths })), [
    { id: 'runtime-publication:server', target: 'server', paths: ['/work/happier/server/sources'] },
    { id: 'runtime-publication:daemon', target: 'daemon', paths: ['/work/happier/daemon/sources'] },
  ]);
  assert.deepEqual(calls.map(({ component }) => component), ['server', 'daemon']);
  assert.ok(calls.every(({ sourceMetadata }) => sourceMetadata.repoDir === '/work/happier'));
});

test('remote readiness republishes only components that newly reached running', () => {
  assert.deepEqual(resolveRemoteRuntimePublicationComponents({
    previousState: {
      serviceStatus: { server: 'starting', expo: 'running', daemon: 'degraded' },
    },
    nextState: {
      status: 'running',
      services: { server: true, expo: true, daemon: true },
      serviceStatus: { server: 'running', expo: 'running', daemon: 'running' },
    },
  }), ['server', 'daemon']);
  assert.deepEqual(resolveRemoteRuntimePublicationComponents({
    previousState: null,
    nextState: {
      status: 'running',
      services: { expo: true },
      serviceStatus: { expo: 'running' },
    },
  }), ['web']);
});
