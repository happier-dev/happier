import * as React from 'react';
import { afterEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import type { IModal } from '@/modal';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

const modal = vi.hoisted(() => ({ show: vi.fn<IModal['show']>(() => 'picker'), confirm: vi.fn(async () => true) }));
installPromptRegistriesCommonModuleMocks({ storage: original => original(), text: async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock(), modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: modal }).module });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { createRegistrySourcesUiHome } = await import('@/dev/testkit/harness/registrySourcesUiHarness');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
await Promise.all([import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverRuntime'),
    import('@/sync/domains/state/storage'), import('@/utils/system/runtimeFetch'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime')]);
// The device class is a platform adapter boundary; only the phone case sets it.
const device = vi.hoisted(() => ({ current: null as 'phone' | null }));
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return { ...actual, useDeviceType: () => device.current ?? actual.useDeviceType() };
});
const { RegistrySourcesView } = await import('./RegistrySourcesView');

describe('RegistrySourcesView through real registry Actions', () => {
    it('restores source enable and name through Undo after the acknowledged rows refresh', async () => {
        const { home, sourceId } = await createRegistrySourcesUiHome('undo-source');
        const screen = await renderScreen(<RegistrySourcesView kind="skill" testID="registries" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:enabled')).not.toBeNull());
        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
        retirePresentationNotice();
        await React.act(async () => { screen.findByTestId('registries:detail:enabled')!.props.onValueChange(false); });
        await waitForHomeGovernance(() => expect(home.read().record.value).toMatchObject({ sources: [expect.objectContaining({ id: sourceId, enabled: false })] }));
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:enabled')!.props.value).toBe(false));
        expect(readPresentationNotice()?.undo).toBeDefined();
        await React.act(async () => { readPresentationNotice()!.undo!.run(); });
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:enabled')!.props.value).toBe(true));
        await React.act(async () => { screen.findByTestId('registries:detail:name')!.props.onChangeText('Renamed skills'); });
        await React.act(async () => { screen.findByTestId('registries:detail:name')!.props.onBlur(); });
        await waitForHomeGovernance(() => expect(home.read().record.value).toMatchObject({ sources: [expect.objectContaining({ title: 'Renamed skills' })] }));
        await waitForHomeGovernance(() => expect(readPresentationNotice()?.undo).toBeDefined());
        await React.act(async () => { readPresentationNotice()!.undo!.run(); });
        await waitForHomeGovernance(() => expect(home.read().record.value).toMatchObject({ sources: [expect.objectContaining({ title: 'Review skills' })] }));
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:name')!.props.value).toBe('Review skills'));
    });
    it('names the receiving host before choosing a token, applies directly, and Undo restores the previous binding', async () => {
        let phase = 'admit Home';
        let requests: unknown;
        let lastUi = '';
        onTestFailed(() => console.error('Registry token phase:', phase, 'HTTP:', requests, 'UI:', lastUi));
        const previous = { secretRef: 'happier:shared-secret:v1:previous-registry-token' };
        const { home, sourceId } = await createRegistrySourcesUiHome('token', { token: previous,
            savedSecretResourceIds: ['previous-registry-token', 'registry-token'] });
        requests = home.requests;
        phase = 'render';
        const screen = await renderScreen(<RegistrySourcesView kind="skill" testID="registries" />);
        phase = 'wait token row';
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:token')).not.toBeNull());
        expect(screen.getTextContent()).toContain('host=capabilities.registries.detail.tokenGitHubHost');
        modal.confirm.mockClear();
        modal.show.mockClear();
        phase = 'open picker';
        await screen.pressByTestIdAsync('registries:detail:token:choose');
        const picker = modal.show.mock.calls.at(-1)![0];
        const props = picker.props as Extract<import('@/components/ui/forms/valueRefs/SavedSecretPickerModal').SavedSecretPickerModalProps, { selectedId: string | null }>;
        expect(props.selectedId).toBe(previous.secretRef);
        phase = 'apply token';
        await React.act(async () => { props.onSelectId('happier:shared-secret:v1:registry-token'); });
        await waitForHomeGovernance(() => expect(home.read().record.value).toMatchObject({ sources: [
            expect.objectContaining({ id: sourceId, token: { secretRef: 'happier:shared-secret:v1:registry-token' } }),
        ] }));
        expect(modal.confirm).not.toHaveBeenCalled();
        phase = 'undo';
        await waitForHomeGovernance(() => {
            lastUi = screen.getTextContent();
            expect(screen.findByTestId('registries:detail:token:undo')?.props.disabled).toBe(false);
        });
        await screen.pressByTestIdAsync('registries:detail:token:undo');
        await waitForHomeGovernance(() => expect(home.read().record.value).toMatchObject({
            sources: [expect.objectContaining({ id: sourceId, token: previous })],
        }));
    });
    it('asks for a token when a registry needs one, names where it goes, and offers Add only once one is chosen', async () => {
        const { home } = await createRegistrySourcesUiHome('needs-token', { savedSecretResourceIds: ['acme-token'],
            external: async url => url === 'https://registry.acme.test/.claude-plugin/marketplace.json'
                ? new Response(null, { status: 401 }) : null });
        const screen = await renderScreen(<RegistrySourcesView kind="skill" initialIntent="add" testID="registries" />);
        vi.useFakeTimers();
        try {
            await React.act(async () => { screen.changeTextByTestId('registries:add:link', 'https://registry.acme.test/.claude-plugin/marketplace.json'); });
            await React.act(async () => { await vi.runOnlyPendingTimersAsync(); });
        } finally { vi.useRealTimers(); }
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:add:token')).not.toBeNull());
        expect(screen.getTextContent()).toContain('host=registry.acme.test');
        expect(screen.findByTestId('registries:add:submit')!.props.disabled).toBe(true);
        modal.show.mockClear();
        await screen.pressByTestIdAsync('registries:add:token:choose');
        const props = modal.show.mock.calls.at(-1)![0].props as Extract<import('@/components/ui/forms/valueRefs/SavedSecretPickerModal').SavedSecretPickerModalProps, { selectedId: string | null }>;
        await React.act(async () => { props.onSelectId('happier:shared-secret:v1:acme-token'); });
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:add:submit')!.props.disabled).toBe(false));
        expect(home.read().record.value).toMatchObject({ sources: [expect.objectContaining({ title: 'Review skills' })] });
    });
    describe('on a phone page that owns the open source in its route', () => {
        afterEach(() => { device.current = null; });
        const measure = async (screen: Awaited<ReturnType<typeof renderScreen>>, width: number) => {
            const nodes = screen.root.findAll(node => typeof node.props.onLayout === 'function'
                && typeof node.props.testID === 'string' && node.props.testID.startsWith('registries'));
            await React.act(async () => {
                for (const node of nodes) node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 800 } } });
            });
        };
        const view = (value: string | null) => <RegistrySourcesView kind="skill" testID="registries"
            selection={{ value, onChange: vi.fn() }} />;
        it('rests on the list until the route names a source, then shows it as the page with no Back of its own', async () => {
            device.current = 'phone';
            const { sourceId } = await createRegistrySourcesUiHome('phone-route');
            const screen = await renderScreen(view(null));
            await measure(screen, 390);
            expect(screen.findByTestId('registries:detail:enabled')).toBeNull();
            await screen.update(view(sourceId));
            await measure(screen, 390);
            await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:enabled')).not.toBeNull());
            expect(screen.findByTestId('registries:detail-pane:back')).toBeNull();
        });
        it('keeps its own Back where the host page does not own the selection', async () => {
            device.current = 'phone';
            await createRegistrySourcesUiHome('phone-own-back');
            const screen = await renderScreen(<RegistrySourcesView kind="skill" initialIntent="add" testID="registries" />);
            await measure(screen, 390);
            await waitForHomeGovernance(() => expect(screen.findByTestId('registries:add:link')).not.toBeNull());
            expect(screen.findByTestId('registries:detail-pane:back')).not.toBeNull();
        });
    });
});
