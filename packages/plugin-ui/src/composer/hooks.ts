import { isPluginError, PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  usePluginHostApi,
  usePluginHostApiComposerRef,
} from '../hostApi/context.js';

import {
  createComposersService,
  type ComposerHandle,
  type ComposersService,
} from './service.js';
import type {
  ComposerReadResultV1,
  ComposerRequestOptions,
  ComposerSnapshotV1,
} from './types.js';

export type ComposerViewStateV1 = Readonly<{
  /** The exact latest read result or observed snapshot; ordinary absence stays in this union. */
  result: ComposerReadResultV1 | null;
  /** A transport or host failure in the SDK's public error vocabulary. */
  error: PluginError | null;
  /** Baseline work is distinct from a last-known-good-preserving refresh. */
  pending: 'initial' | 'refresh' | null;
  /** Retire the hook-owned observation and start one exact replacement read/observe pair. */
  refresh(): Promise<void>;
}>;

type ComposerViewStateInternal = Readonly<{
  handle: ComposerHandle | null;
  result: ComposerReadResultV1 | null;
  error: PluginError | null;
  pending: ComposerViewStateV1['pending'];
}>;

function emptyComposerViewState(handle: ComposerHandle | null): ComposerViewStateInternal {
  return Object.freeze({
    handle,
    result: null,
    error: null,
    pending: handle === null ? null : 'initial',
  });
}

function observedComposerResult(snapshot: ComposerSnapshotV1): ComposerReadResultV1 {
  // `observe` provides the snapshot, not a parallel result grammar. Preserve
  // that immutable snapshot exactly while expressing it through the one read
  // result union authors already consume.
  return Object.freeze({ status: 'ready' as const, snapshot });
}

function asPluginError(error: unknown): PluginError {
  if (isPluginError(error)) return error;
  const candidate = error !== null && typeof error === 'object'
    ? error as Readonly<{ code?: unknown; message?: unknown; retryable?: unknown }>
    : null;
  // Hosted-web already rejects with PluginError. The direct RN/RNW adapter
  // carries the same public code on its host-private Error subclass, so only
  // that stable shape is projected into the SDK's public error class here.
  return new PluginError({
    code: typeof candidate?.code === 'string' && candidate.code.trim() !== ''
      ? candidate.code
      : 'internal_error',
    ...(typeof candidate?.message === 'string' ? { message: candidate.message } : {}),
    ...(candidate?.retryable === true ? { retryable: true } : {}),
  });
}

/**
 * Read the mounted Composer facade.
 *
 * `current()` is non-null only when the host has validated and supplied a
 * Composer surface input; `active()` and exact `get(ref)` remain available on
 * generic mounts through the canonical Host API.
 */
export function useComposer(): ComposersService {
  const hostApi = usePluginHostApi();
  const composerRef = usePluginHostApiComposerRef();
  return useMemo(
    () => createComposersService(hostApi, composerRef),
    [hostApi, composerRef],
  );
}

/**
 * Read and observe one exact Composer handle for a mounted plugin view.
 *
 * This is intentionally hook-local React lifecycle only: document ownership,
 * snapshot production, availability, transport, and subscription disposal
 * remain with the existing Composer handle and Host API beneath it.
 */
export function useComposerView(handle: ComposerHandle | null): ComposerViewStateV1 {
  const refreshCurrent = useRef<() => Promise<void>>(() => Promise.resolve());
  const refresh = useCallback(() => refreshCurrent.current(), []);
  const [state, setState] = useState<ComposerViewStateInternal>(() => emptyComposerViewState(handle));

  // A replacement must not render an old handle's document for even one
  // committed frame. React immediately re-renders after this local reset;
  // effect cleanup below retires its former read/watch afterwards.
  if (state.handle !== handle) {
    setState(emptyComposerViewState(handle));
  }

  useEffect(() => {
    if (handle === null) {
      const disabledRefresh = () => Promise.resolve();
      refreshCurrent.current = disabledRefresh;
      return () => {
        if (refreshCurrent.current === disabledRefresh) {
          refreshCurrent.current = () => Promise.resolve();
        }
      };
    }

    let effectActive = true;
    let beginSequence = 0;
    let retireActive: (() => Promise<void>) | null = null;

    const updateCurrent = (
      update: (previous: ComposerViewStateInternal) => ComposerViewStateInternal,
    ) => {
      setState((previous) => (
        previous.handle === handle ? update(previous) : previous
      ));
    };

    const begin = async (pending: Exclude<ComposerViewStateV1['pending'], null>): Promise<void> => {
      beginSequence += 1;
      const sequence = beginSequence;
      const previousRetirement = retireActive?.();
      retireActive = null;

      // Retiring aborts and fences the old generation synchronously. The
      // canonical handle still owns its disposer, but a rejecting or
      // never-settling cleanup cannot become admission authority for a newer
      // generation; sequence checks keep every late callback inert instead.
      if (previousRetirement) void previousRetirement.catch(() => undefined);

      updateCurrent((previous) => Object.freeze({
        handle,
        result: pending === 'initial' ? null : previous.result,
        error: pending === 'initial' ? null : previous.error,
        pending,
      }));

      if (!effectActive || sequence !== beginSequence) return;

      const abortController = new AbortController();
      let retired = false;
      let observation: Disposable | null = null;
      let observed: Promise<void> = Promise.resolve();
      let retirement: Promise<void> | null = null;
      let latestObservedSnapshot: ComposerSnapshotV1 | null = null;
      let observedAfterReadStarted = false;
      let readStarted = false;
      let observationError: PluginError | null = null;
      const isCurrent = () => effectActive && sequence === beginSequence && !retired;
      const retire = (): Promise<void> => {
        if (retirement) return retirement;
        retired = true;
        abortController.abort();
        const admittedObservation = observation;
        observation = null;
        retirement = Promise.resolve().then(async () => {
          await admittedObservation?.dispose();
          // If admission settles after abort, its branch below disposes that
          // late lease. This detached cleanup cannot delay replacement
          // admission because abort/currentness already retired this branch.
          await observed;
        });
        return retirement;
      };
      retireActive = retire;

      const options: ComposerRequestOptions = { signal: abortController.signal };
      try {
        // Invoke observe before read. A host may synchronously publish its
        // snapshot as it admits the watch, so registration cannot be deferred
        // behind the baseline round trip.
        observed = handle.observe((snapshot) => {
          latestObservedSnapshot = snapshot;
          if (readStarted) observedAfterReadStarted = true;
          observationError = null;
          if (!isCurrent()) return;
          updateCurrent((previous) => Object.freeze({
            ...previous,
            result: observedComposerResult(snapshot),
            error: null,
          }));
        }, options).then(
          async (nextObservation) => {
            if (!isCurrent()) {
              await nextObservation.dispose();
              return;
            }
            observation = nextObservation;
          },
          (error: unknown) => {
            if (!isCurrent()) return;
            observationError = asPluginError(error);
            updateCurrent((previous) => Object.freeze({
              ...previous,
              error: observationError,
            }));
          },
        );
      } catch (error) {
        observationError = asPluginError(error);
        observed = Promise.resolve().then(() => {
          if (!isCurrent()) return;
          updateCurrent((previous) => Object.freeze({
            ...previous,
            error: observationError,
          }));
        });
      }

      let baseline: Promise<void>;
      readStarted = true;
      try {
        baseline = handle.read(options).then(
          (result) => {
            if (!isCurrent()) return;
            const latestObservedRevision = latestObservedSnapshot?.revision;
            const useReadResult = result.status === 'unavailable'
              ? !observedAfterReadStarted
              : latestObservedRevision === undefined
                || result.snapshot.revision > latestObservedRevision
                || (
                  result.snapshot.revision === latestObservedRevision
                  && !observedAfterReadStarted
                );
            updateCurrent((previous) => Object.freeze({
              ...previous,
              // A post-admission observation rejects unavailable and
              // equal/lower baselines, while a higher semantic revision still
              // carries newer draft state. Before that point, the baseline
              // orders against the establishment snapshot normally.
              ...(useReadResult ? { result } : {}),
              // A successful read does not repair a failed observation from
              // this same generation. A later observed result or replacement
              // generation clears that independent host failure.
              error: observationError,
            }));
          },
          (error: unknown) => {
            if (!isCurrent()) return;
            updateCurrent((previous) => Object.freeze({
              ...previous,
              error: asPluginError(error),
            }));
          },
        );
      } catch (error) {
        baseline = Promise.resolve().then(() => {
          if (!isCurrent()) return;
          updateCurrent((previous) => Object.freeze({
            ...previous,
            error: asPluginError(error),
          }));
        });
      }

      try {
        await Promise.all([observed, baseline]);
      } catch (error) {
        if (isCurrent()) {
          updateCurrent((previous) => Object.freeze({
            ...previous,
            error: asPluginError(error),
          }));
        }
      } finally {
        if (isCurrent()) {
          updateCurrent((previous) => Object.freeze({ ...previous, pending: null }));
        }
      }
    };

    const refreshForHandle = () => begin('refresh');
    refreshCurrent.current = refreshForHandle;
    void begin('initial');

    return () => {
      effectActive = false;
      beginSequence += 1;
      const retirement = retireActive?.();
      if (retirement) void retirement.catch(() => undefined);
      if (refreshCurrent.current === refreshForHandle) {
        refreshCurrent.current = () => Promise.resolve();
      }
    };
  }, [handle]);

  const visibleState = state.handle === handle ? state : emptyComposerViewState(handle);
  return useMemo(() => Object.freeze({
    result: visibleState.result,
    error: visibleState.error,
    pending: visibleState.pending,
    refresh,
  }), [refresh, visibleState.error, visibleState.pending, visibleState.result]);
}
