import React from 'react';

import { SecretsList } from '@/components/secrets/SecretsList';
import { useSavedSecretsMutable } from '@/components/secrets/useSavedSecretsMutable';

export default React.memo(function SecretsSettingsScreen() {
    const [secrets, setSecrets] = useSavedSecretsMutable();

    return (
        <SecretsList
            secrets={secrets}
            onChangeSecrets={setSecrets}
            allowAdd
            allowEdit
        />
    );
});
