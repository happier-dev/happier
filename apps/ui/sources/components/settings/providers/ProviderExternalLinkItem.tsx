import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

type ProviderExternalLinkKind = 'providerWebsite' | 'getApiKey';

export function ProviderExternalLinkItem(props: Readonly<{
    kind: ProviderExternalLinkKind;
    url: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const label = t(`settingsProviders.links.${props.kind}`);

    const open = React.useCallback(async () => {
        let opened = false;
        try {
            opened = await openExternalUrl(props.url);
        } catch {
            opened = false;
        }
        if (!opened) {
            await Modal.alert(t('common.error'), t('settingsProviders.links.failedToOpen'));
        }
    }, [props.url]);

    return (
        <Item
            title={label}
            accessibilityLabel={label}
            icon={<SafeIonicons name="open-outline" size={29} color={theme.colors.text.secondary} />}
            onPress={() => { void open(); }}
        />
    );
}
