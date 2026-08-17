import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import {
    createPluginAccountDataEraseRecoveryController,
    type PluginAccountDataEraseRecoveryController,
} from './pluginAccountDataEraseRecoveryController';

type RecoveryControllerLifetime = {
    controller: PluginAccountDataEraseRecoveryController;
    current: boolean;
};

/**
 * Settings entry for the host-present Account erase Action. With a plugin id
 * it removes data for the installed detail; without one it intentionally
 * prompts for an orphaned id rather than deriving a second plugin catalog.
 */
export function PluginAccountDataEraseRecoverySection(props: Readonly<{
    pluginId?: string | null;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const knownPluginId = props.pluginId?.trim() || null;
    const [pending, setPending] = React.useState(false);
    const controllerLifetimeRef = React.useRef<RecoveryControllerLifetime | null>(null);

    React.useEffect(() => {
        const lifetime: RecoveryControllerLifetime = {
            controller: createPluginAccountDataEraseRecoveryController(),
            current: true,
        };
        controllerLifetimeRef.current = lifetime;
        return () => {
            lifetime.current = false;
            if (controllerLifetimeRef.current === lifetime) controllerLifetimeRef.current = null;
            lifetime.controller.retire();
        };
    }, []);

    const erase = React.useCallback(() => {
        const lifetime = controllerLifetimeRef.current;
        if (!lifetime || pending || lifetime.controller.isPending()) return;
        setPending(true);
        void (async () => {
            try {
                if (knownPluginId) {
                    await lifetime.controller.eraseKnownPlugin(knownPluginId);
                } else {
                    await lifetime.controller.eraseOrphanedPlugin();
                }
            } finally {
                if (lifetime.current && controllerLifetimeRef.current === lifetime) setPending(false);
            }
        })();
    }, [knownPluginId, pending]);

    return (
        <ItemGroup
            title={knownPluginId
                ? t('settingsPlugins.accountDataErase.installedGroupTitle')
                : t('settingsPlugins.accountDataErase.orphanedGroupTitle')}
            footer={knownPluginId
                ? t('settingsPlugins.accountDataErase.installedGroupFooter')
                : t('settingsPlugins.accountDataErase.orphanedGroupFooter')}
        >
            <Item
                testID={props.testID}
                title={knownPluginId
                    ? t('settingsPlugins.accountDataErase.installedEntryTitle')
                    : t('settingsPlugins.accountDataErase.orphanedEntryTitle')}
                subtitle={knownPluginId
                    ? t('settingsPlugins.accountDataErase.installedEntrySubtitle')
                    : t('settingsPlugins.accountDataErase.orphanedEntrySubtitle')}
                icon={<Icon name="trash" size={29} color={theme.colors.state.danger.foreground} />}
                onPress={erase}
                disabled={pending}
                loading={pending}
                destructive
                showChevron={false}
            />
        </ItemGroup>
    );
}
