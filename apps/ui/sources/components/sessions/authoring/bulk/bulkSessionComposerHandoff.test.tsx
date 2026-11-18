import { act } from 'react';
import { expect, it, onTestFinished } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { clearTempData } from '@/utils/sessions/tempDataStore';
import { storeBulkSessionComposerSeed, takeBulkSessionComposerSeed, useFrozenBulkSessionTargets } from './bulkSessionComposerHandoff';
import { useBulkSessionTargetSelection } from './useBulkSessionTargetSelection';

const first = { serverId: 'home-a', sessionId: 'same' };
const second = { serverId: 'home-b', sessionId: 'same' };

it('hands off an independent target snapshot once with the exact prefilled text', () => {
    onTestFinished(clearTempData);
    const targets = [{ ...first }, { ...second }];
    const id = storeBulkSessionComposerSeed({ targets, text: '  quoted text\n' });
    targets[0].sessionId = 'changed';
    targets.pop();
    expect(takeBulkSessionComposerSeed(id)).toEqual({ targets: [first, second], text: '  quoted text\n' });
    expect(takeBulkSessionComposerSeed(id)).toBeNull();
});

it('changes the frozen targets only through explicit To-list edits', async () => {
    let initialTargets = [first];
    const mounted = await renderHook(() => useFrozenBulkSessionTargets(initialTargets));
    onTestFinished(() => mounted.unmount());
    initialTargets = [second];
    await mounted.rerender();
    expect(mounted.getCurrent().targets).toEqual([first]);
    await act(async () => { mounted.getCurrent().editToTargets([first, second]); });
    expect(mounted.getCurrent().targets).toEqual([first, second]);
});

it('uses shared selection across filtering and composes both same-id Homes with the prefill', async () => {
    let visibleTargets = [first, second];
    const seeds: unknown[] = [];
    const mounted = await renderHook(() => useBulkSessionTargetSelection({ scopeKey: 'transcript',
        visibleTargets, eligibleTargets: [first, second], text: 'prefill', onCompose: seed => seeds.push(seed) }));
    onTestFinished(() => mounted.unmount());
    await act(async () => {
        mounted.getCurrent().enter();
        mounted.getCurrent().toggleTarget(first);
        mounted.getCurrent().toggleTarget(second);
    });
    visibleTargets = [second];
    await mounted.rerender();
    expect(mounted.getCurrent().snapshot.count).toBe(2);
    await act(async () => { mounted.getCurrent().compose(); });
    expect(seeds).toEqual([{ targets: [first, second], text: 'prefill' }]);
    await act(async () => { mounted.getCurrent().exit(); });
    expect(mounted.getCurrent().snapshot.isSelectionMode).toBe(false);
});
