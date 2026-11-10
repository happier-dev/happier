import { expect, it } from 'vitest';
import { invokeBoundedExternalSessionsOperation } from './agentExternalSessionsInvocation';

it.each([false, true])('awaits finite native lease retirement after the callback settles (failure: %s)', async fail => {
    const events: string[] = [];
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let cleanupStarted!: () => void;
    const started = new Promise<void>(resolve => { cleanupStarted = resolve; });
    let returned = false;
    const pending = invokeBoundedExternalSessionsOperation({
        signal: new AbortController().signal,
        retirementSignal: new AbortController().signal,
        isCurrent: () => true,
        async operation(_signal, _deadline, retainCleanup) {
            retainCleanup({ async dispose() {
                events.push('cleanup');
                cleanupStarted();
                await cleanup;
                events.push('retired');
            } });
            events.push('native-settled');
            if (fail) throw new Error('Native read failed');
            return 'history';
        },
    }).then(result => { returned = true; return result; });
    // A missing cleanup must fail deterministically instead of timing out.
    await Promise.race([started, pending]);
    expect(events).toEqual(['native-settled', 'cleanup']);
    expect(returned).toBe(false);
    releaseCleanup();
    expect(await pending).toMatchObject(fail ? { status: 'rejected' } : { status: 'fulfilled', value: 'history' });
    expect(events).toEqual(['native-settled', 'cleanup', 'retired']);
});

it('retires every retained finite lease when one retirement fails', async () => {
    const retired: string[] = [];
    const result = await invokeBoundedExternalSessionsOperation({
        signal: new AbortController().signal, retirementSignal: new AbortController().signal,
        isCurrent: () => true,
        operation(_signal, _deadline, retainCleanup) {
            retainCleanup({ async dispose() { retired.push('first'); } });
            retainCleanup({ async dispose() { retired.push('second'); throw new Error('Native retirement failed'); } });
            return 'history';
        },
    });
    expect(retired).toEqual(['second', 'first']);
    expect(result).toMatchObject({ status: 'rejected' });
});
