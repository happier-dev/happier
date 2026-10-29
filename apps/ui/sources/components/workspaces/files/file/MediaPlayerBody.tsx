import * as React from 'react';
import { View } from 'react-native';
import {
  useVideoPlayer,
  VideoView,
  type VideoPlayer as ExpoVideoPlayer,
  type VideoPlayerStatus,
} from 'expo-video';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { Slider } from '@/components/ui/forms/Slider';
import { Icon } from '@/components/ui/icons/Icon';
import { MediaDownloadLine, MediaLoadStoppedState } from '@/components/ui/media/MediaDownloadProgress';
import {
  useFilePreviewSource,
  type UseFilePreviewSourceInput,
  type FilePreviewSourceState,
} from '@/components/ui/media/useFilePreviewSource';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { formatPlaybackTime, type FilePageMediaInfo } from './filePageMediaFacts';
import { useFileAudioPlayer } from './useFileAudioPlayer';
import { useMediaPlaybackLifecycle } from './useMediaPlaybackLifecycle';

/** Audio scrub step for the arrow keys (lab files FV6a: ←/→ seek 5 s). */
const AUDIO_SEEK_STEP_SECONDS = 5;

export type MediaPlayerBodyProps = Readonly<{
  kind: 'video' | 'audio';
  title: string;
  source: UseFilePreviewSourceInput;
  isActive: boolean;
  /** The length (and a video's frame) once the player has loaded the file: the page writes them in its meta row. */
  onMediaInfo?: (info: FilePageMediaInfo) => void;
  onDownload?: () => void;
  onOpenInDefaultApp?: () => void;
  /** The stage reuses the body's held bytes for handoff; it never starts another materializer. */
  onPreviewChange?: (preview: FilePreviewSourceState) => void;
  testID?: string;
}>;


function CantPlayState(
  props: Readonly<{
    kind: 'video' | 'audio';
    error: string;
    onDownload?: () => void;
    onOpenInDefaultApp?: () => void;
  }>,
) {
  return (
    <SurfaceStateCard
      testID={`file-${props.kind}-cant-play`}
      kind="unavailable"
      size="pane"
      title={
        props.kind === 'video'
          ? t('files.viewer.videoCantPlayTitle')
          : t('files.viewer.audioCantPlayTitle')
      }
      reason={t('files.viewer.mediaCantPlayBody')}
      diagnosticCode={props.error}
      {...(props.onDownload
        ? {
            action: {
              label: t('files.viewer.download'),
              onPress: props.onDownload,
            },
          }
        : {})}
      {...(props.onOpenInDefaultApp
        ? {
            secondaryAction: {
              label: t('files.viewer.openInDefaultApp'),
              onPress: props.onOpenInDefaultApp,
            },
          }
        : {})}
    />
  );
}

type PlayerSlot = React.MutableRefObject<Readonly<{
  pause: () => void;
}> | null>;

function VideoPlayer(
  props: Readonly<{
    uri: string;
    title: string;
    isActive: boolean;
    slot: PlayerSlot;
    onFullscreenChange: (fullscreen: boolean) => void;
    onError: (message: string) => void;
    onMediaInfo?: (info: FilePageMediaInfo) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const player = useVideoPlayer(props.uri, (instance) => {
    instance.loop = false;
    instance.muted = false;
    instance.staysActiveInBackground = false;
    instance.allowsExternalPlayback = false;
    instance.timeUpdateEventInterval = 0;
  });
  const [status, setStatus] = React.useState<VideoPlayerStatus>(player.status);
  const { onError, onMediaInfo, slot } = props;
  React.useEffect(() => {
    const subscription = player.addListener('statusChange', (event) => {
      setStatus(event.status);
      if (event.status === 'error')
        onError(event.error?.message || 'video_decode_failed');
    });
    setStatus(player.status);
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
    slot.current = { pause: () => pause() };
    // Stop before expo-video releases the native player on unmount.
    return () => {
      slot.current = null;
      pause();
    };
  }, [pause, slot]);
  useKeyboardShortcutHandlers(
    props.isActive
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
        testID="file-video-player"
        player={player}
        nativeControls
        fullscreenOptions={FULLSCREEN_OPTIONS}
        allowsPictureInPicture={false}
        onFullscreenEnter={() => props.onFullscreenChange(true)}
        onFullscreenExit={() => props.onFullscreenChange(false)}
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

const FULLSCREEN_OPTIONS = { enable: true } as const;

function AudioRow(
  props: Readonly<{
    uri: string;
    title: string;
    isActive: boolean;
    onError: (message: string) => void;
    onMediaInfo?: (info: FilePageMediaInfo) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const audio = useFileAudioPlayer({
    uri: props.uri,
    isActive: props.isActive,
  });
  const { onError, onMediaInfo } = props;
  React.useEffect(() => {
    if (audio.error) onError(audio.error);
  }, [audio.error, onError]);
  const loadedDuration = audio.status === 'ready' && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
  React.useEffect(() => {
    if (loadedDuration !== null) onMediaInfo?.({ durationSeconds: loadedDuration });
  }, [loadedDuration, onMediaInfo]);
  const toggle = React.useCallback(() => {
    if (audio.playing) audio.pause();
    else void audio.play();
  }, [audio]);
  useKeyboardShortcutHandlers(
    props.isActive
      ? {
          'media.playPause': toggle,
          'media.previous': () => {
            void audio.seekBy(-AUDIO_SEEK_STEP_SECONDS);
          },
          'media.next': () => {
            void audio.seekBy(AUDIO_SEEK_STEP_SECONDS);
          },
        }
      : {},
  );
  const ready = audio.status === 'ready';
  return (
    <View
      style={styles.audioRow}
      accessibilityLabel={props.title}
      testID="file-audio-player"
    >
      <PrimaryCircleIconButton
        active={ready}
        disabled={!ready || !audio.playbackAllowed}
        loading={audio.status === 'loading'}
        accessibilityLabel={
          audio.playing ? t('files.viewer.pause') : t('files.viewer.play')
        }
        onPress={toggle}
        testID="file-audio-play"
      >
        <Icon
          name={audio.playing ? 'pause-circle' : 'play'}
          size={18}
          color={
            theme.colors.button?.primary?.tint ?? theme.colors.text.primary
          }
        />
      </PrimaryCircleIconButton>
      <Text
        variant="meta"
        emphasis="medium"
        style={[
          styles.time,
          { color: theme.colors.text.primary },
          Typography.tabular(),
        ]}
      >
        {formatPlaybackTime(audio.currentTime)}
      </Text>
      <View style={styles.scrubber}>
        <Slider
          value={audio.currentTime}
          min={0}
          max={Math.max(1, audio.duration)}
          step={1}
          disabled={!ready}
          onValueChange={(next) => {
            void audio.seekTo(next);
          }}
          onValuePreview={(next) => { if (next !== undefined) void audio.seekTo(next); }}
          accessibilityLabel={t('files.viewer.playbackPosition')}
          formatValueText={(value) =>
            `${formatPlaybackTime(value)} / ${formatPlaybackTime(audio.duration)}`
          }
        />
      </View>
      <Text
        variant="meta"
        style={[
          styles.time,
          { color: theme.colors.text.secondary },
          Typography.tabular(),
        ]}
      >
        {formatPlaybackTime(audio.duration)}
      </Text>
    </View>
  );
}

/**
 * Video and audio bodies (P2 §3.8, lab files FV6/FV6a/FV6e): one player per body. Bytes load and the
 * player exists only while the destination is viewed (focus, host visibility, Android fullscreen); a
 * blur or background releases both. Video sits in a 16:9 well with native controls; audio is one row.
 */
export function MediaPlayerBody(props: MediaPlayerBodyProps) {
  const { theme } = useUnistyles();
  const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
  const [playbackError, setPlaybackError] = React.useState<string | null>(null);
  const [fullscreen, setFullscreen] = React.useState(false);
  // Cancel stops the transfer (its last consumer releases the shared fill) until the person loads again.
  const [stopped, setStopped] = React.useState(false);
  const phone = useDeviceType() === 'phone';
  const slot = React.useRef<Readonly<{ pause: () => void }> | null>(null);
  const pause = React.useCallback(() => slot.current?.pause(), []);
  const lifecycle = useMediaPlaybackLifecycle({
    isActive: props.isActive,
    isFullscreen: fullscreen,
    pause,
  });
  React.useEffect(() => {
    if (!props.isActive) setFullscreen(false);
  }, [props.isActive]);
  const preview = useFilePreviewSource({
    ...props.source,
    enabled: props.source.enabled && lifecycle.enabled && !stopped,
    // A retry asks for fresh bytes; the first attempt keeps the page's identity so cached bytes are reused.
    cacheKey:
      props.source.cacheKey != null && attempt > 0
        ? `${props.source.cacheKey}:retry:${attempt}`
        : props.source.cacheKey,
  });
  React.useEffect(() => setPlaybackError(null), [attempt, preview.uri]);
  React.useEffect(() => {
    props.onPreviewChange?.(preview);
  }, [props.onPreviewChange, preview.status, preview.uri, preview.error]);
  if (!lifecycle.enabled)
    return <View testID={props.testID} style={styles.page} />;
  if (stopped) {
    return (
      <View testID={props.testID} style={styles.page}>
        <MediaLoadStoppedState
          testID={`file-${props.kind}-stopped`}
          title={props.title}
          onLoadAgain={() => setStopped(false)}
          {...(props.onDownload
            ? { handoff: { label: t('files.viewer.download'), onPress: props.onDownload } }
            : {})}
        />
      </View>
    );
  }
  const downloading =
    preview.status === 'loading' && preview.progress ? (
      <MediaDownloadLine
        testID={`file-${props.kind}-downloading`}
        progress={preview.progress}
        compact={phone}
        onCancel={() => setStopped(true)}
      />
    ) : null;

  const body = playbackError ? (
    <CantPlayState
      kind={props.kind}
      error={playbackError}
      onDownload={props.onDownload}
      onOpenInDefaultApp={props.onOpenInDefaultApp}
    />
  ) : preview.status === 'error' ? (
    <SurfaceStateCard
      testID={`file-${props.kind}-error`}
      kind="error"
      size="pane"
      title={t('files.viewer.loadFailed', { name: props.title })}
      diagnosticCode={preview.error}
      action={{
        label: t('common.retry'),
        onPress: retry,
        testID: `file-${props.kind}-retry`,
      }}
    />
  ) : preview.status === 'loaded' ? (
    props.kind === 'video' ? (
      <VideoPlayer
        key={preview.uri}
        uri={preview.uri}
        title={props.title}
        isActive={props.isActive}
        slot={slot}
        onFullscreenChange={setFullscreen}
        onError={setPlaybackError}
        onMediaInfo={props.onMediaInfo}
      />
    ) : (
      <AudioRow
        key={preview.uri}
        uri={preview.uri}
        title={props.title}
        isActive={props.isActive}
        onError={setPlaybackError}
        onMediaInfo={props.onMediaInfo}
      />
    )
  ) : downloading ? (
    // Video: the well waits empty and the line names the bytes beneath it (lab FV6d); audio: the row is the line.
    props.kind === 'audio' ? (
      <View style={styles.audioDownload}>{downloading}</View>
    ) : null
  ) : (
    <SurfaceStateCard
      testID={`file-${props.kind}-loading`}
      kind="loading"
      size="line"
      title={t('surfaceState.opening', { name: props.title })}
    />
  );
  // A failed or unplayable file is a page state (lab FV6e): it stands on the page, not inside the player's frame.
  const failed = Boolean(playbackError) || preview.status === 'error';
  return (
    // A phone video runs the full width with no side insets (lab FV6 spec); its downloading line keeps the gutter.
    <View testID={props.testID} style={[styles.page, phone && props.kind === 'video' && !failed ? styles.pagePhoneVideo : null]}>
      {failed ? body : props.kind === 'video' ? (
        <View style={styles.videoColumn}>
          <View style={[styles.videoWell, phone ? styles.videoWellPhone : null]}>{body}</View>
          {downloading ? <View style={phone ? styles.phoneGutter : null}>{downloading}</View> : null}
        </View>
      ) : (
        <View
          style={[
            styles.audioFrame,
            {
              borderColor: theme.colors.border.default,
              backgroundColor: theme.colors.surface.base,
            },
          ]}
        >
          {body}
        </View>
      )}
    </View>
  );
}

/**
 * The player fills its well. A plain style on purpose: on web `VideoView` spreads `style` straight onto the
 * `<video>` element, where a Unistyles entry does not apply, so the element kept its natural 1280 × 720 and ran
 * past the well (its controls off-screen at 390).
 */
const VIDEO_FILL = { width: '100%', height: '100%' } as const;

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.space.s32,
    backgroundColor: theme.colors.surface.inset,
  },
  pagePhoneVideo: {
    paddingHorizontal: 0,
  },
  videoWellPhone: {
    borderRadius: 0,
    borderWidth: 0,
  },
  phoneGutter: {
    paddingHorizontal: theme.space.s16,
  },
  videoColumn: {
    width: '100%',
    maxWidth: 720,
    gap: theme.space.s12,
  },
  videoWell: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: theme.space.s12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface.base,
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioFrame: {
    width: '100%',
    maxWidth: 520,
    minHeight: theme.space.s48 + theme.space.s16,
    borderRadius: theme.space.s16,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
  },
  audioDownload: {
    paddingVertical: theme.space.s12,
    paddingHorizontal: theme.space.s16,
  },
  audioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    paddingVertical: theme.space.s12,
    paddingLeft: theme.space.s12,
    paddingRight: theme.space.s16,
  },
  time: {
    minWidth: theme.space.s32,
  },
  scrubber: {
    flex: 1,
    minWidth: 0,
  },
  centre: {
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
