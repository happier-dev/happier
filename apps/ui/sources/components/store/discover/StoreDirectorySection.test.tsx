import * as React from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import { createSeededSkillsHome } from '@/dev/testkit/harness/skillsSurfaceHarness';
import type { StoreDiscoverItem } from './storeDiscoverModel';

installPromptRegistriesCommonModuleMocks({ storage: original => original() });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { StoreDirectory } = await import('./StoreDirectorySection');
const { useSkillAdded } = await import('../catalog/storeAdded');

it('uses native membership for Discover Added controls and leaves contribution-only Agents without Add', async () => {
    const reference = { type: 'registryItem', kind: 'skill', sourceId: 'test:skills', itemId: 'review', version: '1' } as const;
    const home = await createSeededSkillsHome('https://store-discover-membership.test', { skills: [{ id: 'held-review', header: {
        skillLock: { provenance: { kind: 'registry', registry: { sourceId: reference.sourceId, itemId: reference.itemId,
            format: 'skills-sh', sourceUrl: 'https://skills.sh', importedAt: 1,
            ref: { kind: 'gitTree', repo: 'https://example.com/skills.git', commit: 'pinned', treeSha: 'tree', path: 'review' } } }, updatePolicy: 'manual' },
    } }] });
    onTestFinished(async () => { await standardCleanup(); await home.dispose(); });
    const skill: StoreDiscoverItem = { id: 'review', key: JSON.stringify(reference), sourceId: 'curated', reference,
        kind: 'skill', title: 'Review', description: 'Review changes' };
    const agent: StoreDiscoverItem = { id: 'agent', key: 'agent', sourceId: 'curated',
        reference: { type: 'agentContribution', targetKey: 'codex' }, kind: 'agent', title: 'Agent', description: 'Built in' };
    let nativeAdded = false;
    function NativeMembership() {
        const added = useSkillAdded(true);
        nativeAdded = added({ ...reference, title: 'Review' });
        return null;
    }
    const screen = await renderScreen(<><NativeMembership /><StoreDirectory testID="discover.membership" accessibilityLabel="Discover"
        sections={[{ key: 'picks', title: 'Picks', items: [skill, agent] }]} showKind onOpen={() => {}} onAdd={() => {}} /></>);
    await vi.waitFor(() => expect(nativeAdded).toBe(true));
    await vi.waitFor(() => expect(screen.findAllByTestId('discover.membership.review.add.added').length).toBeGreaterThan(0));
    expect(screen.findAllByTestId('discover.membership.review.add.add')).toHaveLength(0);
    expect(screen.findAllByTestId('discover.membership.agent.add.add')).toHaveLength(0);
});
