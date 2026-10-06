import { fileURLToPath } from 'node:url';
import { WORKSPACE_BUILD_MODE_ENV } from '../../../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { captureRuntimePublicationStartedSeq } from '../../build/build_stack_artifacts.mjs';

import { appendBoundedTail, formatFailureDiagnostic, spawnProc } from '../proc/proc.mjs';
import { resolveRuntimeComponentSourcePaths } from '../../build/runtime_artifact_identity.mjs';
import { resolveRuntimePublicationPhase } from '../stack/runtime_state.mjs';
import {
  readDevReloadWatchChangeSignature,
  readDevReloadWatchChangeSignatureAsync,
} from './watchSignature.mjs';

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
  observedStartedSeq = captureRuntimePublicationStartedSeq({ authority }),
  env = process.env,
  platform = process.platform,
  children = [],
  workerPath = fileURLToPath(new URL('./runtimeSnapshotPublicationWorker.mjs', import.meta.url)),
  spawnProcImpl = spawnProc,
} = {}) {
  env = { ...env, [WORKSPACE_BUILD_MODE_ENV]: 'qa-runtime' };
  const request = Buffer.from(JSON.stringify({
    rootDir,
    authority,
    requestedComponents: normalizeComponents(requestedComponents),
    observedStartedSeq,
  }), 'utf8').toString('base64url');
  let result = null;
  let resultError = null;
  const diagnosticStreamMaxChars = 8_000;
  let diagnosticOut = '';
  let diagnosticErr = '';
  let failureDiagnosticTruncated = false;
  // Publication writes this machine's runtime store. Reuse protected local
  // dispatch without sending those writes through automatic remote placement.
  // Publication repairs the running Stack, so it must remain backgrounded but
  // must not wait behind the machine-wide heavyweight validation queue.
  const command = platform === 'linux'
    ? fileURLToPath(new URL('../../../bin/hstack-exec', import.meta.url))
    : process.execPath;
  const args = platform === 'linux'
    ? ['--local', '--', process.execPath, workerPath, request]
    : [workerPath, request];
  const childEnv = platform === 'linux'
    ? { ...env, HAPPIER_HSTACK_DISPATCH_CONTROL: '1' }
    : env;
  const child = spawnProcImpl(
    'runtime-publisher',
    command,
    args,
    childEnv,
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
  env = { ...env, [WORKSPACE_BUILD_MODE_ENV]: 'qa-runtime' };
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
    captureObservedStartedSeq: () => captureRuntimePublicationStartedSeq({ authority }),
    resolveComponents: async ({ requestedComponents }) => resolveRepositoryRuntimePublicationComponents({
      rootDir,
      authority,
      env,
      requestedComponents,
    }),
    publishComponents: async ({ components, observedStartedSeq }) => publishRepositoryRuntimeSnapshot({
      rootDir,
      authority,
      env,
      requestedComponents: components,
      observedStartedSeq,
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
  const requestPublication = () => requestRuntimeSnapshotPublication({
    component: normalizedComponent,
    publisher,
    logger,
  });
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

function requestRuntimeSnapshotPublication({ component, publisher, logger = console } = {}) {
  if (typeof publisher?.markRefreshed !== 'function') return false;
  try {
    void Promise.resolve(publisher.markRefreshed([component])).catch((error) => {
      logger.error?.(
        `[local] runtime publication request failed after ${component} refresh: ${errorMessage(error)}`,
      );
    });
    return true;
  } catch (error) {
    logger.error?.(
      `[local] runtime publication request failed after ${component} refresh: ${errorMessage(error)}`,
    );
    return false;
  }
}

/**
 * Keep runtime publication subscribed when a live component is hosted by a
 * remote dev target. The remote target owns service activation; this executor
 * owns only the repository snapshot request for the same admitted source
 * generation.
 */
export function createRuntimeSnapshotPublicationReloadExecutor({
  component,
  publisher,
  logger = console,
} = {}) {
  const normalizedComponent = normalizeComponents([component])[0];
  if (!normalizedComponent || typeof publisher?.markRefreshed !== 'function') return null;
  return {
    target: normalizedComponent,
    async build() {
      return {
        publicationRequested: requestRuntimeSnapshotPublication({
          component: normalizedComponent,
          publisher,
          logger,
        }),
      };
    },
    async restart() {
      return { restarted: false, reason: 'publication-only' };
    },
  };
}

export function createRuntimeSnapshotPublicationReloadDescriptors({
  repoDir,
} = {}, {
  resolveRuntimeComponentSourcePathsImpl = resolveRuntimeComponentSourcePaths,
} = {}) {
  const sourceMetadata = { repoDir: String(repoDir ?? '').trim() };
  return ['server', 'daemon'].map((component) => {
    const paths = resolveRuntimeComponentSourcePathsImpl({ component, sourceMetadata });
    return {
      id: `runtime-publication:${component}`,
      target: component,
      paths,
      readSignature: () => readDevReloadWatchChangeSignature(paths),
      readSignatureAsync: (_descriptor, options) => readDevReloadWatchChangeSignatureAsync(paths, options),
    };
  }).filter((descriptor) => descriptor.paths.length > 0);
}

export function resolveRemoteRuntimePublicationComponents({
  previousState,
  nextState,
} = {}) {
  if (nextState?.status !== 'running') return [];
  const serviceToComponent = [
    ['expo', 'web'],
    ['server', 'server'],
    ['daemon', 'daemon'],
  ];
  return serviceToComponent
    .filter(([service]) => (
      nextState?.services?.[service] === true
      && nextState?.serviceStatus?.[service] === 'running'
      && previousState?.serviceStatus?.[service] !== 'running'
    ))
    .map(([, component]) => component);
}

/**
 * Keeps one repository-runtime publication active for a source stack. It deliberately
 * stores only transient coalescing state: restart reconciliation submits current
 * component demand through the build owner.
 */
export function createBackgroundRuntimeSnapshotPublisher({
  resolveComponents,
  publishComponents,
  captureObservedStartedSeq = () => null,
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
  const requestObservations = new Map();
  let currentSnapshotId = null;
  let inFlight = null;
  let publishAgain = false;
  let closed = false;

  const createStatus = () => {
    const components = Object.fromEntries(Array.from(componentStatus.entries()).map(([component, value]) => [
      component,
      { phase: value.phase, error: value.error ?? null },
    ]));
    return {
      phase: resolveRuntimePublicationPhase(components),
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
      const cycleRequestObservations = new Map(requestObservations);
      dirtyComponents.clear();
      requestObservations.clear();
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
        // A watcher notification that arrived after this cycle started but
        // before this component's identity was read is already represented by
        // the work below. Consume that duplicate demand here; a change that
        // arrives during resolution or publication remains dirty and gets the
        // one trailing recomputation.
        dirtyComponents.delete(component);
        const observedStartedSeq = requestObservations.has(component)
          ? requestObservations.get(component) : cycleRequestObservations.get(component);
        requestObservations.delete(component);
        process.stderr.write(`[local] resolving ${component} runtime publication inputs.\n`);
        let resolved;
        try {
          resolved = await resolveForPublication([component]);
        } catch (error) {
          if (closed || isShuttingDown?.()) return lastResult;
          // A same-component demand that arrived while resolution ran remains
          // dirty. Do not make the failure itself dirty: an unrelated component
          // refresh must not retry this component.
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
            observedStartedSeq,
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
          // A caller demand received during publication is already dirty. Only
          // the publisher's explicit input-change contract creates its own retry.
          if (retryInputChange) {
            dirtyComponents.add(component);
            if (!requestObservations.has(component)) requestObservations.set(component, captureObservedStartedSeq());
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

      if (!publishAgain || dirtyComponents.size === 0 || closed || isShuttingDown?.()) return lastResult;
    }
  };

  const enqueue = (components) => {
    const normalizedComponents = normalizeComponents(components);
    if (!normalizedComponents.length || closed || isShuttingDown?.()) return inFlight ?? Promise.resolve(null);
    const observation = captureObservedStartedSeq();
    for (const component of normalizedComponents) {
      dirtyComponents.add(component);
      const previous = requestObservations.get(component);
      requestObservations.set(component, observation === null ? null : Math.max(previous ?? 0, observation));
      componentStatus.set(component, { phase: 'stale', error: null });
    }

    if (inFlight) {
      publishAgain = true;
      process.stderr.write(`[local] queued ${normalizedComponents.join(', ')} runtime publication; waiting for the active publication.\n`);
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
