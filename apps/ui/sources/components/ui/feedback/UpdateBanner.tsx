import React from 'react';
import { Platform } from 'react-native';

import { AppUpdateStatusTag } from './AppUpdateStatusTag';

export const UpdateBanner = React.memo(function UpdateBanner() {
    if (Platform.OS === 'web') {
        return null;
    }

    return <AppUpdateStatusTag />;
});
