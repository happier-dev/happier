import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { AgentsAcpBackendsDeleteOutputV1Schema } from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { getStorage } from '@/sync/domains/state/storage';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { createCustomAcpAgentSettingsRoute } from '@/agents/catalog/agentSettingsRoutes';
import { CustomAcpAgentMark } from './CustomAcpAgentMark';
import { useAcpCatalogActionExecution } from './useAcpCatalogActionExecution';
import { Icon } from '@/components/ui/icons/Icon';

export function formatAcpBackendCommand(command: string, args: readonly string[]): string {
    return [command, ...args].filter(Boolean).join(' ');
}

/**
 * The custom ACP backends the Account defines, sorted for display, plus their confirmed delete.
 * One owner for every list of custom ACP agents (this section and the Agents collection).
 */
export function useAcpCatalogBackends() {
    const scope = useAccountSettingsScope();
    const { snapshot } = useAcpCatalog(scope);
    const { execute: executeAction, isCurrent: isAccountCurrent } = useAcpCatalogActionExecution(scope);
    const settings = React.useMemo(() => ({ v: 2 as const, backends: snapshot?.data?.definitions ?? [] }), [snapshot?.data]);

    const backends = React.useMemo(
        () => settings.backends.slice().sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name)),
        [settings.backends],
    );

    const deleteBackend = React.useCallback(async (backendId: string) => {
        if (!snapshot || snapshot.catalog.status !== 'ready' || snapshot.stale) return;
        const capturedScope = snapshot.scope;
        const catalog = snapshot.catalog;
        const actionInput = { backendId, expectedRevision: catalog.revision,
            ...(catalog.revision === 'absent' ? { sourceSettingsVersion: catalog.sourceSettingsVersion } : {}),
        };
        const isCurrent = () => isAccountCurrent()
            && areAccountSettingsScopesEqual(capturedScope, getStorage().getState().settingsScope);
        if (!isCurrent()) return;
        const backend = settings.backends.find((entry) => entry.id === backendId) ?? null;
        if (!backend) return;
        const confirmed = await Modal.confirm(
            t('settings.acpCatalogDeleteBackendTitle'),
            t('settings.acpCatalogDeleteBackendConfirm', { name: backend.title || backend.name }),
            { destructive: true, cancelText: t('common.cancel'), confirmText: t('common.delete') },
        );
        if (!confirmed || !isCurrent()) return;
        const reportFailure = () => { if (isCurrent()) Modal.alert(t('common.error'), t('common.unavailable')); };
        try {
            const execution = await executeAction('agents.acp.backends.delete', actionInput);
            if (!execution.ok) throw new Error(execution.errorCode);
            if (!isCurrent()) return;
            AgentsAcpBackendsDeleteOutputV1Schema.parse(execution.result);
        }
        catch { reportFailure(); }
    }, [executeAction, isAccountCurrent, settings, snapshot]);

    return { backends, deleteBackend, status: snapshot?.catalog.status ?? 'loading', ready: snapshot?.catalog.status === 'ready' && !snapshot.stale } as const;
}

export const AcpCatalogSettingsSections = React.memo(function AcpCatalogSettingsSections() {
    const router = useRouter();
    const { backends, deleteBackend: handleDeleteBackend, ready } = useAcpCatalogBackends();

    const addBackendItem = (
        <Item
            testID="settings.acpCatalog.addBackend"
            icon={<Icon name="plus" />}
            title={t('settings.acpCatalogAddBackend')}
            subtitle={t('settings.acpCatalogAddBackendSubtitle')}
            disabled={!ready}
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
