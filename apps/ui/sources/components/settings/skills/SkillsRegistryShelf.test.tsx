import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { RegistryItemSummaryV1Schema } from '@happier-dev/protocol/registries';
import { measureMountedCollections, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSkillsSurfaceHarness } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { t } from '@/text';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();
const { SkillsRegistryShelf } = await import('./SkillsRegistryShelf');
const { SkillKindGlyph } = await import('./SkillKindGlyph');
const { useSkillsLibrary } = await import('@/sync/domains/skills/useSkillsLibrary');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');

afterEach(() => {
    standardCleanup();
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
});

it('offers a single suggestion as one row, not a lone card in a three-card row', async () => {
    const sourceId = 'registry:team-playbook';
    const home = await createSkillsSurfaceHarness('https://skills-shelf-one.test', [{ key: 'registry-sources', value: {
        v: 2, disabledSourceIds: [], sources: [{ id: sourceId, title: 'Team playbook', format: 'git', kinds: ['skill'],
            url: 'https://github.com/fixture/team-skills', enabled: true, addedAt: 1 }],
    } }]);
    const items = [RegistryItemSummaryV1Schema.parse({
        kind: 'skill', sourceId, itemId: 'only-skill', title: 'Only suggestion', description: 'Useful instructions.',
    })];
    function Shelf() {
        const library = useSkillsLibrary();
        return <SkillsRegistryShelf brandNew={false} library={library}
            shelf={{ items, sourceId: 'builtin:happier-picks', loading: false,
                error: null, status: null, sourceFailures: [], refresh: async () => {} }} />;
    }
    const screen = await renderScreen(<Shelf />);
    try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Only suggestion'));
        expect(screen.findByTestId('skills.home.shelf.only-skill.row')).not.toBeNull();
        expect(screen.findByTestId('skills.home.shelf.only-skill.add')).not.toBeNull();
    } finally { await screen.unmount(); await home.dispose(); }
});

it('names each suggested skill’s own source and keeps an unavailable source human-readable', async () => {
    const sourceId = 'registry:team-playbook';
    const unknownSourceId = 'registry:removed-source-identifier';
    const home = await createSkillsSurfaceHarness('https://skills-shelf-sources.test', [{ key: 'registry-sources', value: {
        v: 2, disabledSourceIds: [], sources: [{ id: sourceId, title: 'Team playbook', format: 'git', kinds: ['skill'],
            url: 'https://github.com/fixture/team-skills', enabled: true, addedAt: 1 }],
    } }]);
    const items = [sourceId, unknownSourceId].map((sourceId, index) => RegistryItemSummaryV1Schema.parse({
        kind: 'skill', sourceId, itemId: `skill-${index}`, title: `Suggested skill ${index}`, description: 'Useful instructions.',
    }));
    function Shelf() {
        const library = useSkillsLibrary();
        return <SkillsRegistryShelf brandNew={false} library={library}
            shelf={{ items, sourceId: 'builtin:happier-picks', loading: false,
                error: null, status: null, sourceFailures: [], refresh: async () => {} }} />;
    }
    const screen = await renderScreen(<Shelf />);
    try {
        await measureMountedCollections(screen);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Team playbook'));
        expect(screen.getTextContent()).toContain(t('common.unavailable'));
        expect(screen.getTextContent()).not.toContain(sourceId);
        expect(screen.getTextContent()).not.toContain(unknownSourceId);
        expect(screen.findByTestId('skills.home.shelf.skill-0.add')).not.toBeNull();
        expect(screen.findByTestId('skills.home.shelf.skill-1.add')).not.toBeNull();
        // One item, one mark (X3): an unbranded skill's card carries the same kind glyph as its column row.
        expect(screen.findAllByType(SkillKindGlyph)).toHaveLength(2);
    } finally { await screen.unmount(); await home.dispose(); }
});

function UnavailableShelf(props: Readonly<{
    items: ReturnType<typeof RegistryItemSummaryV1Schema.parse>[];
    sourceFailures: { sourceId: string; message: string; onRetry: () => void }[];
    refresh: () => Promise<void>;
}>) {
    const library = useSkillsLibrary();
    return <SkillsRegistryShelf brandNew={false} library={library}
        shelf={{ items: props.items, sourceId: 'registry:team-playbook', loading: false, error: null, status: null,
            sourceFailures: props.sourceFailures as never, refresh: props.refresh }} />;
}

async function unavailableHome() {
    return createSkillsSurfaceHarness('https://skills-shelf-unavailable.test', [{ key: 'registry-sources', value: {
        v: 2, disabledSourceIds: [], sources: [{ id: 'registry:team-playbook', title: 'Team playbook', format: 'git', kinds: ['skill'],
            url: 'https://github.com/fixture/team-skills', enabled: true, addedAt: 1 }],
    } }]);
}

it('says why an empty shelf is unavailable, with the source and a Retry, instead of vanishing', async () => {
    const home = await unavailableHome();
    const refresh = vi.fn(async () => {});
    const screen = await renderScreen(<UnavailableShelf items={[]} refresh={refresh}
        sourceFailures={[{ sourceId: 'registry:team-playbook', message: 'Couldn’t reach this registry.', onRetry: () => {} }]} />);
    try {
        await measureMountedCollections(screen);
        await vi.waitFor(() => expect(screen.findByTestId('skills.home.shelf.unavailable')).not.toBeNull());
        expect(screen.getTextContent()).toContain('Team playbook');
        // 22e00c5425c names the failed registry; the generic producer sentence
        // remains diagnostic detail rather than a second outage announcement.
        expect(screen.getTextContent()).toContain(t('promptLibrary.registriesStatus.unreachableSource', { source: 'Team playbook' }));
        await screen.pressByTestIdAsync('skills.home.shelf.unavailable.retry');
        expect(refresh).toHaveBeenCalledTimes(1);
    } finally { await screen.unmount(); await home.dispose(); }
});

it('keeps the retained cards through an outage and a confirmed-empty shelf stays quiet', async () => {
    const home = await unavailableHome();
    const item = RegistryItemSummaryV1Schema.parse({ kind: 'skill', sourceId: 'registry:team-playbook', itemId: 'skill-0', title: 'Retained skill' });
    const outage = await renderScreen(<UnavailableShelf items={[item]} refresh={async () => {}}
        sourceFailures={[{ sourceId: 'registry:team-playbook', message: 'Couldn’t reach this registry.', onRetry: () => {} }]} />);
    try {
        await measureMountedCollections(outage);
        await vi.waitFor(() => expect(outage.getTextContent()).toContain('Retained skill'));
        expect(outage.findByTestId('skills.home.shelf.unavailable')).not.toBeNull();
    } finally { await outage.unmount(); }
    const quiet = await renderScreen(<UnavailableShelf items={[]} refresh={async () => {}} sourceFailures={[]} />);
    try {
        expect(quiet.findByTestId('skills.home.shelf.unavailable')).toBeNull();
        expect(quiet.getTextContent()).toBe('');
    } finally { await quiet.unmount(); await home.dispose(); }
});
