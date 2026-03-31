import * as React from 'react';
import { Slot } from 'expo-router';

import { SettingsShell } from '@/components/settings/shell/SettingsShell';

export default React.memo(function SettingsLayoutRoute() {
    return (
        <SettingsShell>
            <Slot />
        </SettingsShell>
    );
});
