import React from 'react';

import { useSettingMutable } from '@/sync/domains/state/storage';
import { SecretsList } from '@/components/secrets/SecretsList';

export default React.memo(function SecretsSettingsScreen() {
    const [secrets, setSecrets] = useSettingMutable('secrets');

    return (
        <SecretsList
            secrets={secrets}
            onChangeSecrets={setSecrets}
            allowAdd
            allowEdit
        />
    );
});
