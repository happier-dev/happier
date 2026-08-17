const RUNTIME_COMPONENTS = ['web', 'server', 'daemon'];
const RUNTIME_COMPONENT_SET = new Set(RUNTIME_COMPONENTS);

function normalizeComponents(components) {
  const selected = new Set(
    (Array.isArray(components) ? components : [])
      .map((component) => String(component ?? '').trim())
      .filter((component) => RUNTIME_COMPONENT_SET.has(component)),
  );
  return RUNTIME_COMPONENTS.filter((component) => selected.has(component));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function isRepositoryRuntimePublicationOwner({
  stackMode,
  stackName,
  authority,
} = {}) {
  const producerStackName = String(authority?.producerStackName ?? '').trim();
  return Boolean(
    stackMode
    && authority?.explicit === false
    && producerStackName
    && String(stackName ?? '').trim() === producerStackName,
  );
}

export function createRepositoryRuntimePublicationController({
  rootDir,
  authority,
  env = process.env,
  runtimeStatePath,
  resolveRepositoryRuntimePublicationComponents,
  publishRepositoryRuntimeSnapshot,
  recordStackRuntimeUpdate,
  isShuttingDown,
  logger,
} = {}) {
  if (typeof resolveRepositoryRuntimePublicationComponents !== 'function') {
    throw new Error('repository runtime publication requires the component resolver');
  }
  if (typeof publishRepositoryRuntimeSnapshot !== 'function') {
    throw new Error('repository runtime publication requires the canonical publisher');
  }
  if (!runtimeStatePath || typeof recordStackRuntimeUpdate !== 'function') {
    throw new Error('repository runtime publication requires the existing runtime state writer');
  }

  return createBackgroundRuntimeSnapshotPublisher({
    resolveComponents: async ({ requestedComponents }) => resolveRepositoryRuntimePublicationComponents({
      rootDir,
      authority,
      env,
      requestedComponents,
    }),
    publishComponents: async ({ components }) => publishRepositoryRuntimeSnapshot({
      rootDir,
      authority,
      env,
      requestedComponents: components,
    }),
    publishStatus: async (status) => recordStackRuntimeUpdate(runtimeStatePath, {
      runtimePublication: status,
    }),
    isShuttingDown,
    logger,
  });
}

export function wrapReloadExecutorWithRuntimeSnapshotPublication({
  component,
  executor,
  publisher,
  logger = console,
} = {}) {
  const normalizedComponent = normalizeComponents([component ?? executor?.target])[0];
  if (!normalizedComponent || !executor || typeof executor.restart !== 'function') return executor;
  const restart = executor.restart;
  return {
    ...executor,
    async restart(context = {}) {
      const result = await restart.call(executor, context);
      if (result?.restarted !== true || typeof publisher?.markRefreshed !== 'function') return result;
      try {
        void Promise.resolve(publisher.markRefreshed([normalizedComponent])).catch((error) => {
          logger.error?.(
            `[local] runtime publication request failed after ${normalizedComponent} refresh: ${errorMessage(error)}`,
          );
        });
      } catch (error) {
        logger.error?.(
          `[local] runtime publication request failed after ${normalizedComponent} refresh: ${errorMessage(error)}`,
        );
      }
      return result;
    },
  };
}

/**
 * Keeps one repository-runtime publication active for a source stack. It deliberately
 * stores only transient coalescing state: restart recovery always compares current
 * component identities with the selected snapshot through the build owner.
 */
export function createBackgroundRuntimeSnapshotPublisher({
  resolveComponents,
  publishComponents,
  publishStatus = async () => {},
  isShuttingDown = () => false,
  logger = console,
} = {}) {
  if (typeof resolveComponents !== 'function') {
    throw new Error('createBackgroundRuntimeSnapshotPublisher requires resolveComponents');
  }
  if (typeof publishComponents !== 'function') {
    throw new Error('createBackgroundRuntimeSnapshotPublisher requires publishComponents');
  }

  const componentStatus = new Map();
  const dirtyComponents = new Set();
  let currentSnapshotId = null;
  let inFlight = null;
  let publishAgain = false;
  let closed = false;

  const createStatus = () => {
    const components = Object.fromEntries(Array.from(componentStatus.entries()).map(([component, value]) => [
      component,
      { phase: value.phase, error: value.error ?? null },
    ]));
    const phases = Array.from(componentStatus.values()).map((entry) => entry.phase);
    const phase = phases.includes('publishing')
      ? 'publishing'
      : phases.includes('stale')
        ? 'stale'
        : phases.includes('failed')
          ? 'failed'
          : 'current';
    return {
      phase,
      components,
      currentSnapshotId,
    };
  };

  const reportStatus = async () => {
    try {
      await publishStatus(createStatus());
    } catch (error) {
      logger.warn?.(
        `[local] runtime publication status could not be recorded: ${errorMessage(error)}`,
      );
    }
  };

  const setComponentsPhase = (components, phase, error = null) => {
    for (const component of normalizeComponents(components)) {
      componentStatus.set(component, { phase, error: error ? String(error) : null });
    }
  };

  const markPublished = (components) => {
    for (const component of normalizeComponents(components)) {
      if (dirtyComponents.has(component)) {
        componentStatus.set(component, { phase: 'stale', error: null });
      } else {
        componentStatus.set(component, { phase: 'current', error: null });
      }
    }
  };

  const resolveForPublication = async (requestedComponents) => {
    const result = await resolveComponents({ requestedComponents });
    const resolvedSnapshotId = String(result?.currentSnapshotId ?? '').trim();
    return {
      components: normalizeComponents(result?.components),
      currentSnapshotId: resolvedSnapshotId || currentSnapshotId,
    };
  };

  const runPublication = async () => {
    let lastResult = null;
    for (;;) {
      if (closed || isShuttingDown?.()) return lastResult;
      const requestedComponents = normalizeComponents(Array.from(dirtyComponents));
      dirtyComponents.clear();
      publishAgain = false;
      if (!requestedComponents.length) return lastResult;
      let publishedInCycle = false;

      setComponentsPhase(requestedComponents, 'stale');
      await reportStatus();
      if (closed || isShuttingDown?.()) return lastResult;

      // Identity resolution and publication stay component-local. The canonical
      // builders and snapshot commit owner remain unchanged; this loop merely
      // prevents one component's unavailable inputs from withholding a healthy
      // neighbor. Serial execution avoids a second scheduler.
      for (const component of requestedComponents) {
        let resolved;
        try {
          resolved = await resolveForPublication([component]);
        } catch (error) {
          if (closed || isShuttingDown?.()) return lastResult;
          dirtyComponents.add(component);
          setComponentsPhase([component], 'failed', errorMessage(error));
          await reportStatus();
          logger.error?.(
            `[local] ${component} runtime publication identity refresh failed; keeping the current snapshot selected. ${errorMessage(error)}`,
          );
          continue;
        }
        if (closed || isShuttingDown?.()) return lastResult;
        if (!publishedInCycle && resolved.currentSnapshotId) {
          currentSnapshotId = resolved.currentSnapshotId;
        }
        if (!resolved.components.includes(component)) {
          markPublished([component]);
          await reportStatus();
          continue;
        }

        setComponentsPhase([component], 'publishing');
        await reportStatus();
        if (closed || isShuttingDown?.()) return lastResult;
        try {
          const result = await publishComponents({
            requestedComponents: [component],
            components: [component],
            currentSnapshotId,
          });
          if (closed || isShuttingDown?.()) return lastResult;
          const snapshotId = String(result?.snapshotId ?? '').trim();
          if (snapshotId) currentSnapshotId = snapshotId;
          publishedInCycle = true;
          markPublished([component]);
          lastResult = result ?? lastResult;
          await reportStatus();
        } catch (error) {
          if (closed || isShuttingDown?.()) return lastResult;
          dirtyComponents.add(component);
          setComponentsPhase([component], 'failed', errorMessage(error));
          await reportStatus();
          logger.error?.(
            `[local] ${component} runtime publication failed; keeping the current snapshot selected and source services unchanged. ${errorMessage(error)}`,
          );
        }
      }

      if (!publishAgain || closed || isShuttingDown?.()) return lastResult;
    }
  };

  const enqueue = (components) => {
    const normalizedComponents = normalizeComponents(components);
    if (!normalizedComponents.length || closed || isShuttingDown?.()) return inFlight ?? Promise.resolve(null);
    for (const component of normalizedComponents) {
      dirtyComponents.add(component);
      componentStatus.set(component, { phase: 'stale', error: null });
    }

    if (inFlight) {
      publishAgain = true;
      return inFlight;
    }

    inFlight = runPublication().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    markRefreshed(components) {
      return enqueue(components);
    },
    async reconcileAfterRestart() {
      if (closed || isShuttingDown?.()) return null;
      return await enqueue(RUNTIME_COMPONENTS);
    },
    close() {
      closed = true;
      publishAgain = false;
    },
  };
}
