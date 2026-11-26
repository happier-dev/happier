import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { SessionMediaVideoPreview } from './SessionMediaVideoPreview';

const boundary = vi.hoisted(() => ({ status: 'readyToPlay', listener: null as null | ((event: { status: string }) => void) }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// The decoder is the platform boundary; unsupported VP8/WebM reports error on these devices.
vi.mock('expo-video', async () => {
    const React = await import('react');
    return { VideoView: 'VideoView', useVideoPlayer: (uri: string, setup: (player: unknown) => void) => React.useMemo(() => {
        const player = { status: boundary.status, pause: vi.fn(), addListener: (_: string, listener: typeof boundary.listener) => {
            boundary.listener = listener; return { remove: () => { boundary.listener = null; } };
        } };
        setup(player); return player;
    }, [uri]) };
});
afterEach(async () => { await standardCleanup(); boundary.status = 'readyToPlay'; boundary.listener = null; });

it('replaces an unsupported WebM preview with an unavailable state and plays a new supported source', async () => {
    const screen = await renderScreen(<SessionMediaVideoPreview uri="file:///recording.webm" accessibilityLabel="Recording" />);
    expect(screen.root.findAllByType('VideoView')).toHaveLength(1);
    await act(async () => { boundary.listener?.({ status: 'error' }); });
    expect(screen.findByTestId('session-media-video-cant-play')).not.toBeNull();
    expect(screen.root.findAllByType('VideoView')).toHaveLength(0);
    await screen.update(<SessionMediaVideoPreview uri="file:///recording.mp4" accessibilityLabel="Recording" />);
    expect(screen.findByTestId('session-media-video-cant-play')).toBeNull();
    expect(screen.root.findAllByType('VideoView')).toHaveLength(1);
});
it('shows unavailable when the decoder rejected WebM before subscription', async () => {
    boundary.status = 'error';
    const screen = await renderScreen(<SessionMediaVideoPreview uri="file:///recording.webm" accessibilityLabel="Recording" />);
    expect(screen.findByTestId('session-media-video-cant-play')).not.toBeNull();
    expect(screen.root.findAllByType('VideoView')).toHaveLength(0);
});
it('a rejected recording takes the tile\'s own centred state, with the stage\'s one sentence', async () => {
    const { t } = await import('@/text');
    const screen = await renderScreen(<SessionMediaVideoPreview uri="file:///recording.webm" accessibilityLabel="Recording" />);
    await act(async () => { boundary.listener?.({ status: 'error' }); });
    const state = screen.findByTestId('session-media-video-cant-play');
    expect(state?.props.accessibilityLabel).toBe(t('files.viewer.videoCantPlayTitle'));
    expect(screen.getTextContent()).toBe(t('files.viewer.videoCantPlayTitle'));
});
it('the staged chip form of a rejected recording is the glyph alone, named by the same sentence', async () => {
    const { t } = await import('@/text');
    boundary.status = 'error';
    const screen = await renderScreen(<SessionMediaVideoPreview uri="file:///recording.webm" accessibilityLabel="Recording" form="glyph" />);
    const state = screen.findByTestId('session-media-video-cant-play');
    expect(state?.props.accessibilityLabel).toBe(t('files.viewer.videoCantPlayTitle'));
    expect(screen.getTextContent()).toBe('');
});
