import * as React from 'react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import type { IModal } from '@/modal';
import type { ConnectSheetKeyRequest, ConnectSheetKeyResult } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_TITLE, deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { HAPPIER_PICKS_SOURCE_ID, readRegistrySourcesRecordV1 } from '@happier-dev/protocol/registries';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

const modal = vi.hoisted(() => ({ show: vi.fn<IModal['show']>(() => 'picker'), confirm: vi.fn(async () => true) }));
function readRegistryTokenPickerProps(): Readonly<{ request: ConnectSheetKeyRequest; onResult(result: ConnectSheetKeyResult): void }> {
    const props = modal.show.mock.calls.at(-1)?.[0].props;
    if (!props || typeof props !== 'object' || !('request' in props) || !('onResult' in props)
        || typeof props.onResult !== 'function') throw new Error('Expected the registry Connect sheet');
    return props as Readonly<{ request: ConnectSheetKeyRequest; onResult(result: ConnectSheetKeyResult): void }>;
}
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
const { CapabilityDetailHeader } = await import('@/components/capabilities/detail/CapabilityDetailHeader');
const actionFrontDoor = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');

describe('RegistrySourcesView through real registry Actions', () => {
    it.each([
        { kind: 'plugin', link: 'https://unknown-format.test/source.json' },
        { kind: 'plugin', link: 'https://github.com/fixture/skills' },
        { kind: 'skill', link: 'https://unknown-format.test/source.json' },
    ] as const)('names exactly the offered $kind formats when $link is unsupported', async ({ kind, link }) => {
        await createRegistrySourcesUiHome(`unknown-${kind}-${link.includes('github') ? 'git' : 'json'}`, {
            external: async url => url.startsWith('https://unknown-format.test/') ? Response.json({ unsupported: true }) : null,
        });
        const screen = await renderScreen(<RegistrySourcesView kind={kind} initialIntent="add" testID="registries" />);
        const formats = [...new Set(screen.findAll(node => typeof node.props.title === 'string'
            && node.props.title.startsWith('capabilities.registries.add.') && typeof node.props.subtitle === 'string')
            .map(node => node.props.title))].join(', ');
        expect(formats).not.toBe('');
        vi.useFakeTimers();
        try {
            await React.act(async () => { screen.changeTextByTestId('registries:add:link', link); });
            await React.act(async () => { await vi.runOnlyPendingTimersAsync(); });
        } finally { vi.useRealTimers(); }
        const error = () => screen.findAllByTestId('registries:add:link').find(node => 'error' in node.props)!.props.error;
        await waitForHomeGovernance(() => expect(error()).toContain('capabilities.registries.add.unknownFormat'));
        expect(error()).toContain(`formats=${formats}`);
        expect(screen.findByTestId('registries:add:submit')!.props.disabled).toBe(true);
    });

    it('withdraws source and selected-detail acquisition while its management surface is hidden', async () => {
        const { sourceId } = await createRegistrySourcesUiHome('withdrawn-management');
        const reads: string[] = [];
        const create = actionFrontDoor.createFrontDoorActionExecute;
        const observer = vi.spyOn(actionFrontDoor, 'createFrontDoorActionExecute').mockImplementation((...args) => {
            const execute = create(...args);
            return Object.assign((...invocation: Parameters<typeof execute>) => {
                if (invocation[0] === 'registries.sources.list' || invocation[0] === 'registries.items.list') reads.push(invocation[0]);
                return execute(...invocation);
            }, { prepare: execute.prepare });
        });
        try {
            const view = (enabled: boolean) => <RegistrySourcesView kind="skill" testID="registries" enabled={enabled}
                selection={{ value: sourceId, onChange() {}, onStale() {}, navigationBackClosesDetail: true }} />;
            const screen = await renderScreen(view(false));
            expect(reads).toEqual([]);
            await screen.update(view(true));
            await waitForHomeGovernance(() => expect(reads).toContain('registries.items.list'));
            await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:enabled')).not.toBeNull());
            await screen.update(view(false));
            reads.length = 0;
            await React.act(async () => { screen.pressByTestId('registries:detail:refresh-now'); });
            expect(reads).toEqual([]);
        } finally { observer.mockRestore(); }
    });
    it('restores source enable and name through Undo after the acknowledged rows refresh', async () => {
        const { home, sourceId } = await createRegistrySourcesUiHome('undo-source');
        const screen = await renderScreen(<RegistrySourcesView kind="skill" testID="registries" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:enabled')).not.toBeNull());
        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
        retirePresentationNotice();
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:enabled')?.props.disabled).toBe(false));
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
        const outcomes: Awaited<ReturnType<ReturnType<typeof actionFrontDoor.createFrontDoorActionExecute>>>[] = [];
        const create = actionFrontDoor.createFrontDoorActionExecute;
        const observer = vi.spyOn(actionFrontDoor, 'createFrontDoorActionExecute').mockImplementation((...args) => {
            const execute = create(...args);
            return Object.assign(async (...invocation: Parameters<typeof execute>) => {
                const result = await execute(...invocation);
                if (invocation[0] === 'registries.sources.token.set') outcomes.push(result);
                return result;
            }, execute);
        });
        onTestFinished(() => observer.mockRestore());
        const previous = { secretRef: 'happier:shared-secret:v1:previous-registry-token' };
        const { home, sourceId } = await createRegistrySourcesUiHome('token', { token: previous,
            savedSecretResourceIds: ['previous-registry-token', 'registry-token'] });
        const screen = await renderScreen(<RegistrySourcesView kind="skill" testID="registries" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:token')).not.toBeNull());
        expect(screen.getTextContent()).toContain('host=capabilities.registries.detail.tokenGitHubHost');
        modal.confirm.mockClear();
        modal.show.mockClear();
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:token:choose')?.props.disabled).toBe(false));
        const trigger = { measureInWindow: (_callback: unknown) => undefined };
        await React.act(async () => {
            screen.findAllByTestId('registries:detail:token:choose').find(node => typeof node.props.onPress === 'function')!.props.onPress({ currentTarget: trigger });
        });
        const props = readRegistryTokenPickerProps();
        expect(props.request.anchor).toMatchObject({ kind: 'view', ref: { current: trigger } });
        expect(props.request.current).toBe(previous.secretRef);
        await React.act(async () => { props.onResult({ kind: 'selected', secretRef: 'happier:shared-secret:v1:registry-token' }); });
        await waitForHomeGovernance(() => expect(outcomes).toHaveLength(1));
        expect(outcomes[0], JSON.stringify(outcomes[0])).toMatchObject({ ok: true });
        await waitForHomeGovernance(() => expect(home.read().record.value).toMatchObject({ sources: [
            expect.objectContaining({ id: sourceId, token: { secretRef: 'happier:shared-secret:v1:registry-token' } }),
        ] }));
        expect(modal.confirm).not.toHaveBeenCalled();
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:token:undo')?.props.disabled).toBe(false));
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
        const props = readRegistryTokenPickerProps();
        await React.act(async () => { props.onResult({ kind: 'connected', secretRef: 'happier:shared-secret:v1:acme-token' }); });
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:add:submit')!.props.disabled).toBe(false));
        expect(home.read().record.value).toMatchObject({ sources: [expect.objectContaining({ title: 'Review skills' })] });
    });
    it('replaces and removes a private Happier catalog token while built-in picks stay read-only', async () => {
        const url = 'https://registry.acme.test/catalog.json';
        const previous = { secretRef: 'happier:shared-secret:v1:previous-registry-token' };
        const nextRef = 'happier:shared-secret:v1:registry-token';
        const { home, sourceId } = await createRegistrySourcesUiHome('private-catalog-token', {
            source: { id: deriveMarketplaceSourceId(url), url, title: 'Acme catalog', format: 'happier-catalog',
                kinds: ['plugin'], enabled: true, addedAt: 1, token: previous },
            savedSecretResourceIds: ['previous-registry-token', 'registry-token'],
        });
        const screen = await renderScreen(<RegistrySourcesView kind="plugin" testID="registries" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:name')?.props.value).toBe('Acme catalog'));
        expect(screen.findByTestId('registries:detail:token')).not.toBeNull();
        expect(screen.getTextContent()).toContain('host=registry.acme.test');
        modal.show.mockClear();
        modal.confirm.mockClear();
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:token:choose')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('registries:detail:token:choose');
        const picker = readRegistryTokenPickerProps;
        expect(picker().request.current).toBe(previous.secretRef);
        await React.act(async () => { picker().onResult({ kind: 'selected', secretRef: nextRef }); });
        await waitForHomeGovernance(() => expect(home.read().record.value).toMatchObject({
            sources: [expect.objectContaining({ id: sourceId, token: { secretRef: nextRef } })],
        }));
        await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:token:choose')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('registries:detail:token:remove');
        await waitForHomeGovernance(() => {
            const value = readRegistrySourcesRecordV1(home.read().record.value);
            expect(value.sources[0]?.id).toBe(sourceId);
            expect(value.sources[0]?.token).toBeUndefined();
        });
        expect(modal.confirm).not.toHaveBeenCalled();
        await screen.update(<RegistrySourcesView kind="plugin" testID="registries" selection={{
            value: HAPPIER_PICKS_SOURCE_ID, onChange() {}, onStale() {}, navigationBackClosesDetail: true,
        }} />);
        await waitForHomeGovernance(() => expect(screen.findByType(CapabilityDetailHeader).props.title).toBe(DEFAULT_CURATED_MARKETPLACE_SOURCE_TITLE));
        expect(screen.findByTestId('registries:detail:token')).toBeNull();
        expect(screen.findByTestId('registries:detail:name')).toBeNull();
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
        const onStale = vi.fn();
        const view = (value: string | null, navigationBackClosesDetail = true) => <RegistrySourcesView kind="skill" testID="registries"
            selection={{ value, onChange: vi.fn(), onStale, navigationBackClosesDetail }} />;
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
        it('falls back to the list, and asks the route to drop it, for an id the Account no longer has', async () => {
            device.current = 'phone';
            const { sourceId } = await createRegistrySourcesUiHome('phone-stale-route');
            onStale.mockClear();
            const screen = await renderScreen(view('removed-source'));
            await measure(screen, 390);
            await waitForHomeGovernance(() => expect(screen.findByTestId('registries:list')).not.toBeNull());
            expect(screen.findByTestId('registries:detail:enabled')).toBeNull();
            expect(onStale).toHaveBeenCalledTimes(1);
            await screen.update(view(sourceId));
            await measure(screen, 390);
            await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:enabled')).not.toBeNull());
        });
        it('keeps the in-content Back where the navigation does not close the pushed detail', async () => {
            device.current = 'phone';
            const { sourceId } = await createRegistrySourcesUiHome('phone-route-own-back');
            const screen = await renderScreen(view(sourceId, false));
            await measure(screen, 390);
            await waitForHomeGovernance(() => expect(screen.findByTestId('registries:detail:enabled')).not.toBeNull());
            expect(screen.findByTestId('registries:detail-pane:back')).not.toBeNull();
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
