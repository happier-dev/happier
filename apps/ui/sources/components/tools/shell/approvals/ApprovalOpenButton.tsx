import * as React from 'react';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { t } from '@/text';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

/**
 * The compact header control of an approval card that opens the request's own page or tool call.
 * The shared icon button draws its compact square (so the card head stays one title line tall) and
 * reaches the touch target past it, with the shared keyboard focus ring.
 */
export const ApprovalOpenButton = React.memo(function ApprovalOpenButton(props: Readonly<{
    testID: string;
    onPress: () => void;
}>) {
    useCurrentUiContextLocalCommands([{
        key: 'approval.open', title: t('toolView.open'), invoke: props.onPress,
    }], { contextKey: props.testID });
    return (
        <IconButton
            testID={props.testID}
            variant="plain"
            iconName="arrow-square-out"
            accessibilityLabel={t('toolView.open')}
            onPress={props.onPress}
        />
    );
});
