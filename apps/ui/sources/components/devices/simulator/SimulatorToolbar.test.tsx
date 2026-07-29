import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('SimulatorToolbar', () => {
    it('renders primary controls as icon buttons with product labels instead of text-pill jargon', async () => {
        const mod = await import('./SimulatorToolbar').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorToolbar');
        if (!('SimulatorToolbar' in mod)) return;

        const SimulatorToolbar = mod.SimulatorToolbar as React.ComponentType<{
            viewModel: unknown;
            actions: Record<string, () => void>;
            testID: string;
        }>;
        const screen = await renderScreen(
            <SimulatorToolbar
                viewModel={{
                    kind: 'selected',
                    lease: { state: 'held-by-me', holderLabel: 'You', expiresAtMs: 32_000 },
                    controls: {
                        canWatch: true,
                        canControl: true,
                        canRequestKeyframe: true,
                        canRequestSnapshot: true,
                        canSetQuality: true,
                        canSetFps: true,
                        canSetScale: true,
                        supportedInputKinds: ['tap', 'orientation', 'hardware_button'],
                    },
                }}
                actions={{
                    releaseLease: vi.fn(),
                    renewLease: vi.fn(),
                    requestKeyframe: vi.fn(),
                    requestSnapshot: vi.fn(),
                    lowerQuality: vi.fn(),
                    setFps: vi.fn(),
                    setScale: vi.fn(),
                    rotateLeft: vi.fn(),
                    pressHome: vi.fn(),
                    pressBack: vi.fn(),
                    pressRecent: vi.fn(),
                    pressVolumeUp: vi.fn(),
                    pressVolumeDown: vi.fn(),
                }}
                testID="simulator-toolbar"
            />,
        );

        expect(screen.findByTestId('simulator-toolbar-request-keyframe-icon')).toBeTruthy();
        expect(screen.findByTestId('simulator-toolbar-overflow')).toBeTruthy();
        expect(screen.findByTestId('simulator-toolbar-quality')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('streamPlayer.actions.requestKeyframe');
        expect(screen.getTextContent()).not.toContain('simulatorPreview.toolbar.fps');
        expect(screen.getTextContent()).not.toContain('simulatorPreview.toolbar.scale');
    });

    it('routes lease, snapshot, keyframe, quality, orientation, and button actions through props', async () => {
        const mod = await import('./SimulatorToolbar').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorToolbar');
        if (!('SimulatorToolbar' in mod)) return;

        const SimulatorToolbar = mod.SimulatorToolbar as React.ComponentType<{
            viewModel: unknown;
            actions: Record<string, () => void>;
            testID: string;
        }>;
        const actions = {
            acquireLease: vi.fn(),
            releaseLease: vi.fn(),
            renewLease: vi.fn(),
            requestKeyframe: vi.fn(),
            requestSnapshot: vi.fn(),
            lowerQuality: vi.fn(),
            setFps: vi.fn(),
            setScale: vi.fn(),
            rotateLeft: vi.fn(),
            pressHome: vi.fn(),
            pressBack: vi.fn(),
            pressRecent: vi.fn(),
            pressVolumeUp: vi.fn(),
            pressVolumeDown: vi.fn(),
        };

        const screen = await renderScreen(
            <SimulatorToolbar
                viewModel={{
                    kind: 'selected',
                    lease: { state: 'held-by-me' },
                    controls: {
                        canWatch: true,
                        canControl: true,
                        canRequestKeyframe: true,
                        canRequestSnapshot: true,
                        canSetQuality: true,
                        canSetFps: true,
                        canSetScale: true,
                        supportedInputKinds: ['tap', 'orientation', 'hardware_button'],
                    },
                }}
                actions={actions}
                testID="simulator-toolbar"
            />,
        );

        screen.pressByTestId('simulator-toolbar-request-keyframe');
        screen.pressByTestId('simulator-toolbar-request-snapshot');
        screen.pressByTestId('simulator-toolbar-lower-quality');
        screen.pressByTestId('simulator-toolbar-set-fps');
        screen.pressByTestId('simulator-toolbar-set-scale');
        await screen.pressByTestIdAsync('simulator-toolbar-overflow');
        screen.pressByTestId('simulator-toolbar-release-lease');
        screen.pressByTestId('simulator-toolbar-renew-lease');
        screen.pressByTestId('simulator-toolbar-rotate-left');
        screen.pressByTestId('simulator-toolbar-button-home');
        screen.pressByTestId('simulator-toolbar-button-back');
        screen.pressByTestId('simulator-toolbar-button-recent');
        screen.pressByTestId('simulator-toolbar-button-volume-up');
        screen.pressByTestId('simulator-toolbar-button-volume-down');

        expect(actions.releaseLease).toHaveBeenCalledTimes(1);
        expect(actions.renewLease).toHaveBeenCalledTimes(1);
        expect(actions.requestKeyframe).toHaveBeenCalledTimes(1);
        expect(actions.requestSnapshot).toHaveBeenCalledTimes(1);
        expect(actions.lowerQuality).toHaveBeenCalledTimes(1);
        expect(actions.setFps).toHaveBeenCalledTimes(1);
        expect(actions.setScale).toHaveBeenCalledTimes(1);
        expect(actions.rotateLeft).toHaveBeenCalledTimes(1);
        expect(actions.pressHome).toHaveBeenCalledTimes(1);
        expect(actions.pressBack).toHaveBeenCalledTimes(1);
        expect(actions.pressRecent).toHaveBeenCalledTimes(1);
        expect(actions.pressVolumeUp).toHaveBeenCalledTimes(1);
        expect(actions.pressVolumeDown).toHaveBeenCalledTimes(1);
    });

    it('disables input-only controls when the viewer does not hold the control lease', async () => {
        const mod = await import('./SimulatorToolbar').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorToolbar');
        if (!('SimulatorToolbar' in mod)) return;

        const SimulatorToolbar = mod.SimulatorToolbar as React.ComponentType<{
            viewModel: unknown;
            actions: Record<string, () => void>;
            testID: string;
        }>;
        const screen = await renderScreen(
            <SimulatorToolbar
                viewModel={{
                    kind: 'selected',
                    lease: { state: 'available' },
                    controls: {
                        canWatch: true,
                        canControl: false,
                        canRequestKeyframe: true,
                        canRequestSnapshot: true,
                        canSetQuality: true,
                        canSetFps: true,
                        canSetScale: true,
                        supportedInputKinds: ['orientation', 'hardware_button'],
                    },
                }}
                actions={{
                    acquireLease: vi.fn(),
                    rotateLeft: vi.fn(),
                    pressHome: vi.fn(),
                    requestKeyframe: vi.fn(),
                    requestSnapshot: vi.fn(),
                    lowerQuality: vi.fn(),
                    setFps: vi.fn(),
                    setScale: vi.fn(),
                }}
                testID="simulator-toolbar"
            />,
        );

        expect(screen.findByTestId('simulator-toolbar-acquire-lease')?.props.accessibilityState?.disabled).toBe(false);
        expect(screen.findByTestId('simulator-toolbar-rotate-left')).toBeNull();
        expect(screen.findByTestId('simulator-toolbar-button-home')).toBeNull();
        expect(screen.findByTestId('simulator-toolbar-request-keyframe')?.props.accessibilityState?.disabled).toBe(false);
    });

    it('hides unbacked keyframe and snapshot controls on a watchable simulator', async () => {
        const mod = await import('./SimulatorToolbar').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorToolbar');
        if (!('SimulatorToolbar' in mod)) return;

        const SimulatorToolbar = mod.SimulatorToolbar as React.ComponentType<{
            viewModel: unknown;
            actions: Record<string, () => void>;
            testID: string;
        }>;
        const actions = {
            requestKeyframe: vi.fn(),
            requestSnapshot: vi.fn(),
            lowerQuality: vi.fn(),
            setFps: vi.fn(),
            setScale: vi.fn(),
        };
        const screen = await renderScreen(
            <SimulatorToolbar
                viewModel={{
                    kind: 'selected',
                    lease: { state: 'held-by-me' },
                    controls: {
                        canWatch: true,
                        canControl: true,
                        canRequestKeyframe: false,
                        canRequestSnapshot: false,
                        canSetQuality: false,
                        canSetFps: false,
                        canSetScale: false,
                        supportedInputKinds: ['tap', 'keyboard_text', 'hardware_button'],
                    },
                }}
                actions={actions}
                testID="simulator-toolbar"
            />,
        );

        // Permanently-unbacked controls are HIDDEN, mirroring the fps/scale/quality
        // hide pattern — not rendered greyed-out. This keeps the toolbar from
        // advertising verbs the resource never honors (capability-truth).
        expect(screen.findByTestId('simulator-toolbar-request-keyframe')).toBeNull();
        expect(screen.findByTestId('simulator-toolbar-request-snapshot')).toBeNull();
        expect(screen.findByTestId('simulator-toolbar-lower-quality')).toBeNull();
        expect(screen.findByTestId('simulator-toolbar-set-fps')).toBeNull();
        expect(screen.findByTestId('simulator-toolbar-set-scale')).toBeNull();
    });

    it('renders backed keyframe and snapshot as transient-disabled when the stream is not watchable', async () => {
        const mod = await import('./SimulatorToolbar').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorToolbar');
        if (!('SimulatorToolbar' in mod)) return;

        const SimulatorToolbar = mod.SimulatorToolbar as React.ComponentType<{
            viewModel: unknown;
            actions: Record<string, () => void>;
            testID: string;
        }>;
        const actions = {
            requestKeyframe: vi.fn(),
            requestSnapshot: vi.fn(),
        };
        const screen = await renderScreen(
            <SimulatorToolbar
                viewModel={{
                    kind: 'selected',
                    lease: { state: 'available' },
                    controls: {
                        canWatch: false,
                        canControl: false,
                        canRequestKeyframe: true,
                        canRequestSnapshot: true,
                        canSetQuality: false,
                        canSetFps: false,
                        canSetScale: false,
                        supportedInputKinds: ['tap'],
                    },
                }}
                actions={actions}
                testID="simulator-toolbar"
            />,
        );

        // Backed-but-transiently-blocked: the control stays VISIBLE (the resource
        // backs it) but disabled-with-reason because the viewer cannot watch yet.
        expect(screen.findByTestId('simulator-toolbar-request-keyframe')?.props.disabled).toBe(true);
        expect(screen.findByTestId('simulator-toolbar-request-snapshot')?.props.disabled).toBe(true);
        screen.pressByTestId('simulator-toolbar-request-keyframe');
        screen.pressByTestId('simulator-toolbar-request-snapshot');
        expect(actions.requestKeyframe).not.toHaveBeenCalled();
        expect(actions.requestSnapshot).not.toHaveBeenCalled();
    });

    it('does not expose fps or scale controls from generic quality support', async () => {
        const mod = await import('./SimulatorToolbar').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorToolbar');
        if (!('SimulatorToolbar' in mod)) return;

        const SimulatorToolbar = mod.SimulatorToolbar as React.ComponentType<{
            viewModel: unknown;
            actions: Record<string, () => void>;
            testID: string;
        }>;
        const actions = {
            lowerQuality: vi.fn(),
            setFps: vi.fn(),
            setScale: vi.fn(),
        };
        const screen = await renderScreen(
            <SimulatorToolbar
                viewModel={{
                    kind: 'selected',
                    lease: { state: 'held-by-me' },
                    controls: {
                        canWatch: true,
                        canControl: true,
                        canRequestKeyframe: false,
                        canRequestSnapshot: false,
                        canSetQuality: true,
                        canSetFps: false,
                        canSetScale: false,
                        supportedInputKinds: ['tap'],
                    },
                }}
                actions={actions}
                testID="simulator-toolbar"
            />,
        );

        expect(screen.findByTestId('simulator-toolbar-lower-quality')?.props.accessibilityState?.disabled).toBe(false);
        expect(screen.findByTestId('simulator-toolbar-set-fps')).toBeNull();
        expect(screen.findByTestId('simulator-toolbar-set-scale')).toBeNull();
    });
});
