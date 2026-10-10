import * as React from 'react';
import { Platform } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { ConnectionStatusControl } from '@/components/navigation/ConnectionStatusControl';
import { settingRendersOnHost } from '@/components/settings/catalog/settingDeclarations';
import { homeAdministrationRuntimePath } from '@/components/settings/home/governance/homeAdministrationRoutes';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { LocalRelayAccessControlSection } from '@/components/settings/server/localControl/LocalRelayAccessControlSection';
import { LocalRelayRuntimeControlSection } from '@/components/settings/server/localControl/LocalRelayRuntimeControlSection';
import {
    PersonalHomeRuntimeControlSection,
    type PersonalHomeRuntimeControlOperations,
} from '@/components/settings/server/localControl/PersonalHomeRuntimeControlSection';
import { useLocalRelayRuntimeControl } from '@/components/settings/server/localControl/useLocalRelayRuntimeControl';
import { usePersonalHomeRuntimeOperations } from '@/components/settings/server/localControl/usePersonalHomeRuntimeOperations';
import { HomeDeviceApprovalSection } from '@/components/settings/server/sections/HomeDeviceApprovalSection';
import { SERVERS_SETTINGS } from '@/components/settings/server/serverSettings';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { findPersonalHomeBootstrapCompletedProfile, resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { resolveKnownLocalRelayUrl } from '@/sync/domains/server/url/resolveKnownLocalRelayUrl';
import { commitHomeApplicationCarrierEligibility } from '@/sync/runtime/orchestration/connectionManager';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { useHomesCollection } from './HomesCollection';

type LocalRuntimeSectionProps = Readonly<{
    controller?: ReturnType<typeof useLocalRelayRuntimeControl>;
    operations?: PersonalHomeRuntimeControlOperations;
    homeLabel?: string;
    onStatusChange?: (status: ReturnType<typeof useLocalRelayRuntimeControl>['status']) => void;
}>;

function OwnedLocalRuntimeSection(props: LocalRuntimeSectionProps) {
    const controller = useLocalRelayRuntimeControl();
    return <ServerLocalRuntimeControlSection {...props} controller={controller} />;
}

/** The runtime this desktop runs: the Personal Home's controls when it is one, else the generic relay runtime's. */
export const ServerLocalRuntimeControlSection = React.memo(function ServerLocalRuntimeControlSection(props: LocalRuntimeSectionProps) {
    if (!props.controller) return <OwnedLocalRuntimeSection {...props} />;
    return props.controller.status?.purpose?.kind === 'personal-home' ? (
        <PersonalHomeRuntimeControlSection
            controller={props.controller}
            {...(props.onStatusChange ? { onStatusChange: props.onStatusChange } : {})}
            {...(props.operations ? { operations: props.operations } : {})}
            {...(props.homeLabel !== undefined ? { homeLabel: props.homeLabel } : {})}
        />
    ) : (
        <LocalRelayRuntimeControlSection
            controller={props.controller}
            {...(props.onStatusChange ? { onStatusChange: props.onStatusChange } : {})}
        />
    );
});

/**
 * Settings → Homes → This device: how this device reaches its Homes — devices waiting for approval,
 * the connection it uses, and the Home runtime it runs itself (desktop app).
 */
export const HomesDeviceScreen = React.memo(function HomesDeviceScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { controller } = useHomesCollection();
    const [homeApplicationCarrierEligibility, setHomeApplicationCarrierEligibility] = useLocalSettingMutable('homeApplicationCarrierEligibility');
    const [connectionDetailsExpanded, setConnectionDetailsExpanded] = React.useState(false);
    const [localRelayUrl, setLocalRelayUrl] = React.useState<string | null>(null);
    const knownLocalRelayUrl = React.useMemo(() => resolveKnownLocalRelayUrl({
        activeServerUrl: controller.activeServerUrl,
        activeLocalRelayUrl: controller.activeLocalRelayUrl,
    }), [controller.activeLocalRelayUrl, controller.activeServerUrl]);
    // The managed Personal Home this desktop runs is administered from its Home console (Runtime).
    const personalHomeProfile = React.useMemo(
        () => findPersonalHomeBootstrapCompletedProfile(controller.servers),
        [controller.servers],
    );
    const { operations: unboundRuntimeOperations } = usePersonalHomeRuntimeOperations({ profiles: controller.servers });
    const handleLocalRelayStatusChange = React.useCallback((status: Readonly<{ relayUrl: string }> | null | undefined) => {
        const next = typeof status?.relayUrl === 'string' && status.relayUrl.trim().length > 0 ? status.relayUrl.trim() : null;
        setLocalRelayUrl((current) => (current === next ? current : next));
    }, []);

    return (
        <ItemList>
            <SettingsPageHeader description={t('addFlows.thisDeviceDescription')} />

            <HomeDeviceApprovalSection homes={controller.servers} />

            <ItemGroup
                title={t('server.page.connectionTitle')}
                description={t('server.page.connectionDescription')}
            >
                <SettingRow
                    testID="settings.server.standardOnly"
                    setting={SERVERS_SETTINGS.settings.standardOnly}
                    titleLines={0}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={<Switch
                        testID="settings.server.standardOnly.switch"
                        value={homeApplicationCarrierEligibility === 'standard_only'}
                        onValueChange={(enabled) => {
                            commitHomeApplicationCarrierEligibility(enabled ? 'standard_only' : 'automatic', setHomeApplicationCarrierEligibility);
                        }}
                    />}
                />
                {/* Realtime, machines, transport and diagnostics for the Home this device uses. */}
                <ExpandableItem
                    testID="settings.server.connectionDetails"
                    expanded={connectionDetailsExpanded}
                    onExpandedChange={setConnectionDetailsExpanded}
                    header={(state) => (
                        <Item
                            testID="settings.server.connectionDetails.header"
                            {...state.headerProps}
                            title={t('server.homes.connectionDetails')}
                            rightElement={(
                                <Icon
                                    name={state.expanded ? 'caret-down' : 'caret-right'}
                                    size={16}
                                    color={theme.colors.text.secondary}
                                />
                            )}
                            showChevron={false}
                        />
                    )}
                >
                    {connectionDetailsExpanded ? <ConnectionStatusControl variant="fullScreen" /> : null}
                </ExpandableItem>
            </ItemGroup>

            {settingRendersOnHost(SERVERS_SETTINGS.settings.accessMethod) ? (
                personalHomeProfile ? (
                    <ItemGroup title={t('settingsAgents.localControlTitle')}>
                        <Item
                            testID="settings.server.personalHomeConsole"
                            icon={<Icon name="hard-drives" />}
                            title={t('homeGovernance.runtime.hostedHere', { home: resolveHomeDisplayLabel(personalHomeProfile, personalHomeProfile.id) })}
                            subtitle={t('homeGovernance.runtime.hostedHereSubtitle')}
                            onPress={() => router.push(homeAdministrationRuntimePath(resolveServerProfileScopeId(personalHomeProfile)))}
                        />
                    </ItemGroup>
                ) : (
                    // A local runtime without a Personal Home receipt is bound to no Home console, so its
                    // runtime-scoped operations stay on this device's page.
                    <>
                        <ServerLocalRuntimeControlSection
                            onStatusChange={handleLocalRelayStatusChange}
                            operations={unboundRuntimeOperations}
                        />
                        <LocalRelayAccessControlSection upstreamUrl={localRelayUrl ?? knownLocalRelayUrl} />
                    </>
                )
            ) : Platform.OS === 'web' ? null : (
                <ItemGroup title={t('settingsAgents.localControlTitle')}>
                    <Item
                        testID="settings.server.localControl.desktopOnlyNotice"
                        title={t('settings.systemTaskBridgeUnavailable')}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
});
