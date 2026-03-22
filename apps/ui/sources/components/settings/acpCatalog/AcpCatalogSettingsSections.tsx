import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { getBuiltInAcpConfig, type AgentId } from '@happier-dev/agents';

import { getAgentCore } from '@/agents/catalog/catalog';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { deleteAcpBackendDefinitionV1 } from '@/sync/domains/acpCatalog/acpCatalogCrud';
import { normalizeAcpCatalogSettingsV1 } from '@/sync/domains/acpCatalog/normalizeAcpCatalogSettingsV1';
import { useSettingMutable } from '@/sync/domains/state/storage';

const BUILT_IN_GENERIC_ACP_AGENT_IDS: readonly AgentId[] = ['kiro'];

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
            icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.success} />}
            onPress={() => router.push('/(app)/settings/acp-backend')}
        />
    );

    return (
        <>
            <ItemGroup title={t('settings.acpCatalogBuiltIn')} footer={t('settings.acpCatalogBuiltInFooter')}>
                {BUILT_IN_GENERIC_ACP_AGENT_IDS.map((agentId) => {
                    const builtInAcp = getBuiltInAcpConfig(agentId);
                    const core = getAgentCore(agentId);
                    if (!builtInAcp) return null;
                    return (
                        <Item
                            key={agentId}
                            testID={`settings.acpCatalog.builtIn.${agentId}`}
                            title={t(core.displayNameKey)}
                            subtitle={formatBackendSubtitle(builtInAcp.launcher.command, builtInAcp.launcher.args)}
                            icon={<Ionicons name="flash-outline" size={29} color={theme.colors.accent.orange} />}
                            showChevron={false}
                        />
                    );
                })}
            </ItemGroup>

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
                        icon={<Ionicons name="server-outline" size={29} color={theme.colors.accent.indigo} />}
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
