import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { encodeTerminalConnectLinkV4Payload } from '@happier-dev/protocol/auth/terminalConnectLinkV4';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const promptSpy = vi.hoisted(() => vi.fn(async () => null as string | null));
const replaceSpy = vi.hoisted(() => vi.fn());
const alertSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: key => key === 'connect.enterUrlManually' ? 'Enter URL manually' : key,
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { prompt: promptSpy, alertAsync: alertSpy },
}).module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { replace: replaceSpy },
}).module);
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: null, manifest: null } }));
vi.mock('expo-updates', () => ({ channel: null, releaseChannel: null }));
vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props),
}));

const browser = await installBrowserRuntimeForTests({ url: 'https://guidance.test/' });
afterAll(() => browser.restore());
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const pending = await import('@/sync/domains/pending/pendingTerminalConnect');
const { buildTerminalConnectAuthRedirectHref } = await import('@/utils/path/terminalConnectUrl');
const initialStorageState = getStorage().getState();

const HOME_URL = 'https://guidance-home.test';
const HOME_IDENTITY = 'srv_guidance_home';
const descriptor = {
    v: 1 as const,
    homeServerIdentityId: HOME_IDENTITY,
    canonicalServerUrl: HOME_URL,
    revision: 1,
    endpoints: [{ kind: 'https' as const, url: HOME_URL }],
};
// The current V4 producer and tuple used by terminalConnectUrl's opaque-link
// vectors supply this fixture; URL-only legacy keys cannot authorize pairing.
const pairing = {
    secretB64Url: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'),
    createdAtMs: 1_800_000_000_000,
    expiresAtMs: 1_800_060_000_000,
};
const publicKeyB64Url = Buffer.from(new Uint8Array(32)).toString('base64url');
const terminalUrl = 'happier://terminal?v4=' + encodeTerminalConnectLinkV4Payload({
    v: 4,
    publicKeyB64Url,
    pairing: { ...pairing, v: 3, homeServerIdentityId: HOME_IDENTITY, supportsTokenOnly: true },
    homeConnectionDescriptor: descriptor,
});

beforeEach(async () => {
    promptSpy.mockReset();
    promptSpy.mockResolvedValue(null);
    replaceSpy.mockClear();
    alertSpy.mockClear();
    await home.reset();
    getStorage().setState(initialStorageState, true);
    const serverId = await home.addHome({ name: 'Guidance Home', serverUrl: HOME_URL,
        serverIdentityId: HOME_IDENTITY, publicServerUrl: HOME_URL, accountId: null });
    const machine = createMachineFixture({ id: 'machine-guidance' });
    getStorage().setState({
        machines: { [machine.id]: machine },
        machineListByServerId: { [serverId]: [machine] },
        machineListStatusByServerId: { [serverId]: 'idle' },
        sessionListIndexByServerId: { [serverId]: [] },
    });
    pending.clearPendingTerminalConnect();
});
afterEach(async () => {
    standardCleanup();
    pending.clearPendingTerminalConnect();
    await home.reset();
    getStorage().setState(initialStorageState, true);
});

describe('SessionGettingStartedGuidance manual URL action', () => {
    it('prompts for a terminal URL and preserves the pairing from padded user input for sign-in', async () => {
        promptSpy.mockResolvedValueOnce('  ' + terminalUrl + '  ');
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <SessionGettingStartedGuidance variant="phone" />
        </InjectedAuthProvider>);
        const manualButton = screen.findAllByType(RoundButton)
            .find(node => node.props.title === 'Enter URL manually');

        expect(manualButton).toBeTruthy();
        await act(async () => { await manualButton!.props.onPress(); });

        expect(promptSpy).toHaveBeenCalledWith(
            'modals.authenticateTerminal',
            'modals.pasteUrlFromTerminal',
            expect.objectContaining({ cancelText: 'common.cancel', confirmText: 'common.authenticate',
                placeholder: 'connect.terminalUrlPlaceholder' }),
        );
        await vi.waitFor(() => {
            expect(pending.getPendingTerminalConnect()).toMatchObject({
                publicKeyB64Url, pairing, serverUrl: HOME_URL, serverIdentityId: HOME_IDENTITY,
                supportsTokenOnly: true, homeConnectionDescriptor: descriptor,
            });
            expect(replaceSpy).toHaveBeenCalledWith(buildTerminalConnectAuthRedirectHref({ serverUrl: HOME_URL }));
        });
        expect(alertSpy).toHaveBeenCalledWith('terminal.connectTerminal', 'modals.pleaseSignInFirst', expect.any(Array));
        expect(home.requestsFor('POST /v1/auth/response')).toHaveLength(0);
    });
});
