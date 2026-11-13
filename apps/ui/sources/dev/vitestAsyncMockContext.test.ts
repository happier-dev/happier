import { expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';

it('waits for initialized dependencies when a completed front door reenters a pending executor', async () => {
    const { executorLoading, releaseExecutor } = await import('./testkit/fixtures/vitestAsyncMockContext/pendingExecutorControl');
    const frontDoor = await import('./testkit/fixtures/vitestAsyncMockContext/pendingExecutorFrontDoor');
    const loading = import('./testkit/fixtures/vitestAsyncMockContext/pendingExecutor');
    await executorLoading;

    const execution = frontDoor.execute().then(
        value => ({ kind: 'ready' as const, value }),
        error => ({ kind: 'failed' as const, error }),
    );
    try {
        expect(await Promise.race([execution, setImmediate({ kind: 'pending' })])).toEqual({ kind: 'pending' });
    } finally {
        releaseExecutor();
        await loading;
    }
    expect(await execution).toEqual({ kind: 'ready', value: 'ready' });
});

it('resolves a three-module cycle entered concurrently through two modules', async () => {
    const [a, b] = await Promise.all([
        import('./testkit/fixtures/vitestAsyncMockContext/concurrentA'),
        import('./testkit/fixtures/vitestAsyncMockContext/concurrentB'),
    ]);
    expect([a.concurrentA, b.concurrentB]).toEqual(['a', 'b']);
});

it('waits for a shared asynchronous dependency when no cycle exists', async () => {
    const [a, b] = await Promise.all([
        import('./testkit/fixtures/vitestAsyncMockContext/sharedConsumerA'),
        import('./testkit/fixtures/vitestAsyncMockContext/sharedConsumerB'),
    ]);
    expect([a.readyA, b.readyB]).toEqual([true, true]);
});

// Guards the pinned Vitest patch with a real three-module import cycle.
vi.mock('./testkit/fixtures/vitestAsyncMockContext/nested', () => ({ value: 'nested mock' }));
vi.mock('./testkit/fixtures/vitestAsyncMockContext/entry', async (importOriginal) => {
    await import('./testkit/fixtures/vitestAsyncMockContext/nested');
    return importOriginal();
});

it('retains the original import ancestry after a nested asynchronous mock', async () => {
    const { readValue } = await import('./testkit/fixtures/vitestAsyncMockContext/consumer');
    expect(readValue()).toBe('original');
});

it('retains the original import ancestry for dynamically registered mocks', async () => {
    vi.resetModules();
    vi.doMock('./testkit/fixtures/vitestAsyncMockContext/nested', () => ({ value: 'new nested mock' }));
    vi.doMock('./testkit/fixtures/vitestAsyncMockContext/entry', async (importOriginal) => {
        await import('./testkit/fixtures/vitestAsyncMockContext/nested');
        return importOriginal();
    });
    const { readValue } = await import('./testkit/fixtures/vitestAsyncMockContext/consumer');
    expect(readValue()).toBe('original');
});
