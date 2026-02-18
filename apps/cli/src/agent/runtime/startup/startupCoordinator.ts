import type { BackendStartupSpec, StartupContext } from './startupSpec';

export type StartupCoordinatorResult<TArtifacts> = Readonly<{
  artifacts: TArtifacts;
  whenSpawnInvoked: Promise<void>;
  spawnPromise: Promise<void>;
  backgroundPromise: Promise<void>;
  backgroundErrors: ReadonlyArray<{ taskId: string; error: unknown }>;
  cancel: () => void;
}>;

/**
 * Runs backend startup tasks in two phases:
 * - `preSpawn` tasks are awaited before vendor spawn
 * - `background` tasks are started but never awaited before spawn
 */
export function runStartupCoordinator<TArtifacts>(opts: {
  ctx: StartupContext;
  spec: BackendStartupSpec<TArtifacts>;
}): StartupCoordinatorResult<TArtifacts> {
  const controller = new AbortController();
  const { signal } = controller;
  const artifacts = opts.spec.createArtifacts();

  const preSpawnTasks = opts.spec.tasks.filter((t) => t.phase === 'preSpawn');
  const backgroundTasks = opts.spec.tasks.filter((t) => t.phase === 'background');

  const spawnInvoked = createDeferredPromise<void>();
  const backgroundErrors: Array<{ taskId: string; error: unknown }> = [];

  const backgroundPromise = (async () => {
    await Promise.all(
      backgroundTasks.map(async (task) => {
        try {
          await task.run({ ctx: opts.ctx, artifacts, signal });
        } catch (error) {
          backgroundErrors.push({ taskId: task.id, error });
        }
      }),
    );
  })();

  const spawnPromise = (async () => {
    for (const task of preSpawnTasks) {
      await task.run({ ctx: opts.ctx, artifacts, signal });
    }
    opts.ctx.timing?.mark('vendor_spawn_invoked');
    spawnInvoked.resolve();
    await opts.spec.spawnVendor({ ctx: opts.ctx, artifacts, signal });
  })();

  return {
    artifacts,
    whenSpawnInvoked: spawnInvoked.promise,
    spawnPromise,
    backgroundPromise,
    backgroundErrors,
    cancel: () => controller.abort(),
  };
}

function createDeferredPromise<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: (value: T) => resolveFn?.(value),
  };
}
