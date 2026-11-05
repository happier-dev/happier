import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { parseAccountApiTokenCredentialV1 } from '@happier-dev/protocol';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';

import {
    createApiTokenSettingsControllerHarness,
    disposeApiTokenSettingsControllerHarnesses,
    type ApiTokenSettingsControllerHarnessRequest,
} from '../apiTokens/apiTokenSettingsControllerTestHarness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runtime = vi.hoisted(() => ({
    routeParams: {} as Record<string, string | undefined>,
    push: vi.fn(),
    replace: vi.fn(),
    previewProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('reanimated-color-picker', async () => {
    const { createReanimatedColorPickerMock } = await import('@/dev/testkit/mocks/reanimatedColorPicker');
    return createReanimatedColorPickerMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ settleTransientConfirmations: false }).module;
});

// Navigation is the router boundary: record where the screen sends the person.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({ router: { push: runtime.push, replace: runtime.replace } }).module;
    return {
        ...routerMock,
        useLocalSearchParams: () => runtime.routeParams,
        useGlobalSearchParams: () => runtime.routeParams,
    };
});

// The preview is an isolated frame host (iframe on web, WebView on native); record what it is told.
vi.mock('./EmbedLivePreview', () => ({
    EmbedLivePreview: (props: Record<string, unknown>) => {
        runtime.previewProps.push(props);
        return null;
    },
}));

const DAY_MS = 24 * 60 * 60 * 1000;

// The real store, controller and Action graph need a longer cold-transform budget on shared workers.
beforeAll(async () => {
    await import('@/sync/domains/state/storageStore');
    await import('@/sync/ops/actions/defaultActionExecutor');
    await import('./EmbedDetailScreen');
}, 600_000);

afterEach(async () => {
    clearMachineRequestReachabilityForTest();
    await disposeApiTokenSettingsControllerHarnesses();
    standardCleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    runtime.routeParams = {};
    runtime.push.mockClear();
    runtime.replace.mockClear();
    runtime.previewProps.length = 0;
});

type Harness = Awaited<ReturnType<typeof createApiTokenSettingsControllerHarness>>;
const { t } = await import('@/text');

async function renderCreate(harness: Harness, phone = false) {
    const { ApiTokenSettingsScope } = await import('../apiTokens/collection/ApiTokenSettingsScope');
    const { EmbedCreateScreen } = await import('./EmbedDetailScreen');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const page = (
        <ApiTokenSettingsScope controller={harness.controller}>
            <EmbedCreateScreen />
        </ApiTokenSettingsScope>
    );
    return await renderScreen(phone ? <DestinationInstanceHost tabId="embed-draft"
        ref={{ kind: 'settings', params: { pageId: 'embeds/new' } }} pathname="/settings/embeds/new"
        focused visible phone navigation={{ push: runtime.push, replace: runtime.replace, back: () => {} }}>
        {page}
    </DestinationInstanceHost> : page);
}

/** Lets the real controller's requests settle into the mounted screen. */
async function until(assertion: () => void): Promise<void> {
    await vi.waitFor(async () => {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        assertion();
    }, { timeout: 30_000 });
}

function createRequests(requests: readonly ApiTokenSettingsControllerHarnessRequest[]) {
    return requests.filter((request) => request.path === '/v1/auth/api-tokens/create');
}

function daysFromNow(expiresAt: unknown): number {
    return Math.round((Date.parse(String(expiresAt)) - Date.now()) / DAY_MS);
}

describe('Settings → Embeds detail (create, real token controller)', () => {
    it('leaves token revocation confirmation to the Action executor', async () => {
        const harness = await createApiTokenSettingsControllerHarness({ mode: 'plain' });
        const { Modal } = await import('@/modal');
        const confirmation = vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
        harness.controller.setCreateDraft({ label: 'Revocation target', expiryPreset: 'none' });
        await harness.controller.createToken();
        const token = harness.controller.getState().tokens[0]!;
        expect(token).toBeDefined();
        confirmation.mockClear();
        const { useApiTokenOperations } = await import('../apiTokens/useApiTokenOperations');
        const hook = await renderHook(() => useApiTokenOperations(harness.controller));
        await act(async () => { expect(await hook.getCurrent().revoke(token)).toBe(true); });
        expect(harness.controller.getState().tokens).toEqual([]);
        expect(confirmation).toHaveBeenCalledTimes(1);
        expect(harness.requests.filter(request => request.path.endsWith('/revoke'))).toHaveLength(1);
        await hook.unmount();
    }, 180_000);
    it('disables new session creation when the only present machine is unreachable', async () => {
        const harness = await createApiTokenSettingsControllerHarness({ mode: 'plain' });
        const { storage } = await import('@/sync/domains/state/storageStore');
        const machine = createMachineFixture({ id: 'embed-target', activeAt: Date.now() });
        storage.getState().applyMachines([machine], true, { sourceServerId: harness.scope.serverId });
        recordMachineRequestFailed({ ...harness.scope, machineId: machine.id });
        const screen = await renderCreate(harness);
        await until(() => expect(harness.controller.getState().encryptionAvailability).toBe('plain'));
        expect(screen.findByTestId('settings-embed-sessions-switch')?.props.disabled).toBe(true);
    }, 180_000);
    it.each([true, false])('gives the new-embed title to one chrome owner (phone=%s)', async (phone) => {
        const harness = await createApiTokenSettingsControllerHarness({ mode: 'plain' });
        const screen = await renderCreate(harness, phone);
        await until(() => expect(harness.controller.getState().encryptionAvailability).toBe('plain'));
        const bodyTitles = screen.root.findAll(node => typeof node.type === 'string'
            && node.props.accessibilityRole === 'header'
            && node.props.children === t('settingsEmbeds.newTitle'));
        expect(bodyTitles).toHaveLength(phone ? 0 : 1);
        expect(screen.getTextContent()).toContain(t('settingsEmbeds.createDescription'));
        expect(createRequests(harness.requests)).toHaveLength(0);
    }, 180_000);

    it('keeps phone picker Done after the outgoing page exits and returns to the same draft', async () => {
        const harness = await createApiTokenSettingsControllerHarness({ mode: 'plain' });
        const screen = await renderCreate(harness, true);
        await until(() => expect(harness.controller.getState().encryptionAvailability).toBe('plain'));
        act(() => { screen.changeTextByTestId('settings-embed-name', 'DSN draft'); });
        await screen.pressByTestIdAsync('settings-embed-models');
        await screen.pressByTestIdAsync('api-token-grant-models-scope-only');
        // The outgoing page is retained until the real transition finishes. Its cleanup must
        // not erase the current picker's navigation action.
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
        const done = screen.root.findAll(node => typeof node.type === 'string'
            && node.props.accessibilityLabel === t('common.done') && typeof node.props.onPress === 'function');
        expect(done).toHaveLength(1);
        await act(async () => { done[0]!.props.onPress(); });
        await until(() => expect(screen.findByTestId('settings-embed-name')?.props.value).toBe('DSN draft'));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
        await screen.pressByTestIdAsync('settings-embed-models');
        await until(() => expect(screen.findByTestId('api-token-grant-models-scope-only')?.props['aria-checked']).toBe(true));
        expect(runtime.push).not.toHaveBeenCalled();
        expect(runtime.replace).not.toHaveBeenCalled();
        expect(createRequests(harness.requests)).toHaveLength(0);
    }, 180_000);

    it('pushes the narrow preview as the full-page phone preview of the current draft (lab P3)', async () => {
        const harness = await createApiTokenSettingsControllerHarness({ mode: 'plain' });
        const screen = await renderCreate(harness, true);
        await until(() => expect(harness.controller.getState().encryptionAvailability).toBe('plain'));
        await screen.pressByTestIdAsync('settings-embed-preview-row');
        await until(() => expect(runtime.previewProps.at(-1)?.presentation).toBe('page'));
    }, 180_000);

    it('creates a plain-account embed key that keeps approvals (default mode only) and never expires by default', async () => {
        const harness = await createApiTokenSettingsControllerHarness({ mode: 'plain' });
        const { Modal } = await import('@/modal');
        vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
        const screen = await renderCreate(harness);
        await until(() => expect(harness.controller.getState().encryptionAvailability).toBe('plain'));

        // The preview is reconfigured only by presentation changes, never by typing elsewhere.
        const root = screen.findByTestId('settings-embed-detail-root');
        await act(async () => { root?.props.onLayout({ nativeEvent: { layout: { width: 1280, height: 900, x: 0, y: 0 } } }); });
        const previewUi = runtime.previewProps.at(-1)?.ui;
        expect(previewUi).toMatchObject({ modelPicker: false });
        act(() => { screen.changeTextByTestId('settings-embed-name', 'Leads dashboard'); });
        expect(runtime.previewProps.at(-1)?.ui).toBe(previewUi);
        await act(async () => { screen.findByTestId('settings-embed-change-model-switch')!.props.onValueChange(true); });
        expect(runtime.previewProps.at(-1)?.ui).toMatchObject({ modelPicker: true });

        // Approving is described for people on the embed's sites, and the key's reach is stated.
        await act(async () => { screen.findByTestId('api-token-grant-approve-switch')!.props.onValueChange(true); });
        const text = screen.getTextContent();
        expect(text).toContain(t('settingsEmbeds.capabilities.approveOn'));
        expect(text).not.toContain(t('settingsApiTokens.grant.approve.on'));
        expect(screen.findByTestId('settings-embed-key-reach')).toBeTruthy();
        // The preview shows what this access really allows: with Send off it is an approve-only chat (AUD-UI N1).
        expect(runtime.previewProps.at(-1)?.access).toEqual({ send: true, approve: true });
        await act(async () => { screen.findByTestId('settings-embed-send-switch')!.props.onValueChange(false); });
        expect(runtime.previewProps.at(-1)?.access).toEqual({ send: false, approve: true });
        await act(async () => { screen.findByTestId('settings-embed-send-switch')!.props.onValueChange(true); });

        await screen.pressByTestIdAsync('settings-embed-create');
        await until(() => {
            expect(harness.controller.getState().createError,
                JSON.stringify(harness.requests.map(request => request.path))).toBeNull();
            expect(harness.controller.getState().reveal).not.toBeNull();
        });

        const { ApiTokenCreateModal } = await import('../apiTokens/ApiTokenCreateModal');
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
            component: ApiTokenCreateModal,
            props: expect.objectContaining({
                controller: harness.controller,
                revealAccessory: expect.anything(),
                // The reveal speaks of this embed and its key, not a generic API token (lab R1).
                revealCopy: { title: t('settingsEmbeds.reveal.title', { label: 'Leads dashboard' }), shownOnce: t('settingsEmbeds.reveal.shownOnce'), copy: t('settingsEmbeds.reveal.copy') },
            }),
        }));
        // The embed exists now: the page behind the one-time reveal is its detail, never the filled
        // create form that would invite a second create (lab R1).
        const createdId = harness.controller.getState().reveal!.apiToken.tokenId;
        expect(runtime.replace).toHaveBeenCalledWith(`/settings/embeds/${encodeURIComponent(createdId)}`);

        const [created] = createRequests(harness.requests);
        expect(created?.body).toMatchObject({
            label: 'Leads dashboard',
            expiresAt: null,
            grant: expect.objectContaining({ approve: true, permissionModes: ['default'] }),
            embedConfig: expect.objectContaining({ v: 1 }),
        });
        expect((created?.body.grant as { actions: { ids: string[] } }).actions.ids).toContain('session.model.set');
        // A plain Account mints a keyless parent.
        expect(created?.body.encryption).toBeUndefined();
        expect(createRequests(harness.requests)).toHaveLength(1);
    }, 180_000);

    it('waits for encryption, offers restore, then resumes the complete draft and mints an encrypted parent', async () => {
        let finishCheck!: () => void;
        const holdCurrentness = new Promise<void>((resolve) => { finishCheck = resolve; });
        const harness = await createApiTokenSettingsControllerHarness({ readiness: 'unavailable', holdCurrentness });
        const first = await renderCreate(harness);
        act(() => { first.changeTextByTestId('settings-embed-name', 'Leads dashboard'); });

        // Checking: an honest line, and no mint.
        await until(() => expect(first.findByTestId('settings-embed-encryption-checking')).toBeTruthy());
        await first.pressByTestIdAsync('settings-embed-create');
        expect(createRequests(harness.requests)).toHaveLength(0);

        // Unavailable on this device: still no mint, and Restore keeps the whole draft.
        finishCheck();
        await until(() => expect(harness.controller.getState().encryptionAvailability).toBe('unavailable'));
        await first.pressByTestIdAsync('settings-embed-create');
        expect(createRequests(harness.requests)).toHaveLength(0);
        await first.pressByTestIdAsync('settings-embed-expiry:30d');
        await first.pressByTestIdAsync('settings-embed-restore-encryption');
        const destination = new URL(String(runtime.push.mock.calls.at(-1)?.[0]), 'https://app.test');
        expect(destination.pathname).toBe('/restore/manual');
        expect(destination.searchParams.get('returnTo')).toBe('/settings/embeds/new');
        expect(destination.searchParams.get('expectedAccountId')).toBe('account-a');
        await first.unmount();

        // The secret key was restored: the restore screen returns to the create page with the same draft.
        harness.setReadiness('available');
        runtime.routeParams = Object.fromEntries([...destination.searchParams.entries()].filter(([key]) => key !== 'returnTo'));
        const resumed = await renderCreate(harness);
        await until(() => expect(harness.controller.getState().encryptionAvailability).toBe('ready'));
        expect(resumed.findByTestId('settings-embed-e2ee-trust')).toBeTruthy();

        await resumed.pressByTestIdAsync('settings-embed-create');
        // Reversible creation uses the reviewed in-page draft (OWNER-RULINGS 2026-10-16);
        // the restored encryption context must reach the real Action and Home unchanged.
        await until(() => {
            expect(harness.controller.getState().createError).toBeNull();
            expect(harness.controller.getState().reveal).not.toBeNull();
        });
        const [created] = createRequests(harness.requests);
        expect(created?.body).toMatchObject({
            label: 'Leads dashboard',
            grant: expect.objectContaining({ permissionModes: ['default'] }),
            embedConfig: expect.objectContaining({ v: 1 }),
        });
        expect(daysFromNow(created?.body.expiresAt)).toBe(30);
        // An encrypted Account mints a parent that can open session keys, revealed as a combined credential.
        expect(Object.keys(created?.body.encryption as object)).toEqual(['access']);
        expect(parseAccountApiTokenCredentialV1(harness.controller.getState().reveal?.token ?? '')).not.toBeNull();
    }, 180_000);
});
