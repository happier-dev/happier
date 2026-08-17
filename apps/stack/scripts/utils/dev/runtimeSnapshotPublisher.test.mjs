import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBackgroundRuntimeSnapshotPublisher,
  createRepositoryRuntimePublicationController,
  isRepositoryRuntimePublicationOwner,
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
  const env = { HAPPIER_STACK_STORAGE_DIR: '/stacks' };
  const runtimeStatePath = '/stacks/repo-dev-a1cc5e0671/stack.runtime.json';
  const resolved = [];
  const published = [];
  const stateWrites = [];
  const controller = createRepositoryRuntimePublicationController({
    rootDir,
    authority,
    env,
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

  assert.deepEqual(resolved, [{ rootDir, authority, env, requestedComponents: ['server', 'daemon'] }]);
  assert.deepEqual(published, [{ rootDir, authority, env, requestedComponents: ['server'] }]);
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

  assert.deepEqual(requests, [['server', 'daemon']]);
});

test('a burst during publication performs exactly one trailing identity recomputation', async () => {
  const firstPublishEntered = createDeferred();
  const releaseFirstPublish = createDeferred();
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
  const second = publisher.markRefreshed(['server']);
  const third = publisher.markRefreshed(['daemon']);
  releaseFirstPublish.resolve();

  await Promise.all([first, second, third]);

  assert.deepEqual(resolvedRequests, [
    ['server'],
    ['server', 'daemon'],
  ]);
  assert.deepEqual(publications, [
    ['server'],
    ['server', 'daemon'],
  ]);
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

test('a failed publication waits for the next material refresh before retrying', async () => {
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
  assert.deepEqual(requested, [['server'], ['server', 'daemon']]);
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
  assert.deepEqual(resolvedRequests, [['web', 'server', 'daemon']]);
  assert.deepEqual(publications, [['server']]);
});

test('only a successful live refresh marks its existing executor-target component dirty', async () => {
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
      async restart() {
        return { skipped: true, reason: 'daemon-control-unavailable' };
      },
    },
    publisher,
  });

  assert.deepEqual(await executor.restart({}), { restarted: true });
  assert.deepEqual(await skippedExecutor.restart({}), {
    skipped: true,
    reason: 'daemon-control-unavailable',
  });
  assert.deepEqual(marked, [['server']]);
});
