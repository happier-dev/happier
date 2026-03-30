import React from 'react';
import { Stack } from 'expo-router';

import { AcpBackendEditorScreen } from '@/components/settings/acpCatalog/AcpBackendEditorScreen';
import { t } from '@/text';

export default React.memo(function AcpBackendEditorRoute() {
    const headerTitle = t('settings.acpCatalogBackendEditorTitle');
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
            <AcpBackendEditorScreen />
        </>
    );
});
