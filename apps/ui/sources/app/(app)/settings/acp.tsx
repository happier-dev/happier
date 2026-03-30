import React from 'react';
import { Stack } from 'expo-router';

import { AcpCatalogSettingsScreen } from '@/components/settings/acpCatalog/AcpCatalogSettingsScreen';
import { t } from '@/text';

export default React.memo(function AcpCatalogSettingsRoute() {
    const headerTitle = t('settings.acpCatalog');
    const headerBackTitle = t('common.back');

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            headerTitle,
            headerBackTitle,
        } as const;
    }, [headerBackTitle, headerTitle]);

    return (
        <>
            <Stack.Screen options={screenOptions} />
            <AcpCatalogSettingsScreen />
        </>
    );
});
