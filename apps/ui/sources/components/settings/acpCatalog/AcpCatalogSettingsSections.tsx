import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { applyAcpBackendDeleteV1, normalizeAcpCatalogSettingsV1 } from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { createCustomAcpAgentSettingsRoute } from '@/agents/catalog/agentSettingsRoutes';
import { CustomAcpAgentMark } from './CustomAcpAgentMark';
import { Icon } from '@/components/ui/icons/Icon';

export function formatAcpBackendCommand(command: string, args: readonly string[]): string {
    return [command, ...args].filter(Boolean).join(' ');
}

/**
 * The custom ACP backends the Account defines, sorted for display, plus their confirmed delete.
 * One owner for every list of custom ACP agents (this section and the Agents collection).
 */
export function useAcpCatalogBackends() {
    const [settingsRaw, setSettings] = useSettingMutable('acpCatalogSettingsV1');
    const settings = React.useMemo(() => normalizeAcpCatalogSettingsV1(settingsRaw), [settingsRaw]);

    const backends = React.useMemo(
        () => settings.backends.slice().sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name)),
        [settings.backends],
    );

    const deleteBackend = React.useCallback(async (backendId: string) => {
        const backend = settings.backends.find((entry) => entry.id === backendId) ?? null;
        if (!backend) return;
        const confirmed = await Modal.confirm(
            t('settings.acpCatalogDeleteBackendTitle'),
            t('settings.acpCatalogDeleteBackendConfirm', { name: backend.title || backend.name }),
            { destructive: true, cancelText: t('common.cancel'), confirmText: t('common.delete') },
        );
        if (!confirmed) return;
        const result = applyAcpBackendDeleteV1({ settings, backendId });
        if (result.ok) setSettings(result.settings);
    }, [setSettings, settings]);

    return { backends, deleteBackend } as const;
}

export const AcpCatalogSettingsSections = React.memo(function AcpCatalogSettingsSections() {
    const router = useRouter();
    const { backends, deleteBackend: handleDeleteBackend } = useAcpCatalogBackends();

    const addBackendItem = (
        <Item
            testID="settings.acpCatalog.addBackend"
            icon={<Icon name="plus" />}
            title={t('settings.acpCatalogAddBackend')}
            subtitle={t('settings.acpCatalogAddBackendSubtitle')}
            onPress={() => router.push(createCustomAcpAgentSettingsRoute(null) as never)}
        />
    );

    return (
        <>
            <ItemGroup
                title={t('settings.acpCatalogBackends')}
                description={backends.length > 0 ? t('settings.acpCatalogBackendsFooter') : undefined}
            >
                {backends.map((backend) => (
                    <Item
                        key={backend.id}
                        testID={`settings.acpCatalog.backend.${backend.id}`}
                        title={backend.title || backend.name}
                        subtitle={formatAcpBackendCommand(backend.command, backend.args)}
                        icon={<CustomAcpAgentMark />}
                        onPress={() => router.push(createCustomAcpAgentSettingsRoute(backend.id) as never)}
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
