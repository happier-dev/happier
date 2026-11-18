import { expect, it, onTestFinished } from 'vitest';
import { clearTempData } from '@/utils/sessions/tempDataStore';
import { listSessionSelectionBarDescriptors } from './bulkSessionComposerEntry';
import { takeBulkSessionComposerSeed } from './bulkSessionComposerHandoff';

it('places Compose beside existing mutations and navigates through a temp handoff', () => {
    onTestFinished(clearTempData);
    const navigations: string[] = [];
    const targets = [{ key: 'home:session', serverId: 'home', sessionId: 'session', active: true, canStop: true }];
    const seed = { targets: [{ serverId: 'home', sessionId: 'session' }] };
    const entries = listSessionSelectionBarDescriptors({ targets, tagsEnabled: false, moveEnabled: false,
        composeTitle: 'Compose', seed, onNavigate: dataId => navigations.push(dataId) });
    expect(entries[0]).toMatchObject({ kind: 'navigation', id: 'compose' });
    expect(entries).toContainEqual(expect.objectContaining({ id: 'ui.session.stop' }));
    const navigation = entries.find(entry => 'kind' in entry && entry.kind === 'navigation');
    if (navigation && 'kind' in navigation) navigation.onPress();
    expect(navigations).toHaveLength(1);
    expect(takeBulkSessionComposerSeed(navigations[0]!)).toEqual(seed);
});
