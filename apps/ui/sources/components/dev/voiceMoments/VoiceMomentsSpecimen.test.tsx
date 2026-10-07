import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import { VoiceMomentsSpecimen } from './VoiceMomentsSpecimen';

// Native rendering and theme resolution are system boundaries; the specimen and app Text stay real.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const { darkTheme } = await import('@/theme');
    return createUnistylesMock({ theme: darkTheme, rt: { themeName: 'dark', colorScheme: 'dark' } });
});

// External enriched-markdown animation SDK: the specimen only needs still request text.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (input: { text: string; startOffset: number }) => [{ ...input, animated: false }],
}));

const initialState = storage.getState();

// These rendered theme colors are opaque hex values. Measure legibility, not a chosen token identity.
function luminance(color: string): number {
    if (!/^#[\da-f]{6}$/i.test(color)) throw new Error(`Expected an opaque rendered color: ${color}`);
    const channels = [1, 3, 5].map((offset) => {
        const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

let screen: RenderScreenResult | null = null;
afterEach(async () => {
    await screen?.unmount();
    screen = null;
    storage.setState(initialState);
});

describe('Voice moments dev-only fixtures', () => {
    it('keeps the controller-missing notice readable on its painted dark canvas', async () => {
        screen = await renderScreen(<VoiceMomentsSpecimen frame="H1" />);
        const notice = screen.findAll((node) => typeof node.type === 'string'
            && String(node.type) === 'Text'
            && typeof node.props.children === 'string'
            && node.props.children.includes('Hold requires a connected Voice controller'))[0];
        expect(notice).toBeDefined();
        expect(screen.findByTestId('dev-voice-moments')).toBeNull();
        // Native Text has black default ink, not automatic theme inheritance from its enclosing View.
        const foreground = StyleSheet.flatten(notice.props.style)?.color ?? '#000000';
        let ancestor = notice.parent;
        let background: string | undefined;
        while (ancestor && !background) {
            background = StyleSheet.flatten(ancestor.props.style)?.backgroundColor;
            ancestor = ancestor.parent;
        }
        expect(background).toBeDefined();
        const ink = luminance(foreground);
        const canvas = luminance(background!);
        expect((Math.max(ink, canvas) + 0.05) / (Math.min(ink, canvas) + 0.05)).toBeGreaterThanOrEqual(4.5);
    });

    it('shows the ended pending request through the real captured Account and cleans only its own data', async () => {
        storage.setState({ profileScope: { serverId: getActiveServerSnapshot().serverId, accountId: 'dev-account' } });
        const sessionsBefore = storage.getState().sessions;
        const messagesBefore = storage.getState().sessionMessages;

        screen = await renderScreen(<VoiceMomentsSpecimen frame="POSTEND" />);
        expect(screen.findByTestId('dev-voice-moments-ended-pending.review')).not.toBeNull();
        const specimen = Object.values(storage.getState().sessions).find((session) => !sessionsBefore[session.id]);
        expect(specimen?.access?.capabilities.approveRuntimePermissions).toBe(false);

        await screen.unmount();
        screen = null;
        expect(storage.getState().sessions).toEqual(sessionsBefore);
        expect(storage.getState().sessionMessages).toEqual(messagesBefore);
    });

    it('draws the real N1 request card with approval denied rather than a live permission transport', async () => {
        screen = await renderScreen(<VoiceMomentsSpecimen frame="N1" />);
        expect(screen.findByTestId('permission-prompt-card')).not.toBeNull();
        expect(screen.findByTestId('permission-footer.allow')).toBeNull();
        expect(screen.getTextContent()).toContain('git status');
    });
});
