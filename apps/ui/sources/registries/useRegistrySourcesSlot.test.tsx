import * as React from 'react';
import { describe, expect, it, onTestFailed, vi } from 'vitest';
import { renderHook, renderScreen } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

installPromptRegistriesCommonModuleMocks({ storage: original => original() });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { createRegistrySourcesUiHome } = await import('@/dev/testkit/harness/registrySourcesUiHarness');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
await Promise.all([import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverRuntime'),
    import('@/sync/domains/state/storage'), import('@/utils/system/runtimeFetch'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime')]);
const { useRegistrySourcesSlot } = await import('./useRegistrySourcesSlot');
const { SelectionListFilterChip } = await import('@/components/ui/selectionList');
const registryChooser = (screen: { findByType: (type: never) => { props: { filter: { renderPopoverContent: (context: { close: () => void; maxHeight: number }) => { props: { rootStep: { sections: ReadonlyArray<{ options: ReadonlyArray<{ id: string; label: string }> }> }; selectedOptionId: string; onSelect: (id: string) => void } } } } } }) =>
    screen.findByType(SelectionListFilterChip as never).props.filter.renderPopoverContent({ close() {}, maxHeight: 400 }).props;
const { useRegistrySourceMutations } = await import('./useRegistrySourceMutations');
const { useRegistryItems } = await import('./useRegistryItems');

describe('registry sources shell slot', () => {
    it.each(['disable', 'remove'] as const)('normalizes the displayed and query selection after %s without resurrecting it', async operation => {
        let phase = 'admit Home';
        let observed: unknown;
        onTestFailed(() => console.error('Registry normalization phase:', phase, 'selection:', observed));
        const { home, sourceId } = await createRegistrySourcesUiHome(`slot-${operation}`);
        phase = 'render slot';
        function useAdd() {
            const slot = useRegistrySourcesSlot('skill', { initialSelection: sourceId, testID: 'slot' });
            observed = { selection: slot.selection, sourceIds: slot.sourceIds };
            return { slot, mutations: useRegistrySourceMutations(), items: useRegistryItems({ kind: 'skill', sourceIds: slot.sourceIds }) };
        }
        let current: ReturnType<typeof useAdd> | undefined;
        function Add() {
            current = useAdd();
            return <>{current.slot.sources.renderSelect({ openRegistries() {} })}</>;
        }
        const getCurrent = () => {
            if (!current) throw new Error('Add has not mounted');
            return current;
        };
        phase = 'render selector';
        const screen = await renderScreen(<Add />);
        await waitForHomeGovernance(() => expect(registryChooser(screen).rootStep.sections[0]!.options.map((item) => item.id)).toContain(sourceId));
        expect(getCurrent().slot.sourceIds).toEqual([sourceId]);
        expect(registryChooser(screen).selectedOptionId).toBe(sourceId);
        phase = 'initial items settle';
        await waitForHomeGovernance(() => expect(getCurrent().items.loading).toBe(false));
        const selectedIds = getCurrent().slot.sourceIds;
        const reads = home.requests.length;
        await screen.update(<Add />);
        expect(getCurrent().slot.sourceIds).toBe(selectedIds);
        expect(home.requests).toHaveLength(reads);
        // An enabled source survives an unrelated descriptor edit.
        phase = 'rename selected source';
        await React.act(async () => { await getCurrent().mutations.update({ sourceId, title: 'Renamed registry' }); });
        await waitForHomeGovernance(() => expect(registryChooser(screen).rootStep.sections[0]!.options).toContainEqual(expect.objectContaining({ id: sourceId, label: 'Renamed registry' })));
        expect(getCurrent().slot.selection).toBe(sourceId);
        phase = 'remove or disable selection';
        await React.act(async () => {
            if (operation === 'disable') await getCurrent().mutations.update({ sourceId, enabled: false });
            else await getCurrent().mutations.delete(sourceId);
        });
        await waitForHomeGovernance(() => expect(registryChooser(screen).rootStep.sections[0]!.options.map((item) => item.id)).not.toContain(sourceId));
        expect(getCurrent().slot.selection).toBe('all');
        expect(getCurrent().slot.sourceIds).toBeUndefined();
        await waitForHomeGovernance(() => expect(getCurrent().items.pages.map(page => page.sourceId)).toContain('builtin:skills-sh'));
        expect(registryChooser(screen).selectedOptionId).toBe('all');
        if (operation === 'disable') {
            await React.act(async () => { await getCurrent().mutations.update({ sourceId, enabled: true }); });
            await waitForHomeGovernance(() => expect(registryChooser(screen).rootStep.sections[0]!.options.map((item) => item.id)).toContain(sourceId));
            expect(getCurrent().slot.selection).toBe('all');
            expect(getCurrent().slot.sourceIds).toBeUndefined();
        }
    });
    it('opens the requested add draft, selects an already-added registry, returns to the catalog and shares that selection with the select', async () => {
        let phase = 'admit Home';
        let requests: unknown;
        onTestFailed(() => console.error('Registry slot phase:', phase, 'HTTP:', requests));
        const { source, sourceId, home } = await createRegistrySourcesUiHome('slot-existing');
        requests = home.requests;
        phase = 'render hook';
        const hook = await renderHook(() => useRegistrySourcesSlot('skill', { testID: 'slot' }));
        const back = vi.fn();
        phase = 'render draft';
        const view = await renderScreen(<>{hook.getCurrent().sources.renderRegistriesView({ intent: 'add', back })}</>);
        expect(view.findByTestId('slot.view:add:link')).not.toBeNull();
        phase = 'detect';
        vi.useFakeTimers();
        try {
            await React.act(async () => { view.changeTextByTestId('slot.view:add:link', source.url); });
            await React.act(async () => { await vi.runOnlyPendingTimersAsync(); });
        } finally { vi.useRealTimers(); }
        await waitForHomeGovernance(() => expect(view.findByTestId('slot.view:add:detected')).not.toBeNull());
        phase = 'submit';
        await view.pressByTestIdAsync('slot.view:add:submit');
        await waitForHomeGovernance(() => expect(hook.getCurrent().sourceIds).toEqual([sourceId]));
        expect(back).toHaveBeenCalledTimes(1);
        expect(home.read().record.value).toMatchObject({ sources: [expect.objectContaining({ id: sourceId })] });
        phase = 'render selected field';
        const select = await renderScreen(<>{hook.getCurrent().sources.renderSelect({ openRegistries() {} })}</>);
        await waitForHomeGovernance(() => expect(registryChooser(select).selectedOptionId).toBe(sourceId));
    });
});
