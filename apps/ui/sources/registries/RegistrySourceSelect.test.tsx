import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { HAPPIER_PICKS_SOURCE_ID } from '@happier-dev/protocol/registries';
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
const { RegistrySourceSelect } = await import('./RegistrySourceSelect');
const { SelectionListFilterChip } = await import('@/components/ui/selectionList');
const registryChooser = (screen: { findByType: (type: never) => { props: { filter: { renderPopoverContent: (context: { close: () => void; maxHeight: number }) => { props: { rootStep: { sections: ReadonlyArray<{ options: ReadonlyArray<{ id: string; label: string }> }> }; selectedOptionId: string; onSelect: (id: string) => void } } } } } }) =>
    screen.findByType(SelectionListFilterChip as never).props.filter.renderPopoverContent({ close() {}, maxHeight: 400 }).props;

describe('RegistrySourceSelect through the Account source owner', () => {
    it('leads with available picks and opens Add and Manage with distinct intent without changing selection', async () => {
        const { sourceId } = await createRegistrySourcesUiHome('select-picks', { picks: true });
        const onChange = vi.fn();
        const onOpenRegistries = vi.fn();
        const screen = await renderScreen(<RegistrySourceSelect kind="skill" value="all" onChange={onChange}
            onOpenRegistries={onOpenRegistries} testID="registry" />);
        await waitForHomeGovernance(() => expect(registryChooser(screen).rootStep.sections[0]!.options.map((item) => item.id))
            .toContain(HAPPIER_PICKS_SOURCE_ID));
        const chooser = registryChooser(screen);
        expect(chooser.rootStep.sections[0]!.options.map((item) => item.id)).toEqual(['all', HAPPIER_PICKS_SOURCE_ID, 'builtin:skills-sh', sourceId]);
        await React.act(async () => { chooser.onSelect('action:add'); });
        await React.act(async () => { chooser.onSelect('action:manage'); });
        expect(onOpenRegistries.mock.calls).toEqual([['add'], ['manage']]);
        expect(onChange).not.toHaveBeenCalled();
    });
});
