import * as React from 'react';

import { confirmAccountSignOutEverywhere } from '@/components/settings/account/AccountSessionSecuritySection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';

/** Shows the Security dialog with the real controls and no credential changes. */
export default function AccountSignOutEverywhereDevScreen() {
    return (
        <ItemList>
            <RoundButton
                testID="dev-open-account-sign-out-everywhere"
                title={t('settingsApiTokens.signOutEverywhere.title')}
                onPress={() => { void confirmAccountSignOutEverywhere(); }}
            />
        </ItemList>
    );
}
