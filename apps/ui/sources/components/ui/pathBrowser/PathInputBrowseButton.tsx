import * as React from 'react';

import { t } from '@/text';
import { InputBrowseButton } from '@/components/ui/buttons/InputBrowseButton';

import { PATH_BROWSER_TRIGGER_TEST_ID } from './pathBrowserTestIds';

export function PathInputBrowseButton(props: Readonly<{
    onPress: () => void | Promise<void>;
    disabled?: boolean;
    testID?: string;
    accessibilityLabel?: string;
}>): React.ReactElement {
    return (
        <InputBrowseButton
            testID={props.testID ?? PATH_BROWSER_TRIGGER_TEST_ID}
            accessibilityLabel={props.accessibilityLabel ?? t('newSession.pathPicker.enterPathTitle')}
            disabled={props.disabled}
            onPress={props.onPress}
            iconName="folder-open-outline"
        />
    );
}
