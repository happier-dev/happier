import { fileURLToPath } from 'node:url';

import { appendBoundedTail, formatFailureDiagnostic, spawnProc } from '../proc/proc.mjs';

const RUNTIME_COMPONENTS = ['web', 'server', 'daemon'];
const RUNTIME_COMPONENT_SET = new Set(RUNTIME_COMPONENTS);
const RUNTIME_PUBLICATION_INPUT_CHANGE_MESSAGES = [
  'daemon support publication changed before staging',
  'daemon support publication changed while staging',
  'CLI workspace runtime publication changed before staging',
  'CLI workspace runtime publication changed while staging',
  'server runtime support inputs changed while publishing',
  'server runtime support inputs changed while staging',
];

export const RUNTIME_PUBLICATION_RESULT_PREFIX = '__HAPPIER_RUNTIME_PUBLICATION_RESULT__=';

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

function isRuntimePublicationInputChangeError(error) {
  const message = errorMessage(error);
  return RUNTIME_PUBLICATION_INPUT_CHANGE_MESSAGES.some((diagnostic) => message.includes(diagnostic));
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

/**
 * Run the canonical repository publisher outside the Stack owner process. Artifact
 * assembly is intentionally CPU/filesystem-heavy; keeping it in this process can
 * starve the public proxy even while the last-green backend remains healthy.
 */
export async function publishRepositoryRuntimeSnapshotInChildProcess({
  rootDir,
  authority,
  requestedComponents,
  env = process.env,
  children = [],
  workerPath = fileURLToPath(new URL('./runtimeSnapshotPublicationWorker.mjs', import.meta.url)),
  spawnProcImpl = spawnProc,
} = {}) {
  const request = Buffer.from(JSON.stringify({
    rootDir,
    authority,
    requestedComponents: normalizeComponents(requestedComponents),
  }), 'utf8').toString('base64url');
  let result = null;
  let resultError = null;
  const diagnosticStreamMaxChars = 8_000;
  let diagnosticOut = '';
  let diagnosticErr = '';
  let failureDiagnosticTruncated = false;
  const child = spawnProcImpl(
    'runtime-publisher',
    process.execPath,
    [workerPath, request],
    env,
    {
      cwd: rootDir,
      lineFilter({ stream, line }) {
        if (stream === 'stdout' && line.startsWith(RUNTIME_PUBLICATION_RESULT_PREFIX)) {
          try {
            result = JSON.parse(line.slice(RUNTIME_PUBLICATION_RESULT_PREFIX.length));
          } catch (error) {
            resultError = error;
          }
          return false;
        }
        const chunk = `${line}\n`;
        if (stream === 'stdout') {
          failureDiagnosticTruncated ||= diagnosticOut.length + chunk.length > diagnosticStreamMaxChars;
          diagnosticOut = appendBoundedTail(diagnosticOut, chunk, diagnosticStreamMaxChars);
        } else if (stream === 'stderr') {
          failureDiagnosticTruncated ||= diagnosticErr.length + chunk.length > diagnosticStreamMaxChars;
          diagnosticErr = appendBoundedTail(diagnosticErr, chunk, diagnosticStreamMaxChars);
        }
        return true;
      },
    },
  );
  children.push(child);
  let completion;
  try {
    completion = await child.completion;
  } finally {
    const childIndex = children.indexOf(child);
    if (childIndex >= 0) children.splice(childIndex, 1);
  }
  if (completion?.error) throw completion.error;
  if (completion?.code !== 0) {
    const failureDiagnostic = formatFailureDiagnostic({
      out: diagnosticOut,
      err: diagnosticErr,
      truncated: failureDiagnosticTruncated,
      env,
    });
    const error = new Error(
      `runtime publisher child failed ` +
      `(code=${completion?.code ?? 'null'}, sig=${completion?.signal ?? 'null'})${failureDiagnostic}`,
    );
    error.code = 'EEXIT';
    error.exitCode = completion?.code ?? null;
    error.signal = completion?.signal ?? null;
    throw error;
  }
  if (resultError) {
    throw new Error('runtime publisher child returned an invalid result', { cause: resultError });
  }
  if (!result || typeof result !== 'object') {
    throw new Error('runtime publisher child exited without returning a result');
  }
  return result;
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
  const build = typeof executor.build === 'function' ? executor.build : null;
  const restart = executor.restart;
  const requestPublication = () => {
    if (typeof publisher?.markRefreshed !== 'function') return;
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
  };
  return {
    ...executor,
    ...(build ? {
      async build(context = {}) {
        const result = await build.call(executor, context);
        if (result?.skipped !== true) requestPublication();
        return result;
      },
    } : {}),
    async restart(context = {}) {
      const result = await restart.call(executor, context);
      if (!build && result?.restarted === true) requestPublication();
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
    const consumedInputChangeRetries = new Set();
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
          const retryInputChange = isRuntimePublicationInputChangeError(error)
            && !consumedInputChangeRetries.has(component);
          dirtyComponents.add(component);
          if (retryInputChange) {
            consumedInputChangeRetries.add(component);
            publishAgain = true;
          }
          setComponentsPhase(
            [component],
            retryInputChange ? 'stale' : 'failed',
            retryInputChange ? null : errorMessage(error),
          );
          await reportStatus();
          logger.error?.(
            retryInputChange
              ? `[local] ${component} runtime publication inputs changed; recomputing once from settled inputs.`
              : `[local] ${component} runtime publication failed; keeping the current snapshot selected and source services unchanged. ${errorMessage(error)}`,
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
