import * as React from 'react';

import { ItemList } from '@/components/ui/lists/ItemList';
import { AcpCatalogSettingsSections } from './AcpCatalogSettingsSections';

export const AcpCatalogSettingsScreen = React.memo(function AcpCatalogSettingsScreen() {
    return (
        <ItemList>
            <AcpCatalogSettingsSections />
        </ItemList>
    );
});
