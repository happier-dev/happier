import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { deleteAcpBackendDefinitionV1 } from '@/sync/domains/acpCatalog/acpCatalogCrud';
import { normalizeAcpCatalogSettingsV1 } from '@/sync/domains/acpCatalog/normalizeAcpCatalogSettingsV1';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { Icon } from '@/components/ui/icons/Icon';

function formatBackendSubtitle(command: string, args: readonly string[]): string {
    return [command, ...args].filter(Boolean).join(' ');
}

export const AcpCatalogSettingsSections = React.memo(function AcpCatalogSettingsSections() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [settingsRaw, setSettings] = useSettingMutable('acpCatalogSettingsV1');
    const settings = React.useMemo(() => normalizeAcpCatalogSettingsV1(settingsRaw), [settingsRaw]);

    const backends = React.useMemo(
        () => settings.backends.slice().sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name)),
        [settings.backends],
    );

    const handleDeleteBackend = React.useCallback(async (backendId: string) => {
        const backend = settings.backends.find((entry) => entry.id === backendId) ?? null;
        if (!backend) return;
        const confirmed = await Modal.confirm(
            t('settings.acpCatalogDeleteBackendTitle'),
            t('settings.acpCatalogDeleteBackendConfirm', { name: backend.title || backend.name }),
            { destructive: true, cancelText: t('common.cancel'), confirmText: t('common.delete') },
        );
        if (!confirmed) return;
        setSettings(deleteAcpBackendDefinitionV1(settings, backendId));
    }, [setSettings, settings]);

    const addBackendItem = (
        <Item
            testID="settings.acpCatalog.addBackend"
            title={t('settings.acpCatalogAddBackend')}
            subtitle={t('settings.acpCatalogAddBackendSubtitle')}
            icon={<Icon name="plus-circle" size={29} color={theme.colors.state.success.foreground} />}
            onPress={() => router.push('/(app)/settings/acp-backend')}
        />
    );

    return (
        <>
            <ItemGroup
                title={t('settings.acpCatalogBackends')}
                footer={backends.length > 0 ? t('settings.acpCatalogBackendsFooter') : undefined}
            >
                {backends.map((backend) => (
                    <Item
                        key={backend.id}
                        testID={`settings.acpCatalog.backend.${backend.id}`}
                        title={backend.title || backend.name}
                        subtitle={formatBackendSubtitle(backend.command, backend.args)}
                        icon={<Icon name="hard-drives" size={29} color={theme.colors.accent.indigo} />}
                        onPress={() => router.push({ pathname: '/(app)/settings/acp-backend', params: { backendId: backend.id } } as any)}
                        onLongPress={() => { void handleDeleteBackend(backend.id); }}
                    />
                ))}
                {backends.length === 0 ? addBackendItem : null}
            </ItemGroup>

            {backends.length > 0 ? (
                <ItemGroup>
                    {addBackendItem}
                </ItemGroup>
            ) : null}
        </>
    );
});
