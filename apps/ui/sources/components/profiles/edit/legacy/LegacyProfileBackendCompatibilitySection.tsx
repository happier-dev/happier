import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { resolveProfileBackendTargetKeyForEntry } from '../profileBackendEntryStorage';
import { Icon } from '@/components/ui/icons/Icon';

export function LegacyProfileBackendCompatibilitySection(props: Readonly<{
    entries: readonly ResolvedBackendCatalogEntry[];
    compatibilityByTargetKey: Readonly<Record<string, boolean>>;
    machineLoginEnabled: boolean;
    resolvedMachineId: string | null;
    loginByAgentId: Readonly<Partial<Record<AgentId, boolean | null>>>;
    getRuntimeCarrierAgentId: (entry: ResolvedBackendCatalogEntry) => AgentId | null;
    getDisplayAgentId: (entry: ResolvedBackendCatalogEntry) => AgentId | null;
    getDisplayAgentIconName: (entry: ResolvedBackendCatalogEntry) => string;
    toggleCompatibility: (targetKey: string) => void;
}>) {
    const { theme } = useUnistyles();
    const showLoginStatus = props.machineLoginEnabled && Boolean(props.resolvedMachineId);

    return <ItemGroup title={t('profiles.aiBackend.title')}>
        {props.entries.map((entry, index) => {
            const targetKey = resolveProfileBackendTargetKeyForEntry(entry);
            const runtimeAgentId = props.getRuntimeCarrierAgentId(entry);
            const displayAgentId = props.getDisplayAgentId(entry);
            const loginStatus = showLoginStatus && runtimeAgentId ? props.loginByAgentId[runtimeAgentId] : null;
            const subtitle = typeof loginStatus === 'boolean'
                ? <Text style={{
                    ...Typography.default('regular'),
                    fontSize: Platform.select({ ios: 15, default: 14 }),
                    lineHeight: 20,
                    letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
                    color: loginStatus ? theme.colors.status.connected : theme.colors.status.disconnected,
                }}>
                    {loginStatus
                        ? t('profiles.machineLogin.status.loggedIn')
                        : t('profiles.machineLogin.status.notLoggedIn')}
                </Text>
                : entry.subtitle ?? (displayAgentId ? t(getAgentCore(displayAgentId).subtitleKey) : null);
            const enabled = props.compatibilityByTargetKey[targetKey] === true;
            return <Item
                key={entry.backendTargetKey}
                title={entry.title}
                subtitle={subtitle}
                leftElement={<Icon name={props.getDisplayAgentIconName(entry) as never} size={24} color={theme.colors.text.secondary} />}
                rightElement={<Switch value={enabled} onValueChange={() => props.toggleCompatibility(targetKey)} />}
                showChevron={false}
                onPress={() => props.toggleCompatibility(targetKey)}
                showDivider={index < props.entries.length - 1}
            />;
        })}
    </ItemGroup>;
}
