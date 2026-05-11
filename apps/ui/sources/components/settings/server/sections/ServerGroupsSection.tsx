import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { t } from '@/text';

type ServerGroupsSectionProps = Readonly<{
    groupSelectionEnabled: boolean;
    setGroupSelectionEnabled: (value: boolean) => void;
    groupSelectionPresentation: 'grouped' | 'flat-with-badge';
    activeServerGroupId: string | null;
    selectedGroupServerIds: ReadonlySet<string>;
    servers: ReadonlyArray<ServerProfile>;
    onToggleGroupPresentation: () => void;
    onToggleGroupServer: (serverId: string) => void;
}>;

export function ServerGroupsSection(props: ServerGroupsSectionProps) {
    const { theme } = useUnistyles();

    return (
        <ItemGroup
            title={t('server.multiServerView.title')}
            footer={t('server.multiServerView.footer')}
        >
            <Item
                title={t('server.multiServerView.enableTitle')}
                subtitle={t('server.multiServerView.enableSubtitle')}
                icon={<Ionicons name="layers-outline" size={29} color={theme.colors.text.secondary} />}
                rightElement={<Switch value={Boolean(props.groupSelectionEnabled)} onValueChange={props.setGroupSelectionEnabled} />}
                showChevron={false}
                onPress={() => props.setGroupSelectionEnabled(!props.groupSelectionEnabled)}
            />
            <Item
                title={t('server.multiServerView.presentationTitle')}
                subtitle={
                    props.groupSelectionPresentation === 'flat-with-badge'
                        ? t('server.multiServerView.presentation.flatWithBadges')
                        : t('server.multiServerView.presentation.groupedByServer')
                }
                icon={<Ionicons name="list-outline" size={29} color={theme.colors.text.secondary} />}
                rightElement={<Ionicons name="swap-horizontal-outline" size={20} color={theme.colors.text.secondary} />}
                showChevron={false}
                onPress={props.onToggleGroupPresentation}
            />
            {props.groupSelectionEnabled && !props.activeServerGroupId
                ? props.servers.map((profile) => {
                    const selected = props.selectedGroupServerIds.has(profile.id);
                    return (
                        <Item
                            key={`multi-server-${profile.id}`}
                            title={profile.name}
                            subtitle={toServerUrlDisplay(profile.serverUrl)}
                            icon={<Ionicons name="server-outline" size={29} color={theme.colors.text.secondary} />}
                            rightElement={(
                                <Ionicons
                                    name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                                    size={20}
                                    color={selected ? theme.colors.status.connected : theme.colors.text.secondary}
                                />
                            )}
                            showChevron={false}
                            onPress={() => props.onToggleGroupServer(profile.id)}
                        />
                    );
                })
                : null}
        </ItemGroup>
    );
}
