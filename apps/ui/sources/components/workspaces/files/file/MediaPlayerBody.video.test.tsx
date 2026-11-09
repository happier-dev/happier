import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import type { VideoPlayer } from 'expo-video';
import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';

const boundary = vi.hoisted(() => ({ players: [] as Array<{ pause: ReturnType<typeof vi.fn>; released: boolean; status: string; loop: boolean; muted: boolean; staysActiveInBackground: boolean }>, appState: null as null | { emit: (state: 'active' | 'background') => void } }));
const handoff = vi.hoisted(() => vi.fn(async (_input: { fileUri: string; action: string }) => ({ canceled: false })));
vi.mock('@/sync/runtime/files/nativeFileActions', () => ({ performAndroidFileAction: handoff }));
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock({ settleTimingCallbacks: true });
});
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock, createReactNativeAppStateEmitter } = await import('@/dev/testkit/mocks/reactNative');
    const state = createReactNativeAppStateEmitter('active');
    boundary.appState = state;
    const runtime = await createReactNativeNativeMock({ platformOS: 'android' });
    state.install(runtime.AppState);
    return runtime;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
const fileSystem = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('@/dev/testkit/mocks/expoFileSystem').createExpoFileSystemFileMock> }));
vi.mock('expo-file-system', async () => {
    const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    fileSystem.current = createExpoFileSystemFileMock();
    return fileSystem.current.module;
});
vi.mock('expo-video', async () => {
    const React = await import('react');
    return {
        VideoView: (props: Record<string, unknown>) => React.createElement('VideoView', props),
        useVideoPlayer: (uri: string, setup: (player: VideoPlayer) => void) => {
            const player = React.useMemo(() => {
                const value = { pause: vi.fn(), released: false, status: 'readyToPlay', loop: true, muted: true, staysActiveInBackground: true, duration: 4, videoTrack: { size: { width: 1280, height: 720 } }, addListener: () => ({ remove: () => {} }) };
                // Native SDK boundary fixture exposes the playback subset used by this surface.
                setup(value as unknown as VideoPlayer);
                boundary.players.push(value);
                return value;
            }, [uri]);
            React.useEffect(() => () => { player.released = true; }, [player]);
            return player;
        },
    };
});
import { MediaPlayerBody } from './MediaPlayerBody';
import { buildWorkspacePreviewIdentity } from '@/components/ui/media/buildWorkspacePreviewIdentity';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { MediaStage } from '@/components/ui/media/stage/MediaStage';
import { KeyboardShortcutProvider, useKeyboardCommand } from '@/keyboard/KeyboardShortcutProvider';

/** The File page's video source: the workspace file at its stat revision, transfer-owned admission. */
function videoSource(scope: WorkspaceScopeBase, revision: string | null | undefined) {
    return {
        source: { kind: 'workspace' as const, scope, filePath: 'clip.mp4' },
        enabled: true,
        mimeType: 'video/mp4',
        maxBytes: null,
        ...buildWorkspacePreviewIdentity(scope, 'clip.mp4', null, JSON.stringify([revision ?? null])),
    };
}
import { Text } from 'react-native';
import { useWorkspaceFileDetailsLoading } from '../details/workspaceFileDetails/useWorkspaceFileDetailsLoading';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
let harness: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>>;
let currentScreen: Awaited<ReturnType<typeof renderScreen>> | null = null;
async function waitForPlayer(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.root.findAllByType('VideoView'), screen.getTextContent()).toHaveLength(1); });
}
function file(revision = '[12,123]', focused = true, isActive = true, onMediaInfo?: (info: unknown) => void, onVideoControls?: (controls: unknown) => void) {
    return <DestinationInstanceHost tabId="video" ref={{ kind: 'newTab', params: {} }} pathname="/" focused={focused} visible>
        <MediaPlayerBody kind="video" title="clip.mp4" source={videoSource(harness.scope, revision)} isActive={isActive}
            {...(onMediaInfo ? { onMediaInfo } : {})} {...(onVideoControls ? { onVideoControls } : {})} />
    </DestinationInstanceHost>;
}
// Keep retained-details publication, workspace stat routing and encrypted prepared transfer real.
function RefreshedVideo({ snapshotSignature }: Readonly<{ snapshotSignature: string }>) {
    const state = useWorkspaceFileDetailsLoading({
        scope: harness.scope, filePath: 'clip.mp4', diffMode: 'pending',
        includeDiff: false, includeFile: true, isActive: true, snapshotSignature,
        refreshFingerprint: snapshotSignature,
    });
    return <DestinationInstanceHost tabId="video" ref={{ kind: 'newTab', params: {} }} pathname="/" focused visible>
        {state.error ? <Text testID="video-metadata-error">{state.error}</Text> : null}
        {state.fileContent ? <MediaPlayerBody kind="video" title="clip.mp4"
            source={videoSource(harness.scope, state.fileContent.binaryPreviewRevision)} isActive /> : null}
    </DestinationInstanceHost>;
}
beforeEach(async () => {
    harness = await createWorkspaceFileDownloadHarness({ name: 'clip.mp4', bytes: new Uint8Array([1, 2, 3]) });
    // These lifetime tests delete OS fixture files between cases; no cached URI may outlive that fixture.
    const { storage } = await import('@/sync/domains/state/storage');
    storage.getState().applySettingsLocal({ filesImagePreviewCacheMaxEntries: 0 });
    handoff.mockClear();
});
afterEach(async () => { await currentScreen?.unmount(); currentScreen = null; await harness.reset(); boundary.players.length = 0; await act(async () => { boundary.appState?.emit('active'); }); fileSystem.current?.files.clear(); fileSystem.current?.deleteFile.mockClear(); });
describe('workspace file video', () => {
    it('exposes controlled seek on the held player and retires controls when hidden without a playback clock', async () => {
        const onVideoControls = vi.fn();
        const screen = currentScreen = await renderScreen(file('[12,123]', true, true, undefined, onVideoControls));
        await waitForPlayer(screen);
        expect(onVideoControls).toHaveBeenCalledWith(expect.objectContaining({ seekTo: expect.any(Function), readFrame: expect.any(Function) }));
        const controls = onVideoControls.mock.calls.at(-1)![0];
        const player = screen.root.findAllByType('VideoView')[0]!.props.player;
        await act(async () => { controls.seekTo(2); });
        expect(player.currentTime).toBe(2);
        expect(player.timeUpdateEventInterval).toBe(0);
        await screen.update(file('[12,123]', true, true, undefined, onVideoControls));
        await flushHookEffects();
        expect(screen.root.findAllByType('VideoView')[0]!.props.player).toBe(player);
        await screen.update(file('[12,123]', true, false, undefined, onVideoControls));
        await flushHookEffects();
        expect(onVideoControls).toHaveBeenLastCalledWith(null);
        expect(() => controls.seekTo(3)).toThrowError(expect.objectContaining({ name: 'AbortError' }));
    });
    it('reuses the mixed-gallery video body source for handoff and can continue onto the adjacent image', async () => {
        let execute!: ReturnType<typeof useKeyboardCommand>;
        function Controls() { execute = useKeyboardCommand(); return null; }
        const screen = currentScreen = await renderScreen(<DestinationInstanceHost tabId="stage" ref={{ kind: 'newTab', params: {} }} pathname="/" focused visible>
            <KeyboardShortcutProvider handlers={{}}><Controls /><MediaStage initialIndex={0} onClose={() => {}} items={[
                { kind: 'video', title: 'clip.mp4', source: videoSource(harness.scope, 'stage-revision') },
                { kind: 'image', title: 'next.png', source: { enabled: true, source: { kind: 'uri', uri: 'file:///next.png' } } },
            ]} /></KeyboardShortcutProvider>
        </DestinationInstanceHost>);
        await waitForPlayer(screen);
        const original = [...fileSystem.current!.files.keys()][0]!;
        await vi.waitFor(() => expect(screen.findByTestId('media-stage-save')).not.toBeNull());
        await screen.pressByTestIdAsync('media-stage-save');
        await vi.waitFor(() => expect(handoff).toHaveBeenCalled());
        const copy = handoff.mock.calls.at(-1)![0].fileUri;
        expect(copy).not.toBe(original);
        expect(fileSystem.current!.files.get(copy)).toEqual([1, 2, 3]);
        await act(async () => { expect(execute('media.next')).toBe(true); });
        expect(screen.findByTestId('media-stage-image')!.props.source).toEqual({ uri: 'file:///next.png' });
        expect(fileSystem.current!.files.has(copy)).toBe(true);
    });
    it('retains playback through unrelated repository refreshes and reloads the selected same-size file', async () => {
        const screen = currentScreen = await renderScreen(<RefreshedVideo snapshotSignature="snapshot-1" />);
        await waitForPlayer(screen);
        const first = screen.root.findAllByType('VideoView')[0]!.props.player;
        const originalUri = [...fileSystem.current!.files.keys()][0]!;
        await screen.update(<RefreshedVideo snapshotSignature="unrelated-snapshot-2" />);
        await flushHookEffects();
        expect(screen.root.findAllByType('VideoView')[0]!.props.player).toBe(first);
        expect(fileSystem.current!.files.has(originalUri)).toBe(true);
        expect(first.released).toBe(false);
        harness.setStatResponse({ success: true, exists: true, kind: 'file', sizeBytes: 3, modifiedMs: 2 });
        await screen.update(<RefreshedVideo snapshotSignature="selected-file-snapshot-3" />);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.root.findAllByType('VideoView')).toHaveLength(1);
            expect(screen.root.findAllByType('VideoView')[0]!.props.player).not.toBe(first);
        });
        expect(first.released).toBe(true);
        expect(fileSystem.current!.files.has(originalUri)).toBe(false);
        expect([...fileSystem.current!.files.values()]).toEqual([[1, 2, 3]]);
    });
    it.each<Parameters<typeof harness.setStatResponse>[0]>([
        { success: false, error: 'Machine disconnected' },
        { success: true, exists: true, modifiedMs: 2 },
        { success: true, exists: true, sizeBytes: 3 },
    ])('reports unavailable revision metadata, retains playback, then recovers on a valid stat: %j', async (stat) => {
        const screen = currentScreen = await renderScreen(<RefreshedVideo snapshotSignature="snapshot-1" />);
        await waitForPlayer(screen);
        const first = screen.root.findAllByType('VideoView')[0]!.props.player;
        const originalUri = [...fileSystem.current!.files.keys()][0]!;
        harness.setStatResponse(stat);
        await screen.update(<RefreshedVideo snapshotSignature="snapshot-2" />);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findHostByTestId('video-metadata-error')).not.toBeNull();
        });
        expect(screen.root.findAllByType('VideoView')[0]!.props.player).toBe(first);
        expect(first.released).toBe(false);
        expect(fileSystem.current!.files.has(originalUri)).toBe(true);
        harness.setStatResponse({ success: true, exists: true, kind: 'file', sizeBytes: 3, modifiedMs: 2 });
        await screen.update(<RefreshedVideo snapshotSignature="snapshot-3" />);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.root.findAllByType('VideoView')).toHaveLength(1);
            expect(screen.root.findAllByType('VideoView')[0]!.props.player).not.toBe(first);
        });
        expect(screen.findHostByTestId('video-metadata-error')).toBeNull();
        expect(first.released).toBe(true);
        expect(fileSystem.current!.files.has(originalUri)).toBe(false);
        expect([...fileSystem.current!.files.values()]).toEqual([[1, 2, 3]]);
    });
    it('renders interactive native controls and releases only when file identity changes or destination loses focus', async () => {
        const screen = currentScreen = await renderScreen(file());
        await waitForPlayer(screen);
        const views = screen.root.findAllByType('VideoView');
        expect(views).toHaveLength(1);
        expect(views[0]!.props).toMatchObject({ nativeControls: true, fullscreenOptions: { enable: true }, allowsPictureInPicture: false });
        expect(boundary.players[0]).toMatchObject({ loop: false, muted: false, staysActiveInBackground: false });
        const first = boundary.players[0]!;
        await screen.update(file());
        await flushHookEffects();
        expect(boundary.players).toHaveLength(1);
        await screen.update(file('[12,456]'));
        await waitForPlayer(screen);
        expect(first.pause).toHaveBeenCalled();
        expect(first.released).toBe(true);
        expect(boundary.players).toHaveLength(2);
        await screen.update(file('[12,456]', false));
        await flushHookEffects();
        expect(screen.root.findAllByType('VideoView')).toHaveLength(0);
        expect(boundary.players[1]!.released).toBe(true);
        expect(fileSystem.current!.files.size).toBe(0);
    });
    it('tells the page the length and frame size once the player has loaded the video (P2 media facts, lab FV6)', async () => {
        const onMediaInfo = vi.fn();
        const screen = currentScreen = await renderScreen(file('[12,123]', true, true, onMediaInfo));
        await waitForPlayer(screen);
        await vi.waitFor(() => expect(onMediaInfo).toHaveBeenLastCalledWith({ durationSeconds: 4, width: 1280, height: 720 }));
    });
    it('aborts an inactive preview and disposes a late transfer result without mounting a player', async () => {
        const pending = harness.deferNextChunk();
        const screen = currentScreen = await renderScreen(file());
        await act(async () => { await pending.entered; });
        const chunk = harness.requests.find((request) => request.url.endsWith('/chunks/0'));
        await screen.update(file('[12,123]', true, false));
        expect(chunk?.signal?.aborted).toBe(true);
        await act(async () => { pending.release(); });
        await vi.waitFor(async () => { await flushHookEffects(); expect(fileSystem.current!.files.size).toBe(0); });
        expect(screen.root.findAllByType('VideoView')).toHaveLength(0);
        expect(fileSystem.current!.files.size).toBe(0);
    });
    it('keeps the Android fullscreen player through React Activity pause, then stops on destination blur', async () => {
        const screen = currentScreen = await renderScreen(file());
        await waitForPlayer(screen);
        const view = screen.root.findAllByType('VideoView')[0];
        expect(view).toBeDefined();
        await act(async () => { view!.props.onFullscreenEnter(); boundary.appState?.emit('background'); });
        expect(screen.root.findAllByType('VideoView')).toHaveLength(1);
        await screen.update(file('[12,123]', false));
        await flushHookEffects();
        expect(screen.root.findAllByType('VideoView')).toHaveLength(0);
        expect(boundary.players[0]!.pause).toHaveBeenCalled();
    });
    it('releases inline playback when the app backgrounds and reloads when viewed again', async () => {
        const screen = currentScreen = await renderScreen(file());
        await waitForPlayer(screen);
        const player = boundary.players[0]!;
        await act(async () => { boundary.appState?.emit('background'); });
        await flushHookEffects();
        expect(screen.root.findAllByType('VideoView')).toHaveLength(0);
        expect(player.pause).toHaveBeenCalled();
        expect(player.released).toBe(true);
        await act(async () => { boundary.appState?.emit('active'); });
        await waitForPlayer(screen);
        expect(screen.root.findAllByType('VideoView')).toHaveLength(1);
        expect(boundary.players).toHaveLength(2);
    });
    it('offers a retry after a failed transfer and loads the retried file', async () => {
        harness.failNextChunk();
        const screen = currentScreen = await renderScreen(file());
        await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findHostByTestId('file-video-error')).not.toBeNull(); });
        expect(screen.findHostByTestId('file-video-error')).not.toBeNull();
        await screen.pressByTestIdAsync('file-video-retry');
        await waitForPlayer(screen);
        expect(screen.root.findAllByType('VideoView')).toHaveLength(1);
        expect(screen.findHostByTestId('file-video-error')).toBeNull();
    });

});
