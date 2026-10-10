import { describe, expect, it, vi } from 'vitest';

import type { ComposerReferenceRuntime, PluginInvocationContext } from '@happier-dev/plugin-sdk';

import { createTargetComposerReferenceRegistry } from './targetComposerReferences';

const REFERENCE = { pluginId: 'acme.issues', localId: 'issues' } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function fixture(
  overrides: Partial<ComposerReferenceRuntime> = {},
  options: Readonly<{
    triggers?: readonly ('@' | '$' | '/')[];
    registrationGeneration?: string;
  }> = {},
) {
  const retirement = new AbortController();
  let current = true;
  const completeInvocation = vi.fn();
  const runtime: ComposerReferenceRuntime = {
    search: vi.fn(async () => [{ id: 'issue:42', label: 'Issue 42' }]),
    resolve: vi.fn(async (candidateId) => ({
      id: candidateId,
      label: 'Issue 42',
      context: 'Current issue context.',
    })),
    ...overrides,
  };
  const entry = Object.freeze({
    pluginId: REFERENCE.pluginId,
    occurrenceId: options.registrationGeneration ?? '7',
    registration: Object.freeze({
      family: 'composerReferences' as const,
      localId: REFERENCE.localId,
      value: runtime,
    }),
  });
  const triggers: readonly ('@' | '$' | '/')[] = options.triggers ?? ['@'];
  const registry = createTargetComposerReferenceRegistry({
    targetRegistrations: [entry],
    resolveOccurrenceLifecycle: () => ({
      isCurrent: () => current,
      retirementSignal: retirement.signal,
    }),
    createInvocationContext: (input) => ({
      context: Object.freeze({
        plugin: Object.freeze({ id: input.reference.pluginId, version: '1.0.0' }),
        contribution: Object.freeze({
          id: input.reference.localId,
          qualifiedId: `${input.reference.pluginId}/composerReferences/${input.reference.localId}`,
        }),
        surface: 'cli',
        ...(input.sessionId ? { session: Object.freeze({ id: input.sessionId }) } : {}),
        signal: input.signal,
        services: Object.freeze({}),
        ui: Object.freeze({}),
      }) as unknown as PluginInvocationContext,
      complete: completeInvocation,
    }),
    // The public declaration is deliberately supplied through the canonical
    // target registry rather than trusted from a picker request.
    composerReferences: [{
      provenance: 'external',
      source: { kind: 'path' },
      pluginId: REFERENCE.pluginId,
      pluginVersion: '1.0.0',
      identity: REFERENCE,
      manifestPath: '/fixtures/acme.issues/.happier-plugin/plugin.json',
      definition: {
        id: REFERENCE.localId,
        title: 'Issues',
        description: 'Search issues',
        icon: 'search',
        triggers: [...triggers],
      },
    }],
  });
  return {
    registry,
    runtime,
    retirement,
    completeInvocation,
    retire: () => { current = false; retirement.abort(new Error('retired')); },
  };
}

describe('target composer reference registry', () => {
  it('keeps a retained registration usable through its own active lifecycle', async () => {
    const subject = fixture({}, {
      registrationGeneration: '7',
    });

    expect(subject.registry.list()).toEqual([REFERENCE]);
    await expect(subject.registry.search({
      reference: REFERENCE,
      query: 'issue',
      trigger: '@',
      signal: new AbortController().signal,
    })).resolves.toEqual([{ id: 'issue:42', label: 'Issue 42' }]);
  });

  it('invokes a reference only through one of its manifest-declared triggers', async () => {
    const subject = fixture({}, { triggers: ['$'] });
    const signal = new AbortController().signal;
    const dollarSearch = {
      reference: REFERENCE,
      query: 'issue',
      trigger: '$' as const,
      signal,
    };
    const atSearch = { ...dollarSearch, trigger: '@' as const };

    await expect(subject.registry.search(dollarSearch)).resolves.toEqual([
      { id: 'issue:42', label: 'Issue 42' },
    ]);
    await expect(subject.registry.search(atSearch)).rejects.toMatchObject({
      code: 'composer_reference_unavailable',
    });
    expect(subject.runtime.search).toHaveBeenCalledTimes(1);
  });

  it('invokes only the exact qualified current reference, normalizes the query, and validates its page', async () => {
    const subject = fixture();
    const signal = new AbortController();

    await expect(subject.registry.search({ reference: REFERENCE, query: 'e\u0301', trigger: '@', signal: signal.signal }))
      .resolves.toEqual([{ id: 'issue:42', label: 'Issue 42' }]);
    expect(subject.runtime.search).toHaveBeenCalledWith('é', expect.objectContaining({
      plugin: { id: REFERENCE.pluginId, version: '1.0.0' },
      contribution: {
        id: REFERENCE.localId,
        qualifiedId: `${REFERENCE.pluginId}/composerReferences/${REFERENCE.localId}`,
      },
      surface: 'cli',
      signal: expect.any(AbortSignal),
    }));
    expect(subject.completeInvocation).toHaveBeenCalledTimes(1);
    await expect(subject.registry.search({
      reference: { pluginId: REFERENCE.pluginId, localId: 'other' },
      query: 'issue',
      trigger: '@',
      signal: signal.signal,
    })).rejects.toMatchObject({ code: 'composer_reference_unavailable' });
    expect(subject.runtime.search).toHaveBeenCalledTimes(1);
  });

  it('rejects a result that arrives after caller cancellation instead of attaching it to the replacement query', async () => {
    const pending = deferred<Array<{ id: string; label: string }>>();
    const subject = fixture({
      search: vi.fn<ComposerReferenceRuntime['search']>(async () => await pending.promise),
    });
    const controller = new AbortController();

    const search = subject.registry.search({ reference: REFERENCE, query: 'issue', trigger: '@', signal: controller.signal });
    await vi.waitFor(() => expect(subject.runtime.search).toHaveBeenCalledTimes(1));
    controller.abort(new Error('query replaced'));
    pending.resolve([{ id: 'issue:42', label: 'Issue 42' }]);

    await expect(search).rejects.toMatchObject({ code: 'composer_reference_not_current' });
  });

  it('rejects stale and wrong-candidate resolve results while aborting the reference callback', async () => {
    const pending = deferred<{ id: string; label: string; context: string }>();
    let observedSignal: AbortSignal | undefined;
    const subject = fixture({
      resolve: vi.fn(async (_candidateId, context) => {
        observedSignal = context.signal;
        return await pending.promise;
      }),
    });
    const resolve = subject.registry.resolve({
      reference: REFERENCE,
      candidateId: 'issue:42',
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(subject.runtime.resolve).toHaveBeenCalledTimes(1));
    subject.retire();
    pending.resolve({ id: 'issue:42', label: 'Issue 42', context: 'stale' });

    await expect(resolve).rejects.toMatchObject({ code: 'plugin_generation_stale' });
    expect(observedSignal?.aborted).toBe(true);

    const mismatch = fixture({
      resolve: vi.fn(async () => ({ id: 'issue:other', label: 'Other issue', context: 'wrong identity' })),
    });
    await expect(mismatch.registry.resolve({
      reference: REFERENCE,
      candidateId: 'issue:42',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'composer_reference_candidate_mismatch' });
  });

  it('accepts a current reference result after the former callback cutoff', async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const pending = deferred<Array<{ id: string; label: string }>>();
      const subject = fixture({
        search: vi.fn<ComposerReferenceRuntime['search']>(async (_query, context) => {
          observedSignal = context.signal;
          return await pending.promise;
        }),
      });

      const search = subject.registry.search({
        reference: REFERENCE,
        query: 'issue',
        trigger: '@',
        signal: new AbortController().signal,
      });
      expect(subject.runtime.search).toHaveBeenCalledTimes(1);
      const outcome = search.then((value) => ({ value }), (error: unknown) => ({ error }));

      await vi.advanceTimersByTimeAsync(5_001);
      pending.resolve([{ id: 'issue:42', label: 'Issue 42' }]);

      await expect(outcome).resolves.toEqual({ value: [{ id: 'issue:42', label: 'Issue 42' }] });
      expect(observedSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a real reference callback error', async () => {
    const failure = new Error('reference lookup failed');
    const subject = fixture({ search: async () => { throw failure; } });
    await expect(subject.registry.search({ reference: REFERENCE, query: 'issue', trigger: '@', signal: new AbortController().signal }))
      .rejects.toBe(failure);
  });

  it('retires only a cancelled query while another query on the same occurrence completes', async () => {
    const previous = deferred<Array<{ id: string; label: string }>>();
    const current = deferred<Array<{ id: string; label: string }>>();
    const subject = fixture({ search: async (query) => await (query === 'previous' ? previous : current).promise });
    const cancellation = new AbortController();
    const first = subject.registry.search({ reference: REFERENCE, query: 'previous', trigger: '@', signal: cancellation.signal });
    const rejected = expect(first).rejects.toMatchObject({ code: 'composer_reference_not_current' });
    const next = subject.registry.search({ reference: REFERENCE, query: 'current', trigger: '@', signal: new AbortController().signal });
    cancellation.abort();
    previous.resolve([{ id: 'old', label: 'Old' }]);
    current.resolve([{ id: 'new', label: 'New' }]);
    await rejected;
    await expect(next).resolves.toEqual([{ id: 'new', label: 'New' }]);
  });
});
