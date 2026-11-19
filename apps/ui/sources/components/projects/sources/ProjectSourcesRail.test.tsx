import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectSourceV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
afterEach(standardCleanup);

const { ProjectSourcesRail } = await import('./ProjectSourcesRail');
const { ProjectOpenSourceChooser } = await import('../activation/ProjectOpenSourceChooser');
const { Item } = await import('@/components/ui/lists/Item');
const { SkeletonRows } = await import('@/components/ui/lists/SkeletonRows');

// A first load is not an empty catalog: a phone shows the rail alone, so it draws the shared loading rows and no
// count until the catalog answers (L12 design review 11-19 F, phone list read "Sources 0" while loading).
it('shows loading rows and no count while the catalog first loads', async () => {
    const rail = await renderScreen(<ProjectSourcesRail groups={[]} total={0} loading query="" onChangeQuery={() => {}}
        selectedId={null} drafting={false} teamName={() => null} stale={null} onSelect={() => {}} onAdd={() => {}} />);
    expect(rail.findAllByType(SkeletonRows)).toHaveLength(1);
    expect(rail.getTextContent()).not.toContain('0');
});

it('keeps a repository-less Source in its catalog but excludes it from repository Open choices', async () => {
    const source = ProjectSourceV1Schema.parse({ id: 'stored', revision: 1, name: 'Production', audience: [], createdByAccountId: 'account' });
    const groups = [{ id: 'yours', title: 'Your sources', sources: [source] }];
    const rail = await renderScreen(<ProjectSourcesRail groups={groups} total={1} loading={false} query="" onChangeQuery={() => {}}
        selectedId={source.id} drafting={false} teamName={() => null} stale={null} onSelect={() => {}} onAdd={() => {}} />);
    expect(rail.getTextContent()).toContain('Production');
    expect(rail.findByTestId('projects.sources.row.stored')).not.toBeNull();
    const chooser = await renderScreen(<ProjectOpenSourceChooser groups={groups} empty={false} query="" onChangeQuery={() => {}}
        selectedSourceId={null} folderSelected={false} folderDisabled={false} onSelectSource={() => {}} onPickFolder={() => {}} />);
    expect(chooser.findByTestId('projects.open.source.stored')).toBeNull();
    expect(chooser.findByTestId('projects.open.folder')).not.toBeNull();
});

it('keeps described Sources rail navigation compact and opens the selected Source', async () => {
    const source = ProjectSourceV1Schema.parse({
        id: 'billing', revision: 1, name: 'Billing repository', audience: [], createdByAccountId: 'account',
        repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'acme/billing' }, protocol: 'https' },
    });
    const select = vi.fn();
    const screen = await renderScreen(<ProjectSourcesRail groups={[{ id: 'yours', title: 'Your sources', sources: [source] }]}
        total={1} loading={false} query="" onChangeQuery={() => {}} selectedId={source.id} drafting={false}
        teamName={() => null} stale={null} onSelect={select} onAdd={() => {}} />);
    const row = screen.findAllByType(Item).find(node => node.props.testID === 'projects.sources.row.billing')!;
    expect(row.props.rowRole).toBe('item');
    expect(row.props.titleLines).toBe(1);
    expect(screen.getTextContent()).toContain('acme/billing');
    await screen.pressByTestIdAsync('projects.sources.row.billing');
    expect(select).toHaveBeenCalledWith(source.id);
    const choose = vi.fn();
    const chooser = await renderScreen(<ProjectOpenSourceChooser groups={[{ id: 'yours', title: 'Your sources', sources: [source] }]}
        empty={false} query="" onChangeQuery={() => {}} selectedSourceId={source.id} folderSelected={false}
        folderDisabled={false} onSelectSource={choose} onPickFolder={() => {}} />);
    const choice = chooser.findAllByType(Item).find(node => node.props.testID === 'projects.open.source.billing')!;
    expect(choice.props.rowRole).toBe('item');
    expect(choice.props.titleLines).toBe(1);
    await chooser.pressByTestIdAsync('projects.open.source.billing');
    expect(choose).toHaveBeenCalledWith(source);
});
