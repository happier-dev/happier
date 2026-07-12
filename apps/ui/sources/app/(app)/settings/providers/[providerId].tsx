import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { BadgeGrid, type BadgeGridItem } from '@/components/ui/layout/BadgeGrid';
import { useAllMachines, useMachineListByServerId, useSettings } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { isAgentId, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { getProviderSettingsPlugin } from '@/agents/providers/registry/providerSettingsRegistry';
import { getProviderLocalAuthPlugin } from '@/agents/providers/registry/providerLocalAuthRegistry';
import type { ProviderSettingFieldDef } from '@/agents/providers/shared/providerSettingsPlugin';
import type { ProviderLocalAuthLaunch } from '@/agents/providers/shared/providerLocalAuthPlugin';
import { t } from '@/text';
import {
    buildBackendTargetKey,
    ConnectedServicesProviderStateSharingSettingsV1Schema,
    type ConnectedServicesDefaultAuthByAgentIdV1,
    type ConnectedServicesProviderStateSharingSettingsV1,
} from '@happier-dev/protocol';
import { getAgentSessionModeDescriptor, getAgentStaticModels, getProviderCliRuntimeSpec, isAgentAuthProbeSafeForBackgroundChecks } from '@happier-dev/agents';
import {
    buildCatalogModelList,
    classifySessionModeDescriptor,
    describeResumeSupportKind,
} from '@/agents/catalog/providerDetailsInfo';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { useCapabilityInstallability } from '@/hooks/machine/useCapabilityInstallability';
import { ProviderCliInstallItem } from '@/components/settings/providers/ProviderCliInstallItem';
import { buildAgentCliCapabilityId } from '@/capabilities/agentCliCapabilityId';
import { getPermissionModeLabelForAgentType, getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { ProviderAuthenticationCard } from '@/components/settings/providers/authentication/ProviderAuthenticationCard';
import { ProviderAuthenticationTerminalPane } from '@/components/settings/providers/authentication/ProviderAuthenticationTerminalPane';
import { scheduleProviderAuthenticationRefreshes } from '@/components/settings/providers/authentication/scheduleProviderAuthenticationRefreshes';
import { useProviderAuthenticationState } from '@/components/settings/providers/authentication/useProviderAuthenticationState';
import { resolveEffectiveConfiguredRuntimeControlSurface } from '@/sync/domains/session/control/effectiveRuntimeControlSurface';
import { buildProviderSettingsFieldPatch, readProviderSettingsFieldValue } from '@/components/settings/providers/providerSettingsFieldBinding';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useProfile } from '@/sync/store/hooks';
import { ContextBar } from '@/components/contextBar/ContextBar';
import { useContextBarSelection } from '@/components/contextBar/useContextBarSelection';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { ConnectedServicesDefaultAuthRow } from '@/components/settings/connectedServices/ConnectedServicesDefaultAuthRow';
import {
    ConnectedServicesProviderStateSharingBackendGroups,
    resolveProviderStateSharingAgentIds,
} from '@/components/settings/connectedServices/ConnectedServicesProviderStateSharingSettings';
import { ProviderSettingsFields } from '@/components/settings/providers/ProviderSettingsFields';

const PROVIDER_AUTH_TERMINAL_TAB_ID = 'provider-auth-terminal';

function resolveActiveServerMachineIds(params: Readonly<{
    capabilityServerId: string | null;
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machines: readonly Machine[];
}>): string[] {
    const capabilityServerId = params.capabilityServerId;
    if (!capabilityServerId) return [];

    const serverMachineEntries = params.machineListByServerId[capabilityServerId];
    if (Array.isArray(serverMachineEntries) && serverMachineEntries.length > 0) {
        return serverMachineEntries
            .filter((entry) => entry.revokedAt == null)
            .map((entry) => entry.id);
    }

    const machineIdsClaimedByOtherServers = new Set<string>();
    for (const [serverId, entries] of Object.entries(params.machineListByServerId)) {
        if (serverId === capabilityServerId || !Array.isArray(entries)) continue;
        for (const entry of entries) {
            if (entry?.revokedAt == null && typeof entry?.id === 'string' && entry.id.trim().length > 0) {
                machineIdsClaimedByOtherServers.add(entry.id);
            }
        }
    }

    return params.machines
        .filter((machine) => machine.revokedAt == null && !machineIdsClaimedByOtherServers.has(machine.id))
        .map((machine) => machine.id);
}

type ProviderSettingsCore = NonNullable<ReturnType<typeof getAgentCore>>;

const ProviderSettingsNotFound = React.memo(function ProviderSettingsNotFound(props: Readonly<{ theme: ReturnType<typeof useUnistyles>['theme'] }>) {
    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup>
                <View style={{ alignItems: 'center', paddingVertical: 32, paddingHorizontal: 16 }}>
                    <Ionicons name="warning-outline" size={48} color={props.theme.colors.state.danger.foreground} style={{ marginBottom: 16 }} />
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 16, color: props.theme.colors.state.danger.foreground, textAlign: 'center', marginBottom: 8 }}>
                        {t('settingsProviders.notFoundTitle')}
                    </Text>
                    <Text style={{ ...Typography.default(), fontSize: 14, color: props.theme.colors.text.secondary, textAlign: 'center', lineHeight: 20 }}>
                        {t('settingsProviders.notFoundSubtitle')}
                    </Text>
                </View>
            </ItemGroup>
        </ItemList>
    );
});

const ProviderSettingsScreenInner = React.memo(function ProviderSettingsScreenInner(props: Readonly<{
    providerId: AgentId;
    core: ProviderSettingsCore;
    plugin: ReturnType<typeof getProviderSettingsPlugin>;
    authPlugin: ReturnType<typeof getProviderLocalAuthPlugin>;
}>) {
    const { theme } = useUnistyles();
    const supportsDesktopControls = isTauriDesktop();
    const { providerId, core, plugin, authPlugin } = props;
    const settings = useSettings();
    const profile = useProfile();
    const router = useRouter();
    const connectedServicesEnabled = useFeatureEnabled('connectedServices');
    const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
    const paneScopeId = React.useMemo(
        () => `settings:provider:${providerId}`,
        [providerId],
    );
    const pane = useAppPaneScope(paneScopeId);
    const applySettings = useApplySettings();

    const popoverBoundaryRef = React.useRef<any>(null);
    const [openMenu, setOpenMenu] = React.useState<null | string>(null);
    const [localInputs, setLocalInputs] = React.useState<Record<string, string>>({});

    const setSetting = React.useCallback((key: string, value: unknown) => {
        applySettings({ [key]: value } as Partial<typeof settings>);
    }, [applySettings]);

    const sessionModeDescriptor = getAgentSessionModeDescriptor(providerId);
    const providerCliRuntimeSpec = getProviderCliRuntimeSpec(providerId);
    const providerTargetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: providerId });
    const backendEnabledByTargetKey = settings.backendEnabledByTargetKey;
    const backendEnabled = backendEnabledByTargetKey?.[providerTargetKey] !== false;
    const setBackendEnabled = (next: boolean) => {
        applySettings({
            backendEnabledByTargetKey: {
                ...(backendEnabledByTargetKey ?? {}),
                [providerTargetKey]: next,
            },
        });
    };

    const defaultPermissionByTargetKey = settings.sessionDefaultPermissionModeByTargetKey;
    const permissionMode = defaultPermissionByTargetKey?.[providerTargetKey] ?? 'default';
    const setPermissionMode = (next: PermissionMode) => {
        applySettings({
            sessionDefaultPermissionModeByTargetKey: {
                ...(defaultPermissionByTargetKey ?? {}),
                [providerTargetKey]: next,
            },
        });
    };
    const setDefaultAuthSettings = React.useCallback((next: ConnectedServicesDefaultAuthByAgentIdV1) => {
        applySettings({
            connectedServicesDefaultAuthByAgentIdV1: next,
        } as Partial<typeof settings>);
    }, [applySettings]);
    const normalizedProviderStateSharingSettings = React.useMemo(
        () => ConnectedServicesProviderStateSharingSettingsV1Schema.parse(settings.connectedServicesProviderStateSharingSettingsV1),
        [settings.connectedServicesProviderStateSharingSettingsV1],
    );
    const setProviderStateSharingSettings = React.useCallback((next: ConnectedServicesProviderStateSharingSettingsV1) => {
        applySettings({
            connectedServicesProviderStateSharingSettingsV1: next,
        } as Partial<typeof settings>);
    }, [applySettings]);
    const supportsConnectedServicesDefaultAuth =
        connectedServicesEnabled
        && (core.connectedServices?.supportedServiceIds ?? []).length > 0;
    const supportsProviderStateSharingSettings =
        connectedServicesEnabled
        && resolveProviderStateSharingAgentIds([providerId]).length > 0;
    const backendCliSourcePreferenceById = settings.backendCliSourcePreferenceById;
    const providerCliSourcePreference =
        backendCliSourcePreferenceById?.[providerId] ?? providerCliRuntimeSpec.sourcePreferenceDefault;
    const setProviderCliSourcePreference = (next: 'system-first' | 'managed-first') => {
        applySettings({
            backendCliSourcePreferenceById: {
                ...(backendCliSourcePreferenceById ?? {}),
                [providerId]: next,
            },
        });
    };

    const effectiveRuntimeControlSurface = React.useMemo(
        () => resolveEffectiveConfiguredRuntimeControlSurface({
            agentId: providerId,
            accountSettings: settings as Record<string, unknown>,
        }),
        [providerId, settings],
    );
    const runtimeVendorResumeSupport = effectiveRuntimeControlSurface.resume.vendorResume;
    const resumeSupportKind = describeResumeSupportKind({
        supportsVendorResume: runtimeVendorResumeSupport === 'supported' || runtimeVendorResumeSupport === 'experimental',
        experimental: runtimeVendorResumeSupport === 'experimental',
    });
    const resumeSupport = {
        supported: t('settingsProviders.resumeSupportSupported'),
        supportedExperimental: t('settingsProviders.resumeSupportSupportedExperimental'),
        notSupported: t('settingsProviders.resumeSupportNotSupported'),
    }[resumeSupportKind];
    const { sessionModeKind, runtimeSwitchKind } = classifySessionModeDescriptor(sessionModeDescriptor);
    const sessionModeSupport = {
        none: t('settingsProviders.sessionModeNone'),
        acpPolicyPresets: t('settingsProviders.sessionModeAcpPolicyPresets'),
        acpAgentModes: t('settingsProviders.sessionModeAcpAgentModes'),
        staticAgentModes: t('settingsProviders.sessionModeStaticAgentModes'),
    }[sessionModeKind];
    const runtimeSwitchSupport = {
        none: t('settingsProviders.runtimeSwitchNone'),
        metadataGating: t('settingsProviders.runtimeSwitchMetadataGating'),
        acpSetSessionMode: t('settingsProviders.runtimeSwitchAcpSetSessionMode'),
        acpConfigOption: t('settingsProviders.runtimeSwitchSessionModeApi'),
        providerNative: t('settingsProviders.runtimeSwitchProviderNative'),
    }[runtimeSwitchKind];
    const catalogModelList = buildCatalogModelList({
        defaultMode: core.model.defaultMode,
        allowedModes: core.model.allowedModes,
        staticModels: getAgentStaticModels(core.id),
    });
    const defaultModelLabel = catalogModelList[0] ?? core.model.defaultMode;
    const catalogModelListText = catalogModelList.length > 0
        ? catalogModelList.join(', ')
        : t('settingsProviders.catalogModelListEmpty');
    const dynamicProbe = core.model.dynamicProbe === 'static-only'
        ? t('settingsProviders.dynamicModelProbeStaticOnly')
        : t('settingsProviders.dynamicModelProbeAuto');
    const nonAcpApplyScope = core.model.nonAcpApplyScope === 'spawn_only'
        ? t('settingsProviders.nonAcpApplyScopeSpawnOnly')
        : t('settingsProviders.nonAcpApplyScopeNextPrompt');
    const acpApplyBehavior = core.model.acpApplyBehavior === 'set_model'
        ? t('settingsProviders.acpApplyBehaviorSetModel')
        : core.model.acpApplyBehavior === 'restart_session'
            ? t('settingsProviders.acpApplyBehaviorRestartSession')
            : t('settingsProviders.notAvailable');
    const installInfo = core.cli.installBanner.installKind === 'command'
        ? (core.cli.installBanner.installCommand ?? t('settingsProviders.installInfoSeeSetupGuide'))
        : t('settingsProviders.installInfoUseProviderCliInstaller');

    const machines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    type MachineRecord = (typeof machines)[number];
    const activeServerSnapshot = useActiveServerSnapshot();
    const activeServerId = React.useMemo(
        () => {
            const value = activeServerSnapshot.serverId;
            return typeof value === 'string' && value.trim().length > 0 ? value : null;
        },
        [activeServerSnapshot.serverId],
    );
    const capabilityServerId = React.useMemo(
        () => String(activeServerSnapshot.serverId ?? '').trim() || null,
        [activeServerSnapshot.serverId],
    );
    const activeServerMachineIds = React.useMemo(() => {
        return resolveActiveServerMachineIds({
            capabilityServerId,
            machineListByServerId,
            machines,
        });
    }, [capabilityServerId, machineListByServerId, machines]);
    const activeServerMachines = React.useMemo(() => {
        if (activeServerMachineIds.length === 0) return [] as MachineRecord[];
        const machineMap = new Map(machines.map((machine) => [machine.id, machine] as const));
        return activeServerMachineIds
            .map((machineId: string) => machineMap.get(machineId) ?? null)
            .filter((machine: MachineRecord | null): machine is MachineRecord => machine !== null);
    }, [activeServerMachineIds, machines]);
    const defaultMachineId = activeServerMachines[0]?.id ?? null;
    const {
        machineId: selectedMachineId,
        setMachineId: setSelectedMachineId,
    } = useContextBarSelection({
        selectionKey: `providerSettings.${providerId}`,
        defaultMachineId,
    });
    React.useEffect(() => {
        if (selectedMachineId && activeServerMachineIds.includes(selectedMachineId)) {
            return;
        }
        setSelectedMachineId(defaultMachineId);
    }, [activeServerMachineIds, defaultMachineId, selectedMachineId, setSelectedMachineId]);
    const primaryMachine = machines.find((m) => m.id === selectedMachineId) ?? null;
    const automaticLoginStatusAgentIds = React.useMemo(
        () => (isAgentAuthProbeSafeForBackgroundChecks(providerId) ? [providerId] : []),
        [providerId],
    );
    const machineItems = React.useMemo((): DropdownMenuItem[] => {
        return activeServerMachines.map((machine: MachineRecord) => ({
            id: machine.id,
            title: machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id,
            subtitle: machine.id,
            icon: <Ionicons name="laptop-outline" size={22} color={theme.colors.text.secondary} />,
        }));
    }, [activeServerMachines, theme.colors.text.secondary]);
    const cliAvailability = useCLIDetection(primaryMachine?.id ?? null, {
        autoDetect: true,
        agentIds: [providerId],
        includeLoginStatus: true,
        includeLoginStatusForAgentIds: automaticLoginStatusAgentIds,
        serverId: capabilityServerId,
    });
    const providerAuthentication = useProviderAuthenticationState({
        providerId,
        cliAvailability,
        authPlugin,
        primaryMachine,
    });
    const [selectedAuthLaunchKind, setSelectedAuthLaunchKind] = React.useState<ProviderLocalAuthLaunch['kind'] | null>(null);
    const providerCliAvailable = cliAvailability.available[providerId];
    const providerCliManagedInstalled = cliAvailability.resolutionSource[providerId] === 'managed';
    const providerCliCapabilityId = buildAgentCliCapabilityId(providerId);
    const cliInstallability = useCapabilityInstallability({
        machineId: primaryMachine?.id ?? null,
        serverId: capabilityServerId,
        capabilityId: providerCliCapabilityId,
        timeoutMs: 5000,
    });
    const ExtraSectionsComponent = plugin && 'ExtraSectionsComponent' in plugin
        ? plugin.ExtraSectionsComponent ?? null
        : null;
    const primaryMachineLabel = primaryMachine?.metadata?.displayName ?? primaryMachine?.metadata?.host ?? primaryMachine?.id ?? null;
    const detectedCliStatus = providerCliAvailable === true
        ? t('machine.detectedCliDetected')
        : providerCliAvailable === false
            ? t('machine.detectedCliNotDetected')
            : cliAvailability.isDetecting
                ? t('common.loading')
                : t('machine.detectedCliUnknown');
    const installSetupSubtitle = cliInstallability.kind === 'checking'
        ? `${installInfo} • ${t('common.loading')}`
        : cliInstallability.kind === 'not-installable'
            ? `${installInfo} • ${t('settingsProviders.notAvailable')}`
            : installInfo;

    const statusIconName = providerCliAvailable === true
        ? 'checkmark-circle'
        : providerCliAvailable === false
            ? 'close-circle'
            : cliAvailability.isDetecting
                ? 'time-outline'
                : 'alert-circle';
    const statusIconColor = providerCliAvailable === true
        ? theme.colors.state.success.foreground
        : providerCliAvailable === false
            ? theme.colors.state.danger.foreground
            : theme.colors.text.secondary;

    const capabilityBadges: BadgeGridItem[] = [
        {
            id: 'resume',
            label: t('settingsProviders.resumeSupportTitle'),
            status: resumeSupportKind === 'supported' || resumeSupportKind === 'supportedExperimental' ? 'positive' : resumeSupportKind === 'notSupported' ? 'negative' : 'neutral',
            detail: resumeSupport,
        },
        {
            id: 'sessionMode',
            label: t('settingsProviders.sessionModeSupportTitle'),
            status: sessionModeKind !== 'none' ? 'positive' : 'negative',
            detail: sessionModeSupport,
        },
        {
            id: 'runtimeSwitch',
            label: t('settingsProviders.runtimeModeSwitchingTitle'),
            status: runtimeSwitchKind !== 'none' ? 'positive' : 'negative',
            detail: runtimeSwitchSupport,
        },
        {
            id: 'localControl',
            label: t('settingsProviders.localControlTitle'),
            status: effectiveRuntimeControlSurface.localControl?.supported === true ? 'positive' : 'negative',
            detail: effectiveRuntimeControlSurface.localControl?.supported === true ? t('settingsProviders.supported') : t('settingsProviders.notSupported'),
        },
    ];
    const authTerminalOpen =
        pane.scopeState?.bottom?.isOpen === true
        && pane.scopeState?.bottom?.activeTabId === PROVIDER_AUTH_TERMINAL_TAB_ID;
    const cancelPendingAuthRefreshesRef = React.useRef<(() => void) | null>(null);
    const triggerProviderAuthRefreshes = React.useCallback(() => {
        cancelPendingAuthRefreshesRef.current?.();
        cancelPendingAuthRefreshesRef.current = scheduleProviderAuthenticationRefreshes({
            refresh: () => {
                cliAvailability.refresh({
                    bypassCache: true,
                    includeLoginStatusForAgentIds: [providerId],
                });
            },
        });
    }, [cliAvailability, providerId]);
    const closeProviderAuthTerminal = React.useCallback(() => {
        setSelectedAuthLaunchKind(null);
        pane.closeBottom();
        triggerProviderAuthRefreshes();
    }, [pane, triggerProviderAuthRefreshes]);
    const handleProviderAuthTerminalExit = React.useCallback(() => {
        closeProviderAuthTerminal();
    }, [closeProviderAuthTerminal]);
    const readFieldValue = React.useCallback((field: ProviderSettingFieldDef) => {
        return readProviderSettingsFieldValue({
            field,
            settings,
            activeServerId,
        });
    }, [activeServerId, settings]);
    const setFieldValue = React.useCallback((field: ProviderSettingFieldDef, value: unknown) => {
        applySettings(buildProviderSettingsFieldPatch({
            field,
            value,
            settings,
            activeServerId,
        }) as Partial<typeof settings>);
    }, [activeServerId, applySettings, settings]);

    React.useEffect(() => {
        return () => {
            cancelPendingAuthRefreshesRef.current?.();
            cancelPendingAuthRefreshesRef.current = null;
        };
    }, []);

    return (
        <View
            ref={popoverBoundaryRef}
            style={{ flex: 1, minHeight: 0 }}
        >
            <AppPaneScopeHost
                scopeId={paneScopeId}
                main={(
                    <ItemList style={{ paddingTop: 0 }}>
                <ContextBar
                    mode="machine_only"
                    machine={{
                        title: t('settingsProviders.targetMachineTitle'),
                        selectedId: primaryMachine?.id ?? null,
                        subtitle: primaryMachine?.metadata?.displayName ?? primaryMachine?.metadata?.host ?? t('machine.detectedCliUnknown'),
                        items: machineItems,
                        onSelect: setSelectedMachineId,
                    }}
                />
                <ItemGroup title={t('settingsProviders.configuration')} footer={t(core.subtitleKey)}>
                    <Item
                        title={primaryMachineLabel ? `${primaryMachineLabel} · ${detectedCliStatus}` : detectedCliStatus}
                        subtitle={core.availability.experimental ? t('settingsProviders.channelExperimental') : t('settingsProviders.channelStable')}
                        icon={<Ionicons name={statusIconName as any} size={29} color={statusIconColor} />}
                        mode="info"
                    />
                    <Item
                        title={t('settingsProviders.enabledTitle')}
                        subtitle={t('settingsProviders.enabledSubtitle')}
                        icon={<Ionicons name="toggle-outline" size={29} color={theme.colors.text.secondary} />}
                        rightElement={<Switch value={backendEnabled} onValueChange={setBackendEnabled} />}
                        showChevron={false}
                        onPress={() => setBackendEnabled(!backendEnabled)}
                    />
                </ItemGroup>

                <ItemGroup
                    title={t('settingsSession.permissions.title')}
                    footer={t('settingsSession.permissions.backendFooter')}
                >
                    <DropdownMenu
                        open={openMenu === 'permissionMode'}
                        onOpenChange={(next) => setOpenMenu(next ? 'permissionMode' : null)}
                        variant="selectable"
                        search={false}
                        selectedId={permissionMode}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        itemTrigger={{
                            title: t('settingsSession.permissions.defaultPermissionModeTitle'),
                            subtitle: getPermissionModeLabelForAgentType(providerId, permissionMode),
                            icon: <Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.state.success.foreground} />,
                        }}
                        items={getPermissionModeOptionsForAgentType(providerId).map((opt) => ({
                            id: opt.value,
                            title: opt.label,
                            subtitle: opt.description,
                            icon: (
                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                    <Ionicons name={opt.icon as any} size={22} color={theme.colors.text.secondary} />
                                </View>
                            ),
                        }))}
                        onSelect={(id) => {
                            const nextMode = getPermissionModeOptionsForAgentType(providerId).find((opt) => opt.value === id)?.value;
                            if (nextMode) setPermissionMode(nextMode);
                            setOpenMenu(null);
                        }}
                    />
                </ItemGroup>

                {supportsConnectedServicesDefaultAuth ? (
                    <ItemGroup
                        title={t('connectedServices.defaultAuth.agentDetailTitle')}
                        footer={t('connectedServices.defaultAuth.agentDetailFooter')}
                    >
                        <ConnectedServicesDefaultAuthRow
                            agentId={providerId}
                            agentTitle={t(core.displayNameKey)}
                            agentCore={core}
                            connectedServicesEnabled={connectedServicesEnabled}
                            accountGroupsEnabled={accountGroupsEnabled}
                            accountProfileConnectedServicesV2={profile?.connectedServicesV2 ?? []}
                            settings={{
                                connectedServicesProfileLabelByKey: settings.connectedServicesProfileLabelByKey ?? {},
                                connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId ?? {},
                                connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
                            }}
                            setDefaultAuthSettings={setDefaultAuthSettings}
                            onOpenConnectedServiceSettings={(serviceId) => router.push({
                                pathname: '/settings/connected-services/[serviceId]',
                                params: { serviceId },
                            })}
                            onReconnectConnectedServiceProfile={(serviceId, profileId) => router.push({
                                pathname: '/settings/connected-services/profile',
                                params: { serviceId, profileId },
                            })}
                        />
                    </ItemGroup>
                ) : null}

                {supportsProviderStateSharingSettings ? (
                    <ConnectedServicesProviderStateSharingBackendGroups
                        settings={normalizedProviderStateSharingSettings}
                        setSettings={setProviderStateSharingSettings}
                        agentIds={[providerId]}
                    />
                ) : null}

                    <ProviderAuthenticationCard
                        providerId={providerId}
                        state={providerAuthentication}
                        showActions={supportsDesktopControls}
                        onCheckNow={() => cliAvailability.refresh({ bypassCache: true, includeLoginStatusForAgentIds: [providerId] })}
                        activeAuthLaunchKind={authTerminalOpen ? selectedAuthLaunchKind : null}
                        onLaunchAuth={(kind) => {
                            if (!providerAuthentication.canLaunchAuth || !supportsDesktopControls) return;
                            const launch = providerAuthentication.authLaunches.find((candidate) => candidate.kind === kind);
                            if (!launch) return;
                            setSelectedAuthLaunchKind(kind);
                            pane.openBottom({ tabId: PROVIDER_AUTH_TERMINAL_TAB_ID });
                        }}
                    />

                <ProviderSettingsFields
                    sections={plugin?.uiSections ?? []}
                    readFieldValue={readFieldValue}
                    setFieldValue={setFieldValue}
                    openMenu={openMenu}
                    setOpenMenu={setOpenMenu}
                    localInputs={localInputs}
                    setLocalInputs={setLocalInputs}
                    popoverBoundaryRef={popoverBoundaryRef}
                />

                {ExtraSectionsComponent ? <ExtraSectionsComponent providerId={providerId} /> : null}

                <ItemGroup title={t('settingsProviders.cliConnection')}>
                    <Item
                        testID="settings-provider-target-machine"
                        title={t('settingsProviders.targetMachineTitle')}
                        subtitle={primaryMachineLabel ?? t('machine.detectedCliUnknown')}
                        icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    <Item
                        testID="settings-provider-detected-cli"
                        title={t('settingsProviders.detectedCliTitle')}
                        subtitle={`${core.cli.detectKey} • ${detectedCliStatus}`}
                        icon={<Ionicons name="code-slash-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    <Item
                        title={t('settingsProviders.installSetupTitle')}
                        subtitle={installSetupSubtitle}
                        icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    <ProviderCliInstallItem
                        machineId={primaryMachine?.id ?? null}
                        serverId={capabilityServerId}
                        capabilityId={providerCliCapabilityId}
                        providerTitle={t(core.displayNameKey)}
                        installed={providerCliAvailable}
                        managedInstalled={providerCliManagedInstalled}
                        installability={cliInstallability}
                    />
                    {supportsDesktopControls && providerCliRuntimeSpec.managedInstall ? (
                        <DropdownMenu
                            open={openMenu === 'cliSourcePreference'}
                            onOpenChange={(next) => setOpenMenu(next ? 'cliSourcePreference' : null)}
                            variant="selectable"
                            search={false}
                            selectedId={providerCliSourcePreference}
                            showCategoryTitles={false}
                            matchTriggerWidth={true}
                            connectToTrigger={true}
                            rowKind="item"
                            popoverBoundaryRef={popoverBoundaryRef}
                            itemTrigger={{
                                title: t('settingsProviders.cliSourcePreference.title'),
                                subtitle: t('settingsProviders.cliSourcePreference.subtitle'),
                                showSelectedSubtitle: false,
                                icon: <Ionicons name="swap-horizontal-outline" size={29} color={theme.colors.text.secondary} />,
                                itemProps: {
                                    testID: 'settings-provider-cli-source-preference',
                                },
                            }}
                            items={[
                                {
                                    id: 'system-first',
                                    title: t('settingsProviders.cliSourcePreference.options.systemFirst.title'),
                                    subtitle: t('settingsProviders.cliSourcePreference.options.systemFirst.subtitle'),
                                    icon: (
                                        <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                            <Ionicons name="desktop-outline" size={22} color={theme.colors.text.secondary} />
                                        </View>
                                    ),
                                },
                                {
                                    id: 'managed-first',
                                    title: t('settingsProviders.cliSourcePreference.options.managedFirst.title'),
                                    subtitle: t('settingsProviders.cliSourcePreference.options.managedFirst.subtitle'),
                                    icon: (
                                        <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                            <Ionicons name="download-outline" size={22} color={theme.colors.text.secondary} />
                                        </View>
                                    ),
                                },
                            ]}
                            onSelect={(id) => {
                                setProviderCliSourcePreference(id as 'system-first' | 'managed-first');
                                setOpenMenu(null);
                            }}
                        />
                    ) : null}
                    {core.cli.installBanner.guideUrl ? (
                        <Item
                            title={t('settingsProviders.setupGuideUrlTitle')}
                            subtitle={core.cli.installBanner.guideUrl}
                            icon={<Ionicons name="link-outline" size={29} color={theme.colors.text.secondary} />}
                            mode="info"
                            copy={core.cli.installBanner.guideUrl}
                        />
                    ) : null}
                    <Item
                        title={t('settingsProviders.connectedServiceTitle')}
                        subtitle={core.uiConnectedService.label}
                        icon={<Ionicons name="cloud-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                </ItemGroup>

                <ItemGroup title={t('settingsProviders.capabilities')}>
                    <BadgeGrid items={capabilityBadges} columns={2} />
                </ItemGroup>

                <ItemGroup title={t('settingsProviders.models')}>
                    <Item
                        title={t('settingsProviders.modelSelectionTitle')}
                        subtitle={core.model.supportsSelection ? t('settingsProviders.supported') : t('settingsProviders.notSupported')}
                        icon={<Ionicons name="list-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    <Item
                        title={t('settingsProviders.freeformModelIdsTitle')}
                        subtitle={core.model.supportsFreeform ? t('settingsProviders.allowed') : t('settingsProviders.notAllowed')}
                        icon={<Ionicons name="create-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    <Item
                        title={t('settingsProviders.defaultModelTitle')}
                        subtitle={defaultModelLabel}
                        icon={<Ionicons name="star-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    <Item
                        title={t('settingsProviders.catalogModelListTitle')}
                        subtitle={catalogModelListText}
                        icon={<Ionicons name="albums-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    <Item
                        title={t('settingsProviders.dynamicModelProbeTitle')}
                        subtitle={dynamicProbe}
                        icon={<Ionicons name="pulse-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    <Item
                        title={t('settingsProviders.nonAcpApplyScopeTitle')}
                        subtitle={nonAcpApplyScope}
                        icon={<Ionicons name="arrow-forward-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    <Item
                        title={t('settingsProviders.acpApplyBehaviorTitle')}
                        subtitle={acpApplyBehavior}
                        icon={<Ionicons name="sync-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    <Item
                        title={t('settingsProviders.acpConfigOptionTitle')}
                        subtitle={core.model.acpModelConfigOptionId ?? t('settingsProviders.notAvailable')}
                        icon={<Ionicons name="settings-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                </ItemGroup>
                    </ItemList>
                )}
                bottomPane={
                    supportsDesktopControls && authTerminalOpen ? (
                        <ProviderAuthenticationTerminalPane
                            providerId={providerId}
                            machineId={providerAuthentication.machineId}
                            machineHomeDir={providerAuthentication.machineHomeDir}
                            authLaunch={providerAuthentication.authLaunches.find((launch) => launch.kind === selectedAuthLaunchKind) ?? null}
                            onRequestClose={closeProviderAuthTerminal}
                            onTerminalExit={handleProviderAuthTerminalExit}
                        />
                    ) : null
                }
            />
        </View>
    );
});

export default React.memo(function ProviderSettingsScreen() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams();
    const rawProviderId = params.providerId;
    const providerId = typeof rawProviderId === 'string' && isAgentId(rawProviderId) ? (rawProviderId as AgentId) : null;

    if (providerId === 'customAcp') {
        return <Redirect href={'/settings/providers' as any} />;
    }

    const core = providerId ? getAgentCore(providerId) : null;
    const plugin = providerId ? getProviderSettingsPlugin(providerId) : null;
    const authPlugin = providerId ? getProviderLocalAuthPlugin(providerId) : null;

    if (!providerId || !core) {
        return <ProviderSettingsNotFound theme={theme} />;
    }

    return (
        <ProviderSettingsScreenInner
            providerId={providerId}
            core={core}
            plugin={plugin}
            authPlugin={authPlugin}
        />
    );
});
