import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { ExternalSessionsIntegrationSection } from './ExternalSessionsIntegrationSection';
import type {
    ExternalSessionsAutoLinkSourceDescriptor,
    ExternalSessionsIntegrationDescriptor,
    ExternalSessionsIntegrationOperations,
    ExternalSessionsQualifiedAgent,
} from './externalSessionsIntegrationModel';
import type {
    ExternalSessionsIntegrationInventoryState,
} from './externalSessionsIntegrationController';

export const ExternalSessionsAgentSettingsSection = React.memo(function ExternalSessionsAgentSettingsSection(
    props: Readonly<{
        machineId: string | null;
        agent: ExternalSessionsQualifiedAgent | null;
        agentTitle: string;
        integrations: readonly ExternalSessionsIntegrationDescriptor[] | null;
        autoLinkSources: readonly ExternalSessionsAutoLinkSourceDescriptor[] | null;
        operations?: ExternalSessionsIntegrationOperations | null;
        inventoryState?: ExternalSessionsIntegrationInventoryState;
        onRetryInventory?: (() => void | Promise<void>) | null;
        onBrowse: (() => void) | null;
        onManageAll: () => void;
    }>,
) {
    const { theme } = useUnistyles();
    return (
        <>
            <ExternalSessionsIntegrationSection
                integrations={props.integrations}
                autoLinkSources={props.autoLinkSources}
                machineId={props.machineId}
                agent={props.agent}
                agentTitle={props.agentTitle}
                operations={props.operations}
                inventoryState={props.inventoryState}
                onRetryInventory={props.onRetryInventory}
            />
            <ItemGroup title={t('externalSessions.settingsAgentActionsGroupTitle')}>
                {props.onBrowse ? (
                    <Item
                        testID="settings-external-sessions-agent-browse"
                        title={t('externalSessions.settingsAgentBrowseTitle', { agent: props.agentTitle })}
                        icon={<SafeIonicons name="folder-open-outline" size={29} color={theme.colors.accent.blue} />}
                        onPress={props.onBrowse}
                    />
                ) : null}
                <Item
                    testID="settings-external-sessions-manage-all"
                    title={t('externalSessions.settingsManageAllTitle')}
                    subtitle={t('externalSessions.settingsManageAllSubtitle')}
                    icon={<SafeIonicons name="settings-outline" size={29} color={theme.colors.text.secondary} />}
                    onPress={props.onManageAll}
                />
            </ItemGroup>
        </>
    );
});
