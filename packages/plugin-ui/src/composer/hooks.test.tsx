import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import * as pluginUi from '../hostApi/index.js';
import { PluginHostApiProviderInternal } from '../hostApi/context.js';
import type { ComposerHandle } from './service.js';

type ComposerReadResult = Awaited<ReturnType<PluginUiHostApi['readComposer']>>;
type ComposerSnapshot = Extract<ComposerReadResult, Readonly<{ status: 'ready' }>>['snapshot'];

type ComposerViewState = Readonly<{
  result: ComposerReadResult | null;
  error: PluginError | null;
  pending: 'initial' | 'refresh' | null;
  refresh(): Promise<void>;
}>;

type UseComposerView = (handle: ComposerHandle | null) => ComposerViewState;

function deferred<T>() {
  let accept: (value: T) => void = () => {
    throw new Error('Deferred promise resolved before initialization.');
  };
  let reject: (error: unknown) => void = () => {
    throw new Error('Deferred promise rejected before initialization.');
  };
  const promise = new Promise<T>((resolve, rejectPromise) => {
    accept = resolve;
    reject = rejectPromise;
  });
  return Object.freeze({
    promise,
    resolve: accept,
    reject,
  });
}

function createSnapshot(
  ref: Parameters<PluginUiHostApi['readComposer']>[0],
  revision: number,
  text: string,
): ComposerSnapshot {
  return Object.freeze({
    revision,
    ref,
    text,
    references: Object.freeze([]),
    attachments: Object.freeze([]),
    layout: 'wrap' as const,
    capabilities: Object.freeze({ text: true, references: true, attachments: true, submit: true }),
    state: Object.freeze({ focused: true, editable: true, submittable: true, submitting: false, running: false }),
  });
}

function createHandle(input: Readonly<{
  ref: Parameters<PluginUiHostApi['readComposer']>[0];
  read: ComposerHandle['read'];
  observe: ComposerHandle['observe'];
}>): ComposerHandle {
  return Object.freeze({
    ref: input.ref,
    read: input.read,
    observe: input.observe,
    apply: async () => { throw new Error('Not used by Composer view tests.'); },
    focus: async () => { throw new Error('Not used by Composer view tests.'); },
    setDecorations: async () => { throw new Error('Not used by Composer view tests.'); },
    acquireInputLock: async () => { throw new Error('Not used by Composer view tests.'); },
  } satisfies ComposerHandle);
}

function ComposerViewProbe(props: Readonly<{
  handle: ComposerHandle | null;
  onState(state: ComposerViewState): void;
}>) {
  // This public-boundary lookup makes the initial RED fail for the intended
  // reason: the author import is absent, rather than a test-only source path.
  const candidate = Reflect.get(pluginUi, 'useComposerView');
  if (typeof candidate !== 'function') {
    throw new Error('@happier-dev/plugin-ui must export useComposerView.');
  }
  props.onState((candidate as UseComposerView)(props.handle));
  return null;
}

function MountedComposerViewProbe(props: Readonly<{
  onState(state: ComposerViewState): void;
}>) {
  const useComposerCandidate = Reflect.get(pluginUi, 'useComposer');
  const useComposerViewCandidate = Reflect.get(pluginUi, 'useComposerView');
  if (typeof useComposerCandidate !== 'function' || typeof useComposerViewCandidate !== 'function') {
    throw new Error('@happier-dev/plugin-ui must export the Composer hooks.');
  }
  const service = (useComposerCandidate as () => Readonly<{
    current(): ComposerHandle | null;
  }>)();
  props.onState((useComposerViewCandidate as UseComposerView)(service.current()));
  return null;
}

describe('useComposerView', () => {
  it('reports the initial pending state on the first non-null render', async () => {
    const ref = { kind: 'session', sessionId: 'session-initial' } as const;
    const baseline = deferred<ComposerReadResult>();
    const observation = deferred<Disposable>();
    const handle = createHandle({
      ref,
      observe: async () => await observation.promise,
      read: async () => await baseline.promise,
    });
    const states: ComposerViewState[] = [];
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(
        <ComposerViewProbe handle={handle} onState={(next) => { states.push(next); }} />,
      );
      await Promise.resolve();
    });

    expect(states[0]?.pending).toBe('initial');

    await act(async () => {
      tree!.unmount();
      baseline.resolve(Object.freeze({ status: 'unavailable' as const, reason: 'scopeClosed' as const }));
      observation.resolve({ dispose: vi.fn() });
      await Promise.resolve();
    });
  });

  it('keeps an observation delivered after read admission over an older unavailable baseline', async () => {
    const ref = { kind: 'session', sessionId: 'session-post-read-observation' } as const;
    const observedSnapshot = createSnapshot(ref, 4, 'newer observed state');
    const unavailable = Object.freeze({ status: 'unavailable' as const, reason: 'scopeClosed' as const });
    const baseline = deferred<ComposerReadResult>();
    const calls: string[] = [];
    let listener: ((snapshot: ComposerSnapshot) => void) | undefined;
    const handle = createHandle({
      ref,
      observe: async (nextListener) => {
        calls.push('observe');
        listener = nextListener;
        return { dispose: vi.fn() };
      },
      read: async () => {
        calls.push('read');
        return await baseline.promise;
      },
    });
    let view: ComposerViewState | undefined;
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<ComposerViewProbe handle={handle} onState={(next) => { view = next; }} />);
      await Promise.resolve();
    });
    expect(calls).toEqual(['observe', 'read']);

    await act(async () => {
      listener?.(observedSnapshot);
      await Promise.resolve();
    });
    expect((view?.result as Extract<ComposerReadResult, { status: 'ready' }> | undefined)?.snapshot)
      .toBe(observedSnapshot);

    await act(async () => {
      baseline.resolve(unavailable);
      await Promise.resolve();
    });

    expect(view?.pending).toBeNull();
    expect((view?.result as Extract<ComposerReadResult, { status: 'ready' }> | undefined)?.snapshot)
      .toBe(observedSnapshot);

    await act(async () => {
      tree!.unmount();
      await Promise.resolve();
    });
  });

  it.each([
    ['higher', 5, true],
    ['equal', 4, false],
    ['lower', 3, false],
  ] as const)('reconciles a %s ready baseline after a post-read observation', async (
    _comparison,
    baselineRevision,
    baselineWins,
  ) => {
    const ref = { kind: 'session', sessionId: `session-post-read-ready-${baselineRevision}` } as const;
    const observedSnapshot = createSnapshot(ref, 4, 'observed after read admission');
    const baselineResult = Object.freeze({
      status: 'ready' as const,
      snapshot: createSnapshot(ref, baselineRevision, `baseline revision ${baselineRevision}`),
    });
    const baseline = deferred<ComposerReadResult>();
    const calls: string[] = [];
    let listener: ((snapshot: ComposerSnapshot) => void) | undefined;
    const handle = createHandle({
      ref,
      observe: async (nextListener) => {
        calls.push('observe');
        listener = nextListener;
        return { dispose: vi.fn() };
      },
      read: async () => {
        calls.push('read');
        return await baseline.promise;
      },
    });
    let view: ComposerViewState | undefined;
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<ComposerViewProbe handle={handle} onState={(next) => { view = next; }} />);
      await Promise.resolve();
    });
    expect(calls).toEqual(['observe', 'read']);

    await act(async () => {
      listener?.(observedSnapshot);
      await Promise.resolve();
    });

    await act(async () => {
      baseline.resolve(baselineResult);
      await Promise.resolve();
    });

    expect(view?.pending).toBeNull();
    expect((view?.result as Extract<ComposerReadResult, { status: 'ready' }> | undefined)?.snapshot)
      .toBe(baselineWins ? baselineResult.snapshot : observedSnapshot);

    await act(async () => {
      tree!.unmount();
      await Promise.resolve();
    });
  });

  it('admits an observation before the baseline read and does not overwrite its newer snapshot', async () => {
    const ref = { kind: 'session', sessionId: 'session-1' } as const;
    const observedSnapshot = createSnapshot(ref, 2, 'live');
    const staleReadResult = Object.freeze({
      status: 'ready' as const,
      snapshot: createSnapshot(ref, 1, 'stale'),
    });
    const baseline = deferred<ComposerReadResult>();
    const calls: string[] = [];
    const observation: Disposable = { dispose: vi.fn() };
    const handle = createHandle({
      ref,
      observe: async (listener) => {
        calls.push('observe');
        listener(observedSnapshot);
        return observation;
      },
      read: async () => {
        calls.push('read');
        return await baseline.promise;
      },
    });
    let view: ComposerViewState | undefined;

    await act(async () => {
      renderer.create(<ComposerViewProbe handle={handle} onState={(next) => { view = next; }} />);
      await Promise.resolve();
    });

    expect(calls).toEqual(['observe', 'read']);
    expect(view?.pending).toBe('initial');
    expect(view?.result).toMatchObject({ status: 'ready', snapshot: observedSnapshot });
    expect((view?.result as Extract<ComposerReadResult, { status: 'ready' }> | undefined)?.snapshot)
      .toBe(observedSnapshot);

    await act(async () => {
      baseline.resolve(staleReadResult);
      await Promise.resolve();
    });

    expect(view?.pending).toBeNull();
    expect((view?.result as Extract<ComposerReadResult, { status: 'ready' }> | undefined)?.snapshot)
      .toBe(observedSnapshot);
  });

  it('accepts a newer baseline read over an earlier establishment snapshot', async () => {
    const ref = { kind: 'session', sessionId: 'session-current-read' } as const;
    const observedSnapshot = createSnapshot(ref, 1, 'establishment snapshot');
    const currentRead = Object.freeze({
      status: 'ready' as const,
      snapshot: createSnapshot(ref, 2, 'current read'),
    });
    const handle = createHandle({
      ref,
      observe: async (listener) => {
        listener(observedSnapshot);
        return { dispose: vi.fn() };
      },
      read: async () => currentRead,
    });
    let view: ComposerViewState | undefined;

    await act(async () => {
      renderer.create(<ComposerViewProbe handle={handle} onState={(next) => { view = next; }} />);
      await Promise.resolve();
    });

    expect(view?.result).toBe(currentRead);
  });

  it('keeps canonical unavailable in result while reporting host failures as PluginError', async () => {
    const ref = { kind: 'session', sessionId: 'session-1' } as const;
    const unavailable = Object.freeze({ status: 'unavailable' as const, reason: 'scopeClosed' as const });
    const observedSnapshot = createSnapshot(ref, 3, 'observed before unavailable');
    const observe: ComposerHandle['observe'] = async (listener) => {
      listener(observedSnapshot);
      return { dispose: vi.fn() };
    };
    const unavailableHandle = createHandle({
      ref,
      observe,
      read: async () => unavailable,
    });
    const hostFailure = new PluginError({ code: 'ui_host_unavailable', message: 'Host disconnected.' });
    const failedHandle = createHandle({
      ref: { kind: 'session', sessionId: 'session-2' },
      observe: async () => ({ dispose: vi.fn() }),
      read: async () => { throw hostFailure; },
    });
    let view: ComposerViewState | undefined;
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<ComposerViewProbe handle={unavailableHandle} onState={(next) => { view = next; }} />);
      await Promise.resolve();
    });

    expect(view?.result).toBe(unavailable);
    expect(view?.error).toBeNull();
    expect(view?.pending).toBeNull();

    await act(async () => {
      tree!.update(<ComposerViewProbe handle={failedHandle} onState={(next) => { view = next; }} />);
      await Promise.resolve();
    });

    expect(view?.result).toBeNull();
    expect(view?.error).toBe(hostFailure);
    expect(view?.pending).toBeNull();
  });

  it('does not let a successful baseline erase an observation-establishment failure', async () => {
    const ref = { kind: 'session', sessionId: 'session-watch-failure' } as const;
    const result = Object.freeze({
      status: 'ready' as const,
      snapshot: createSnapshot(ref, 1, 'read remains available'),
    });
    const watchFailure = new PluginError({
      code: 'watch_unavailable',
      message: 'Observation could not be established.',
      retryable: true,
    });
    const handle = createHandle({
      ref,
      observe: async () => { throw watchFailure; },
      read: async () => {
        await Promise.resolve();
        return result;
      },
    });
    let view: ComposerViewState | undefined;

    await act(async () => {
      renderer.create(<ComposerViewProbe handle={handle} onState={(next) => { view = next; }} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view?.result).toBe(result);
    expect(view?.error).toBe(watchFailure);
    expect(view?.pending).toBeNull();
  });

  it('retains last-known-good data through refresh failure and clears the error on a later result', async () => {
    const ref = { kind: 'session', sessionId: 'session-1' } as const;
    const first = Object.freeze({ status: 'ready' as const, snapshot: createSnapshot(ref, 1, 'first') });
    const second = deferred<ComposerReadResult>();
    const third = deferred<ComposerReadResult>();
    const refreshed = Object.freeze({ status: 'ready' as const, snapshot: createSnapshot(ref, 2, 'refreshed') });
    const hostFailure = new PluginError({ code: 'network', message: 'Host offline.', retryable: true });
    const disposables: Disposable[] = [
      { dispose: vi.fn() },
      { dispose: vi.fn() },
      { dispose: vi.fn() },
    ];
    let reads = 0;
    let observations = 0;
    const handle = createHandle({
      ref,
      observe: async () => disposables[observations++]!,
      read: async () => {
        reads += 1;
        if (reads === 1) return first;
        if (reads === 2) return await second.promise;
        return await third.promise;
      },
    });
    let view: ComposerViewState | undefined;

    await act(async () => {
      renderer.create(<ComposerViewProbe handle={handle} onState={(next) => { view = next; }} />);
      await Promise.resolve();
    });
    expect(view?.result).toBe(first);

    let failedRefresh: Promise<void> | undefined;
    await act(async () => {
      failedRefresh = view!.refresh();
      await Promise.resolve();
    });
    expect(view?.result).toBe(first);
    expect(view?.pending).toBe('refresh');
    expect(disposables[0]!.dispose).toHaveBeenCalledOnce();

    await act(async () => {
      second.reject(hostFailure);
      await failedRefresh;
    });
    expect(view?.result).toBe(first);
    expect(view?.error).toBe(hostFailure);
    expect(view?.pending).toBeNull();

    let successfulRefresh: Promise<void> | undefined;
    await act(async () => {
      successfulRefresh = view!.refresh();
      await Promise.resolve();
    });
    expect(view?.result).toBe(first);
    expect(view?.pending).toBe('refresh');
    expect(disposables[1]!.dispose).toHaveBeenCalledOnce();

    await act(async () => {
      third.resolve(refreshed);
      await successfulRefresh;
    });
    expect(view?.result).toBe(refreshed);
    expect(view?.error).toBeNull();
    expect(view?.pending).toBeNull();
    expect(observations).toBe(3);
  });

  it('retires a replaced handle and leaves its late read, observation, and admission inert', async () => {
    const firstRef = { kind: 'session', sessionId: 'session-first' } as const;
    const secondRef = { kind: 'session', sessionId: 'session-second' } as const;
    const oldRead = deferred<ComposerReadResult>();
    const oldObserve = deferred<Disposable>();
    let oldListener: ((snapshot: ComposerSnapshot) => void) | undefined;
    const oldDisposable: Disposable = { dispose: vi.fn() };
    const first = createHandle({
      ref: firstRef,
      observe: async (listener) => {
        oldListener = listener;
        return await oldObserve.promise;
      },
      read: async () => await oldRead.promise,
    });
    const secondResult = Object.freeze({ status: 'ready' as const, snapshot: createSnapshot(secondRef, 2, 'second') });
    const second = createHandle({
      ref: secondRef,
      observe: async () => ({ dispose: vi.fn() }),
      read: async () => secondResult,
    });
    let view: ComposerViewState | undefined;
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<ComposerViewProbe handle={first} onState={(next) => { view = next; }} />);
      await Promise.resolve();
    });
    expect(oldListener).toBeTypeOf('function');

    await act(async () => {
      tree!.update(<ComposerViewProbe handle={second} onState={(next) => { view = next; }} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view?.result).toBe(secondResult);
    expect(view?.pending).toBeNull();

    await act(async () => {
      oldListener?.(createSnapshot(firstRef, 9, 'late observation'));
      oldRead.resolve(Object.freeze({ status: 'ready' as const, snapshot: createSnapshot(firstRef, 8, 'late read') }));
      oldObserve.resolve(oldDisposable);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view?.result).toBe(secondResult);
    expect(oldDisposable.dispose).toHaveBeenCalledOnce();
  });

  it('does not resubscribe for a stable handle and makes late unmount work inert', async () => {
    const ref = { kind: 'session', sessionId: 'session-1' } as const;
    let observations = 0;
    let reads = 0;
    const lateObservation = deferred<Disposable>();
    let listener: ((snapshot: ComposerSnapshot) => void) | undefined;
    let observationSignal: AbortSignal | undefined;
    const lateDisposable: Disposable = { dispose: vi.fn() };
    const handle = createHandle({
      ref,
      observe: async (nextListener, options) => {
        observations += 1;
        listener = nextListener;
        observationSignal = options?.signal;
        return await lateObservation.promise;
      },
      read: async () => {
        reads += 1;
        return Object.freeze({ status: 'ready' as const, snapshot: createSnapshot(ref, 1, 'initial') });
      },
    });
    const states: ComposerViewState[] = [];
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<ComposerViewProbe handle={handle} onState={(next) => { states.push(next); }} />);
      await Promise.resolve();
    });
    await act(async () => {
      tree!.update(<ComposerViewProbe handle={handle} onState={(next) => { states.push(next); }} />);
      await Promise.resolve();
    });
    expect(observations).toBe(1);
    expect(reads).toBe(1);

    await act(async () => {
      tree!.unmount();
      listener?.(createSnapshot(ref, 2, 'late'));
      lateObservation.resolve(lateDisposable);
      await Promise.resolve();
    });
    expect(observationSignal?.aborted).toBe(true);
    expect(lateDisposable.dispose).toHaveBeenCalledOnce();
  });

  it('keeps the mounted current handle stable through the public hook composition', async () => {
    const ref = { kind: 'session', sessionId: 'session-mounted-stable' } as const;
    const result = Object.freeze({
      status: 'ready' as const,
      snapshot: createSnapshot(ref, 1, 'mounted'),
    });
    const readComposer = vi.fn(async () => result);
    const watchComposer = vi.fn(async () => ({ dispose: vi.fn() }));
    const hostApi = {
      version: () => ({ methods: ['readComposer', 'watchComposer'] }),
      readResource: vi.fn(async () => { throw new Error('Not used by Composer view tests.'); }),
      readComposer,
      watchComposer,
    } as unknown as PluginUiHostApi;
    let view: ComposerViewState | undefined;
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(
        <PluginHostApiProviderInternal hostApi={hostApi} composerRef={ref}>
          <MountedComposerViewProbe onState={(next) => { view = next; }} />
        </PluginHostApiProviderInternal>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view?.result).toBe(result);
    expect(readComposer).toHaveBeenCalledOnce();
    expect(watchComposer).toHaveBeenCalledOnce();

    await act(async () => {
      tree!.update(
        <PluginHostApiProviderInternal hostApi={hostApi} composerRef={ref}>
          <MountedComposerViewProbe onState={(next) => { view = next; }} />
        </PluginHostApiProviderInternal>,
      );
      await Promise.resolve();
    });
    expect(readComposer).toHaveBeenCalledOnce();
    expect(watchComposer).toHaveBeenCalledOnce();
  });

  it('retires an old generation before immediately admitting its refresh or replacement', async () => {
    const firstRef = { kind: 'session', sessionId: 'session-serialized-first' } as const;
    const secondRef = { kind: 'session', sessionId: 'session-serialized-second' } as const;
    const refreshRetirement = deferred<void>();
    const replacementRetirement = deferred<void>();
    const firstDisposals = [
      vi.fn(async () => await refreshRetirement.promise),
      vi.fn(async () => await replacementRetirement.promise),
    ];
    let firstObservations = 0;
    let secondObservations = 0;
    const first = createHandle({
      ref: firstRef,
      observe: async () => ({ dispose: firstDisposals[firstObservations++]! }),
      read: async () => Object.freeze({
        status: 'ready' as const,
        snapshot: createSnapshot(firstRef, firstObservations, 'first'),
      }),
    });
    const second = createHandle({
      ref: secondRef,
      observe: async () => {
        secondObservations += 1;
        return { dispose: vi.fn() };
      },
      read: async () => Object.freeze({
        status: 'ready' as const,
        snapshot: createSnapshot(secondRef, 1, 'second'),
      }),
    });
    let view: ComposerViewState | undefined;
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<ComposerViewProbe handle={first} onState={(next) => { view = next; }} />);
      await Promise.resolve();
    });
    expect(firstObservations).toBe(1);

    let refresh: Promise<void> | undefined;
    await act(async () => {
      refresh = view!.refresh();
      await Promise.resolve();
    });
    expect(firstDisposals[0]).toHaveBeenCalledOnce();
    expect(firstObservations).toBe(2);

    await act(async () => {
      await refresh;
    });
    expect(firstObservations).toBe(2);

    await act(async () => {
      tree!.update(<ComposerViewProbe handle={second} onState={(next) => { view = next; }} />);
      await Promise.resolve();
    });
    expect(firstDisposals[1]).toHaveBeenCalledOnce();
    expect(secondObservations).toBe(1);

    await act(async () => {
      refreshRetirement.resolve();
      replacementRetirement.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(secondObservations).toBe(1);
  });

  it('keeps a replacement generation live when its retired observation disposer rejects', async () => {
    const ref = { kind: 'session', sessionId: 'session-disposal-recovery' } as const;
    const disposalFailure = new Error('observation disposal failed');
    let observations = 0;
    const listeners: Array<(snapshot: ComposerSnapshot) => void> = [];
    const replacement = Object.freeze({
      status: 'ready' as const,
      snapshot: createSnapshot(ref, 2, 'replacement'),
    });
    const handle = createHandle({
      ref,
      observe: async (listener) => {
        observations += 1;
        listeners.push(listener);
        return observations === 1
          ? { dispose: vi.fn(async () => { throw disposalFailure; }) }
          : { dispose: vi.fn() };
      },
      read: async () => (
        observations === 1
          ? Object.freeze({
            status: 'ready' as const,
            snapshot: createSnapshot(ref, 1, 'initial'),
          })
          : replacement
      ),
    });
    let view: ComposerViewState | undefined;

    await act(async () => {
      renderer.create(<ComposerViewProbe handle={handle} onState={(next) => { view = next; }} />);
      await Promise.resolve();
    });
    expect(observations).toBe(1);

    await act(async () => {
      await view!.refresh();
    });
    expect(observations).toBe(2);
    expect(view?.result).toBe(replacement);
    expect(view?.error).toBeNull();

    await act(async () => {
      listeners[0]?.(createSnapshot(ref, 99, 'late retired observation'));
      await Promise.resolve();
    });
    expect(view?.result).toBe(replacement);
    expect(view?.error).toBeNull();

  });

  it('does not let a never-settling retired observation disposer block a later generation', async () => {
    const ref = { kind: 'session', sessionId: 'session-disposal-never-settles' } as const;
    const neverSettles = deferred<void>();
    const firstDispose = vi.fn(async () => await neverSettles.promise);
    const listeners: Array<(snapshot: ComposerSnapshot) => void> = [];
    const replacement = Object.freeze({
      status: 'ready' as const,
      snapshot: createSnapshot(ref, 2, 'replacement after retired disposer'),
    });
    let observations = 0;
    const handle = createHandle({
      ref,
      observe: async (listener) => {
        observations += 1;
        listeners.push(listener);
        return observations === 1
          ? { dispose: firstDispose }
          : { dispose: vi.fn() };
      },
      read: async () => (
        observations === 1
          ? Object.freeze({
            status: 'ready' as const,
            snapshot: createSnapshot(ref, 1, 'initial'),
          })
          : replacement
      ),
    });
    let view: ComposerViewState | undefined;

    await act(async () => {
      renderer.create(<ComposerViewProbe handle={handle} onState={(next) => { view = next; }} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(observations).toBe(1);

    await act(async () => {
      const refresh = view!.refresh();
      void refresh.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(observations).toBe(2);
    expect(view?.result).toBe(replacement);
    expect(view?.error).toBeNull();

    await act(async () => {
      listeners[0]?.(createSnapshot(ref, 99, 'late retired observation'));
      await Promise.resolve();
    });
    expect(view?.result).toBe(replacement);
    expect(view?.error).toBeNull();

    await act(async () => {
      neverSettles.resolve();
      await Promise.resolve();
    });
  });

  it('is disabled for a null handle without issuing reads or observations', async () => {
    let view: ComposerViewState | undefined;

    await act(async () => {
      renderer.create(<ComposerViewProbe handle={null} onState={(next) => { view = next; }} />);
      await Promise.resolve();
    });

    expect(view).toMatchObject({ result: null, error: null, pending: null });
    await expect(view!.refresh()).resolves.toBeUndefined();
  });
});
