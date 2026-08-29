import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({ enabled: true }));
const paneState = vi.hoisted(() => ({ props: null as unknown }));
const settingState = vi.hoisted(() => ({
    preference: 'native',
    quarantine: { renderer: 'ios-ghosttykit', expiresAtMs: Date.now() + 10_000 } as unknown,
    setPreference: vi.fn((value: unknown) => { settingState.preference = String(value); }),
    setQuarantine: vi.fn((value: unknown) => { settingState.quarantine = value; }),
}));
const qaState = vi.hoisted(() => ({
    injectCrash: vi.fn(async () => ({ injected: true, surfaceId: 'embedded-terminal:ios-ghosttykit:terminal-qa-loaded-device' })),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const mock = await createReactNativeWebMock({
        Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
    });
    return {
        ...mock,
        AppState: {
            currentState: 'active',
            addEventListener: () => ({ remove: vi.fn() }),
        },
        Dimensions: {
            addEventListener: () => ({ remove: vi.fn() }),
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/auth/routing/devRoutePolicy', () => ({
    isDevRouteEnabled: () => routeState.enabled,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSettingMutable: (key: string) => key === 'terminalRendererPreference'
        ? [settingState.preference, settingState.setPreference]
        : [settingState.quarantine, settingState.setQuarantine],
}));

vi.mock('@happier-dev/terminal-native', () => ({
    getTerminalNativeAvailability: () => ({
        available: true,
        platform: 'ios',
        renderer: 'ios-ghosttykit',
        moduleVersion: 'qa',
        accessibility: 'fallback-required',
    }),
    getTerminalNativeQaCapabilities: () => ({ rendererCrashInjection: true }),
    getOptionalHappierTerminalNativeModule: () => null,
    injectTerminalNativeRendererCrashForQa: qaState.injectCrash,
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: vi.fn(async () => true),
}));

vi.mock('@/components/terminal/embedded/EmbeddedTerminalPane.native', () => ({
    EmbeddedTerminalPane: React.forwardRef<unknown, Readonly<{ children?: React.ReactNode }>>((props, _ref) => {
        paneState.props = props;
        return React.createElement('EmbeddedTerminalPane', props, props.children);
    }),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Readonly<{ title?: React.ReactNode; onPress?: () => void }>) => (
        React.createElement('RoundButton', props, props.title)
    ),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Readonly<{ children?: React.ReactNode }>) => React.createElement('Text', props, props.children),
    TextInput: (props: Readonly<{ children?: React.ReactNode }>) => React.createElement('TextInput', props, props.children),
}));

import { TerminalQaScreen } from './TerminalQaScreen.native';

describe('TerminalQaScreen', () => {
    it('fails closed when dev routes are disabled', async () => {
        routeState.enabled = false;
        const screen = await renderScreen(<TerminalQaScreen />);
        expect(screen.tree?.toJSON()).toBeNull();
        routeState.enabled = true;
    });

    it('renders an explicit native-only boundary on web', async () => {
        routeState.enabled = true;
        const { TerminalQaScreen: TerminalQaWebScreen } = await import('./TerminalQaScreen.web');
        const screen = await renderScreen(<TerminalQaWebScreen />);
        expect(screen.tree?.root.findByProps({ testID: 'terminal-qa-native-required' })).toBeTruthy();
    });

    it('mounts the production pane and exposes deterministic integration controls', async () => {
        routeState.enabled = true;
        const screen = await renderScreen(<TerminalQaScreen />);

        const pane = screen.tree?.root.findByType('EmbeddedTerminalPane');
        expect(pane?.props).toMatchObject({
            nativeSurfaceKey: 'terminal-qa-loaded-device',
            testIdPrefix: 'terminal-qa-pane',
            showQuickKeys: true,
            enableNativeRendererQaCrashControl: true,
            nativeRenderer: {
                featureEnabled: true,
                platform: 'ios',
                packageProofAccepted: true,
                crashFallbackAvailable: true,
            },
        });
        expect(pane?.props.nativeRenderer).not.toHaveProperty('accessibilityAccepted');
        expect(pane?.props.controller.status).toBe('connected');
        expect(screen.tree?.root.findByProps({ testID: 'terminal-qa-run-required-workloads' })).toBeTruthy();
        expect(screen.tree?.root.findByProps({ testID: 'terminal-qa-reject-next-write' })).toBeTruthy();
        expect(screen.tree?.root.findByProps({ testID: 'terminal-qa-copy-selection' })).toBeTruthy();
    });

    it('uses canonical settings and native QA APIs rather than bypassing renderer gates', async () => {
        const screen = await renderScreen(<TerminalQaScreen />);

        await act(async () => {
            screen.tree?.root.findByProps({ testID: 'terminal-qa-preference-xterm-webview' }).props.onPress();
            screen.tree?.root.findByProps({ testID: 'terminal-qa-clear-quarantine' }).props.onPress();
            await screen.tree?.root.findByProps({ testID: 'terminal-qa-inject-crash' }).props.onPress();
        });

        expect(settingState.setPreference).toHaveBeenCalledWith('xterm-webview');
        expect(settingState.setQuarantine).toHaveBeenCalledWith(null);
        expect(qaState.injectCrash).toHaveBeenCalledWith(
            'embedded-terminal:ios-ghosttykit:terminal-qa-loaded-device',
        );
    });

    it('drives workload bytes through the pane renderer ref and records ACK evidence', async () => {
        const queuedWrites: Array<Readonly<{
            terminalId: string;
            seq: number;
            byteOffset: number;
            writeGeneration: number;
            bytes: Uint8Array;
        }>> = [];
        const screen = await renderScreen(<TerminalQaScreen />);
        const pane = screen.tree?.root.findByType('EmbeddedTerminalPane');
        const terminalRef = pane?.props.terminalRef as React.MutableRefObject<unknown>;
        terminalRef.current = {
            write: vi.fn(),
            writeBytes: (write: typeof queuedWrites[number]) => {
                queuedWrites.push(write);
                return { status: 'queued' };
            },
            clear: vi.fn(),
        };

        await act(async () => {
            screen.tree?.root.findByProps({ testID: 'terminal-qa-workload-wide-combining' }).props.onPress();
        });
        expect(queuedWrites).toHaveLength(1);
        expect(queuedWrites[0]).toMatchObject({
            terminalId: 'terminal-qa:loaded-device',
            seq: 1,
            byteOffset: 0,
            writeGeneration: 1,
        });

        await act(async () => {
            pane?.props.controller.onWriteComplete({
                terminalId: queuedWrites[0]!.terminalId,
                seq: queuedWrites[0]!.seq,
                byteOffset: 0,
                byteLength: queuedWrites[0]!.bytes.byteLength,
                ackedByteOffset: queuedWrites[0]!.bytes.byteLength,
                writeGeneration: queuedWrites[0]!.writeGeneration,
            });
        });

        const acceptedOffset = screen.tree?.root.findByProps({ testID: 'terminal-qa-accepted-byte-offset' });
        expect(acceptedOffset?.props.value).toBe(String(queuedWrites[0]!.bytes.byteLength));
    });
});
