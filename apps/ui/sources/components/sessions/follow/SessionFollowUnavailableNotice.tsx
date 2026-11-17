import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, justifyContent: 'center', paddingHorizontal: theme.space.s16 },
}));

/**
 * Settled "you cannot Follow from here" state for the direct Follow route.
 *
 * The route is reachable from a link, a notification and a deep link, so the two ways the
 * editor can fail to appear must say which one happened instead of rendering an empty screen:
 * a Home that does not offer Following is a settled answer, while a Home this device could not
 * reach is a retry. The back target is the exact Session address the link named, never an
 * ambient Home. Drawn by the shared state composition, so it reads like every other page state.
 */
export function SessionFollowUnavailableNotice(props: Readonly<{
    onBack: () => void;
    reason?: 'unsupported' | 'unreachable';
    onRetry?: () => void;
}>): React.ReactElement {
    const maxWidthStyle = useLayoutMaxWidthStyle();
    const unreachable = props.reason === 'unreachable';
    const testID = unreachable ? 'session-follow-unreachable' : 'session-follow-unavailable';
    const back = { testID: `${testID}.back`, label: t('common.back'), onPress: props.onBack };
    return (
        <View style={[styles.root, maxWidthStyle]}>
            <SurfaceStateCard
                testID={testID}
                kind="unavailable"
                size="page"
                title={unreachable ? t('session.follow.unreachableTitle') : t('session.follow.unavailableTitle')}
                reason={unreachable ? t('session.follow.unreachableDescription') : t('session.follow.unavailableDescription')}
                // Retry leads when the Home may answer next time; Back stays one quiet step beside it.
                action={props.onRetry ? { testID: `${testID}.retry`, label: t('common.retry'), onPress: props.onRetry } : back}
                secondaryAction={props.onRetry ? back : undefined}
            />
        </View>
    );
}
