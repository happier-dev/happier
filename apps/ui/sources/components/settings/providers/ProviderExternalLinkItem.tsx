import * as React from 'react';
import { HappierLink } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { Icon } from '@/components/ui/icons/Icon';

type ProviderExternalLinkKind = 'providerWebsite' | 'getApiKey';

export function ProviderExternalLinkItem(props: Readonly<{
    kind: ProviderExternalLinkKind;
    url: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
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
            icon={<Icon name="arrow-square-out" size={29} color={theme.colors.text.secondary} />}
            mode="info"
            style={{ paddingVertical: 0 }}
            rightElement={(
                <HappierLink
                    label={label}
                    onPress={open}
                    theme={presentationTheme}
                >
                    {label}
                </HappierLink>
            )}
            rightElementOutsidePressable
        />
    );
}
