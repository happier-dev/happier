import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';
import { SessionHeaderActionButton } from '@/components/sessions/actions/SessionHeaderActionButton';
import { SESSION_HEADER_ICON_SIZE_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * Opens the session details page.
 *
 * This used to be the avatar's job. An avatar is an identity — it says which session you are in —
 * and nothing about it suggests it is also a link, so the details page was effectively hidden
 * behind a control nobody would think to press. The avatar keeps the identity role in the header's
 * leading slot, and the navigation it was carrying moves here, where it looks like what it is.
 */
export const SessionHeaderInfoButton = React.memo((props: Readonly<{
    onPress: () => void;
}>) => {
    const { theme } = useUnistyles();
    const testId = useOptionalSessionScreenTestId('session-header-info-button');

    return (
        <SessionHeaderActionButton
            testID={testId}
            onPress={props.onPress}
            accessibilityLabel={t('sessionInfo.title')}
        >
            <Icon
                name="info"
                size={SESSION_HEADER_ICON_SIZE_PX}
                color={theme.colors.chrome.header.foreground}
            />
        </SessionHeaderActionButton>
    );
});

SessionHeaderInfoButton.displayName = 'SessionHeaderInfoButton';
