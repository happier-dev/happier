import * as React from 'react';
import { HappierLink } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

type ProviderExternalLinkKind = 'providerWebsite' | 'getApiKey';

export function ProviderExternalLinkItem(props: Readonly<{
    kind: ProviderExternalLinkKind;
    url: string;
    /** Names a destination the kind's label does not ("Where to get this key" for a billing key). */
    label?: string;
}>): React.ReactElement {
    const label = props.label ?? t(`settingsProviders.links.${props.kind}`);
    return (
        <Item
            title={<ProviderExternalLink kind={props.kind} url={props.url} label={props.label} />}
            accessibilityLabel={label}
            mode="info"
            style={{ paddingVertical: 0 }}
        />
    );
}

/** The same external link set inline, beside other quiet actions (the add sheet's key field). */
export function ProviderExternalLink(props: Readonly<{
    kind: ProviderExternalLinkKind;
    url: string;
    label?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);
    const label = props.label ?? t(`settingsProviders.links.${props.kind}`);
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
        <HappierLink
            label={label}
            onPress={open}
            theme={presentationTheme}
        >
            {label}
        </HappierLink>
    );
}
