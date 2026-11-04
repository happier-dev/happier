import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { admitDesktopCaptureWindowAction, dispatchDesktopCaptureWindowAction } from './desktopWindowActionDispatch';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// Expo's router is the UI navigation boundary; scoped-route admission remains real.
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: navigation.push },
}).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);

describe('Capture webview Action allow-list', () => {
    it('admits each native capture editor label and excludes selection windows', () => {
        expect(admitDesktopCaptureWindowAction({ windowLabel: 'capture_2', actionIdentifier: 'screenCapture.send' }))
            .toEqual({ ok: true, actionId: 'screenCapture.send' });
        for (const windowLabel of ['capture_selection_2', 'capture_other', 'capture_']) {
            expect(admitDesktopCaptureWindowAction({ windowLabel, actionIdentifier: 'screenCapture.send' }))
                .toEqual({ ok: false, errorCode: 'window_action_refused' });
        }
    });
    it.each(['screenCapture.open', 'screenCapture.addToDraft', 'screenCapture.send', 'screenCapture.discard'])(
        'admits the Capture window own %s capability', actionIdentifier => {
            expect(admitDesktopCaptureWindowAction({ windowLabel: 'capture', actionIdentifier }))
                .toEqual({ ok: true, actionId: actionIdentifier });
        },
    );

    it.each([
        { windowLabel: 'unknown', actionIdentifier: 'screenCapture.send' },
        { windowLabel: 'activity_overlay', actionIdentifier: 'screenCapture.send' },
        { windowLabel: 'capture', actionIdentifier: 'session.message.send' },
        { windowLabel: 'capture', actionIdentifier: 'settings.set' },
    ])('refuses an unknown window or a capability outside its surface: %j', request => {
        expect(admitDesktopCaptureWindowAction(request)).toEqual({ ok: false, errorCode: 'window_action_refused' });
    });
});

describe('Capture pill Open through main dispatch', () => {
    const effects: unknown[] = [];
    const results: unknown[] = [];
    let target: Readonly<{ serverId: string; accountId: string; sessionId: string }>;
    let activeHome: string;
    beforeEach(async () => {
        await homes.reset();
        activeHome = await homes.addHome({ name: 'Active', serverUrl: 'https://capture-open-active.test', accountId: 'alice' });
        const serverId = await homes.addHome({ name: 'Capture destination', serverUrl: 'https://capture-open-target.test', accountId: 'alice', active: false });
        target = { serverId, accountId: 'alice', sessionId: 'shared session' };
        effects.length = 0; results.length = 0;
        navigation.push.mockReset();
        navigation.push.mockImplementation(href => { effects.push({ kind: 'route', href }); });
        const secureStorage = createDesktopSecureStorageBoundary();
        // Tauri invoke is the native window/secure-storage boundary.
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command.startsWith('desktop_secure_storage_')) return secureStorage.invoke(command, args);
            if (command === 'desktop_window_emit_action_result') { results.push(args?.payload); return; }
            if (command === 'desktop_show_main_window') { effects.push({ kind: 'show' }); return; }
            throw new Error('Unexpected native command');
        } });
    });
    afterEach(async () => { await homes.reset(); vi.unstubAllGlobals(); });

    it('raises main and opens the exact qualified Session without changing the active Home', async () => {
        await dispatchDesktopCaptureWindowAction({ windowLabel: 'capture', requestId: 'open',
            actionIdentifier: 'screenCapture.session.open', data: target }, createActionExecutor({}));
        expect(effects).toEqual([{ kind: 'show' }, { kind: 'route',
            href: `/session/shared%20session?serverId=${encodeURIComponent(target.serverId)}` }]);
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        expect(getActiveServerSnapshot().serverId).toBe(activeHome);
        expect(results).toEqual([
            { windowLabel: 'capture', requestId: 'open', phase: 'admitted', ok: true },
            { windowLabel: 'capture', requestId: 'open', phase: 'settled', ok: true,
                result: { status: 'opened', session: target } },
        ]);
    });

    it.each([
        { accountId: 'replaced-account', expected: 'action_account_scope_changed' },
        { serverId: 'unknown-home', expected: 'operation_unavailable' },
        { sessionId: '', expected: 'invalid_input' },
    ])('refuses an unavailable or malformed exact target before raising main: $expected', async ({ expected, ...override }) => {
        await dispatchDesktopCaptureWindowAction({ windowLabel: 'capture', requestId: 'open',
            actionIdentifier: 'screenCapture.session.open', data: { ...target, ...override } }, createActionExecutor({}));
        expect(effects).toEqual([]);
        expect(results.at(-1)).toMatchObject({ phase: 'settled', ok: false, errorCode: expected });
    });

    it('refuses the same navigation capability from another window', async () => {
        await dispatchDesktopCaptureWindowAction({ windowLabel: 'activity_overlay', requestId: 'open',
            actionIdentifier: 'screenCapture.session.open', data: target }, createActionExecutor({}));
        expect(effects).toEqual([]);
        expect(results).toEqual([{ windowLabel: 'activity_overlay', requestId: 'open', phase: 'settled',
            ok: false, errorCode: 'window_action_refused' }]);
    });
});
