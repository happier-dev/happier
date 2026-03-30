import * as React from 'react';
import { useRouter } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { clearPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { t } from '@/text';

export const SetupAccessGateNotice = React.memo(function SetupAccessGateNotice() {
    const router = useRouter();

    React.useEffect(() => {
        clearPendingSetupIntent();
    }, []);

    return (
        <ItemList>
            <ItemGroup title={t('setupOnboarding.preAuthTitle')}>
                <Item
                    testID="setup.preAuthNotice"
                    title={t('setupOnboarding.preAuthBody')}
                    subtitle={t('setupOnboarding.preAuthContinueHint')}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    testID="setup.preAuthGoHome"
                    title={t('common.back')}
                    onPress={() => {
                        router.replace('/');
                    }}
                />
            </ItemGroup>
        </ItemList>
    );
});
