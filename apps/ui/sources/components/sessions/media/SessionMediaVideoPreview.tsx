import * as React from 'react';
import { Platform } from 'react-native';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';

import { SessionMediaTileState } from '@/components/sessions/media/SessionMediaTileState';
import { t } from '@/text';

/**
 * The one host video-preview player configuration shared by SessionMedia and
 * draft Composer staged media. Callers own only their opaque source lookup;
 * this component owns no media cache or transfer state. When the decoder rejects
 * the source it draws the media tile's own state with the stage's sentence; a
 * staged chip asks for the glyph alone (`form="glyph"`).
 */
export const SessionMediaVideoPreview = React.memo(function SessionMediaVideoPreview(props: Readonly<{
    uri: string;
    accessibilityLabel: string;
    form?: 'tile' | 'glyph';
}>): React.ReactElement {
    const player = useVideoPlayer(props.uri, (instance: VideoPlayer) => {
        instance.loop = false;
        instance.muted = true;
        instance.allowsExternalPlayback = false;
        instance.timeUpdateEventInterval = 0;
    });

    const view = React.useRef<VideoView>(null);
    const [failedPlayer, setFailedPlayer] = React.useState<VideoPlayer | null>(null);
    React.useEffect(() => {
        const subscription = player.addListener('statusChange', (event) => {
            if (event.status === 'error') setFailedPlayer(player);
        });
        // On web src is attached before the adapter installs its error handler. A failed
        // decode can therefore live only on the element, with no statusChange/loadeddata.
        const video = Platform.OS === 'web' ? view.current?.nativeRef.current as HTMLVideoElement | null : null;
        const reject = () => setFailedPlayer(player);
        video?.addEventListener('error', reject);
        if (video?.error || player.status === 'error') reject();
        return () => {
            subscription.remove();
            video?.removeEventListener('error', reject);
        };
    }, [player]);

    React.useEffect(() => {
        player.loop = false;
        player.muted = true;
        player.allowsExternalPlayback = false;
        player.timeUpdateEventInterval = 0;
    }, [player]);

    React.useEffect(() => () => {
        try { player.pause(); } catch {}
    }, [player]);

    if (failedPlayer === player || player.status === 'error') {
        const cantPlay = t('files.viewer.videoCantPlayTitle');
        return <SessionMediaTileState
            testID="session-media-video-cant-play"
            icon="video-camera"
            iconSize={props.form === 'glyph' ? 20 : 24}
            label={cantPlay}
            form={props.form}
            accessibilityLabel={cantPlay}
        />;
    }

    return (
        <VideoView
            ref={view}
            player={player}
            style={{ width: '100%', height: '100%' }}
            contentFit="contain"
            nativeControls={false}
            allowsPictureInPicture={false}
            accessibilityLabel={props.accessibilityLabel}
        />
    );
});
