import * as React from 'react';
import { View } from 'react-native';
import {
  useVideoPlayer,
  VideoView,
  type VideoPlayer as ExpoVideoPlayer,
  type VideoPlayerStatus,
} from 'expo-video';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';

import type { FilePageMediaInfo } from './filePageMediaFacts';
import { readVideoFrame, type MediaPlayerVideoControls } from './videoFrameAccess';

const FULLSCREEN_OPTIONS = { enable: true } as const;

export type HeldVideoPlayerSlot = React.MutableRefObject<Readonly<{
  pause: () => void;
}> | null>;

export function HeldVideoPlayer(
  props: Readonly<{
    uri: string;
    title: string;
    isActive: boolean;
    slot?: HeldVideoPlayerSlot;
    /** `none` hands the transport to the host: the Capture window's timeline drives this player. */
    chrome?: 'native' | 'none';
    onFullscreenChange?: (fullscreen: boolean) => void;
    onError: (message: string) => void;
    onMediaInfo?: (info: FilePageMediaInfo) => void;
    onVideoControls?: (controls: MediaPlayerVideoControls | null) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const view = React.useRef<VideoView>(null);
  const player = useVideoPlayer(props.uri, (instance) => {
    instance.loop = false;
    instance.muted = false;
    instance.staysActiveInBackground = false;
    instance.allowsExternalPlayback = false;
    instance.timeUpdateEventInterval = 0;
  });
  const [status, setStatus] = React.useState<VideoPlayerStatus>(player.status);
  const { onError, onMediaInfo, slot } = props;
  const { onVideoControls } = props;
  React.useLayoutEffect(() => {
    if (!onVideoControls) return;
    const lifetime = new AbortController();
    // A host-controlled transport publishes intent. Decoder play/pause used to
    // present canvas pixels is private to frame access, not an editor command.
    const listeners = new Set<(playing: boolean) => void>();
    let playing = false;
    const publishIntent = (intent: boolean) => { playing = intent; for (const listener of listeners) listener(intent); };
    const ended = props.chrome === 'none' ? player.addListener('playToEnd', () => publishIntent(false)) : null;
    onVideoControls({
      seekTo: (timeSeconds) => {
        lifetime.signal.throwIfAborted();
        player.currentTime = timeSeconds;
      },
      readFrame: async (options = {}) => {
        lifetime.signal.throwIfAborted();
        // Expo's web VideoView exposes its HTMLVideoElement through this public ref.
        const element: unknown = view.current?.nativeRef.current;
        if (typeof HTMLVideoElement === 'undefined' || !(element instanceof HTMLVideoElement)) {
          throw new DOMException('Canvas frame access requires the web player.', 'NotSupportedError');
        }
        return readVideoFrame(element, options, lifetime.signal, props.chrome === 'none'
          ? () => { if (playing) player.play(); else player.pause(); } : undefined);
      },
      playback: {
        play: () => { player.play(); if (props.chrome === 'none') publishIntent(true); },
        pause: () => { player.pause(); if (props.chrome === 'none') publishIntent(false); },
        readTime: () => player.currentTime,
        subscribe: (listener) => {
          if (props.chrome === 'none') {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
          }
          const subscription = player.addListener('playingChange', (event) => listener(event.isPlaying));
          return () => subscription.remove();
        },
      },
    });
    return () => { lifetime.abort(); ended?.remove(); listeners.clear(); onVideoControls(null); };
  }, [onVideoControls, player, props.chrome]);
  React.useEffect(() => {
    const subscription = player.addListener('statusChange', (event) => {
      setStatus(event.status);
      if (event.status === 'error')
        onError(event.error?.message || 'video_decode_failed');
    });
    setStatus(player.status);
    if (player.status === 'error') onError('video_decode_failed');
    return () => subscription.remove();
  }, [onError, player]);
  // Once loaded, the player knows the length; the frame size only where the platform reports its track (not web).
  React.useEffect(() => {
    if (status !== 'readyToPlay' || !onMediaInfo) return;
    const durationSeconds = player.duration;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
    const size = player.videoTrack?.size;
    onMediaInfo(size && size.width > 0 && size.height > 0
      ? { durationSeconds, width: size.width, height: size.height }
      : { durationSeconds });
  }, [onMediaInfo, player, status]);
  const pause = React.useCallback(
    (target: ExpoVideoPlayer = player) => {
      try {
        target.pause();
      } catch {
        /* The native handle may already be released. */
      }
    },
    [player],
  );
  React.useLayoutEffect(() => {
    if (slot) slot.current = { pause: () => pause() };
    // Stop before expo-video releases the native player on unmount.
    return () => {
      if (slot) slot.current = null;
      pause();
    };
  }, [pause, slot]);
  useKeyboardShortcutHandlers(
    props.isActive && props.chrome !== 'none'
      ? {
          'media.playPause': () => {
            if (player.playing) pause();
            else player.play();
          },
        }
      : {},
  );
  return (
    <>
      <VideoView
        ref={view}
        testID="file-video-player"
        player={player}
        nativeControls={props.chrome !== 'none'}
        fullscreenOptions={FULLSCREEN_OPTIONS}
        allowsPictureInPicture={false}
        onFullscreenEnter={() => props.onFullscreenChange?.(true)}
        onFullscreenExit={() => props.onFullscreenChange?.(false)}
        contentFit="contain"
        style={VIDEO_FILL}
        accessibilityLabel={props.title}
      />
      {status === 'loading' || status === 'idle' ? (
        <View
          style={[StyleSheet.absoluteFill, styles.centre]}
          pointerEvents="none"
        >
          <Icon
            name="video-camera"
            size={24}
            color={theme.colors.text.tertiary}
          />
        </View>
      ) : null}
    </>
  );
}

/**
 * The player fills its well. A plain style on purpose: on web `VideoView` spreads `style` straight onto the
 * `<video>` element, where a Unistyles entry does not apply, so the element kept its natural 1280 × 720 and
 * ran past the well (its controls off-screen at 390).
 */
const VIDEO_FILL = { width: '100%', height: '100%' } as const;

const styles = StyleSheet.create(() => ({
  centre: {
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
