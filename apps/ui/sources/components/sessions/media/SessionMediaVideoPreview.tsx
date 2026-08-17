import * as React from 'react';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';

/**
 * The one host video-preview player configuration shared by SessionMedia and
 * draft Composer staged media. Callers own only their opaque source lookup;
 * this component owns no media cache or transfer state.
 */
export const SessionMediaVideoPreview = React.memo(function SessionMediaVideoPreview(props: Readonly<{
    uri: string;
    accessibilityLabel: string;
}>): React.ReactElement {
    const player = useVideoPlayer(props.uri, (instance: VideoPlayer) => {
        instance.loop = false;
        instance.muted = true;
        instance.allowsExternalPlayback = false;
        instance.timeUpdateEventInterval = 0;
    });

    React.useEffect(() => {
        player.loop = false;
        player.muted = true;
        player.allowsExternalPlayback = false;
        player.timeUpdateEventInterval = 0;
    }, [player]);

    React.useEffect(() => () => {
        try { player.pause(); } catch {}
    }, [player]);

    return (
        <VideoView
            player={player}
            style={{ width: '100%', height: '100%' }}
            contentFit="contain"
            nativeControls={false}
            allowsPictureInPicture={false}
            accessibilityLabel={props.accessibilityLabel}
        />
    );
});
