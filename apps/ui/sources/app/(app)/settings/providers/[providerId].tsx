import React from 'react';
import { Platform, View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';

import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { BadgeGrid, type BadgeGridItem } from '@/components/ui/layout/BadgeGrid';
import { useAllMachines, useMachineListByServerId, useSettings } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import {
    getResolvedProviderCatalogEntries,
    resolveProviderCatalogProjection,
    type ResolvedProviderCatalogEntry,
} from '@/agents/backendCatalog/providerCatalogProjection';
import type { ProviderSettingFieldDef, TranslatableText } from '@/agents/providers/shared/providerSettingsPlugin';
import { t } from '@/text';
import { getAgentCliRuntimeSpec, getAgentSessionModeDescriptor, getAgentStaticModels, isAgentAuthProbeSafeForBackgroundChecks } from '@happier-dev/agents';
import {
    buildCatalogModelList,
    classifySessionModeDescriptor,
    describeResumeSupportKind,
} from '@/agents/catalog/providerDetailsInfo';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { useCapabilityInstallability } from '@/hooks/machine/useCapabilityInstallability';
import { ProviderCliInstallItem } from '@/components/settings/providers/ProviderCliInstallItem';
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
import { isLegacyCompatAgentType } from '@/agents/backendCatalog/legacyCompatAgents';
import {
    ConnectedServicesProviderStateSharingSettingsV1Schema,
    type ConnectedServicesDefaultAuthByAgentIdV1,
    type ConnectedServicesProviderStateSharingSettingsV1,
} from '@happier-dev/protocol';
import { ConnectedServicesDefaultAuthRow } from '@/components/settings/connectedServices/ConnectedServicesDefaultAuthRow';
import {
    ConnectedServicesProviderStateSharingBackendGroups,
    resolveProviderStateSharingAgentIds,
} from '@/components/settings/connectedServices/ConnectedServicesProviderStateSharingSettings';

const Ionicons = SafeIonicons;

function resolveLegacyCompatProviderRouteRedirect(params: Readonly<{
    providerId: string;
    daemonMergedProjectionInputs?: {
        mergedProviderProjectionById?: Readonly<Record<string, unknown>> | null;
        mergedBackendProjectionById?: Readonly<Record<string, { providerId?: unknown }>> | null;
    } | null;
}>): string | null {
    if (!isLegacyCompatAgentType(params.providerId)) {
        return null;
    }

    const providerIds = new Set<string>();
    for (const providerId of Object.keys(params.daemonMergedProjectionInputs?.mergedProviderProjectionById ?? {})) {
        const normalizedProviderId = providerId.trim();
        if (!normalizedProviderId || isLegacyCompatAgentType(normalizedProviderId)) {
            continue;
        }
        providerIds.add(normalizedProviderId);
    }
    for (const projection of Object.values(params.daemonMergedProjectionInputs?.mergedBackendProjectionById ?? {})) {
        const normalizedProviderId = String(projection.providerId ?? '').trim();
        if (!normalizedProviderId || isLegacyCompatAgentType(normalizedProviderId)) {
            continue;
        }
        providerIds.add(normalizedProviderId);
    }

    return providerIds.size === 1 ? [...providerIds][0] ?? null : null;
}

function resolveProviderSettingsText(input: TranslatableText | undefined): string | undefined {
    if (input === undefined) return undefined;
    if (typeof input === 'string') return input;
    return t(input.key);
}

const PROVIDER_AUTH_TERMINAL_TAB_ID = 'provider-auth-terminal';

function resolveProjectionIconName(projection: ResolvedProviderCatalogEntry): string {
    return projection.iconAgentId ? getAgentCore(projection.iconAgentId).ui.agentPickerIconName : projection.iconName;
}

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

const ProviderSettingsNumberField = React.memo(function ProviderSettingsNumberField(props: {
    field: any;
    value: unknown;
    theme: any;
    localInputs: Record<string, string>;
    setLocalInputs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    setSetting: (key: string, value: unknown) => void;
}) {
    const { field, value, theme, localInputs, setLocalInputs, setSetting } = props;

    const rawFromSetting = typeof value === 'number' ? String(value) : '';
    const externalRaw = value === null || value === undefined ? '' : rawFromSetting;
    const raw = Object.prototype.hasOwnProperty.call(localInputs, field.key)
        ? localInputs[field.key]!
        : externalRaw;
    const parsed = raw.trim().length === 0 ? null : Number(raw);

    const isStepAligned = (n: number, step: number, base: number) => {
        if (!Number.isFinite(n) || !Number.isFinite(step) || step <= 0) return true;
        const scaled = (n - base) / step;
        const rounded = Math.round(scaled);
        return Math.abs(scaled - rounded) < 1e-9;
    };

    const spec = field.numberSpec;
    const isValid =
        parsed === null
            ? true
            : Number.isFinite(parsed)
              && (spec?.min == null || parsed >= spec.min)
              && (spec?.max == null || parsed <= spec.max)
              && (spec?.step == null || isStepAligned(parsed, spec.step, spec?.min ?? 0));
    const showError = raw.trim().length > 0 && !isValid;

    const clearLocalInput = React.useCallback(() => {
        setLocalInputs((prev) => {
            if (!(field.key in prev)) return prev;
            const next = { ...prev };
            delete next[field.key];
            return next;
        });
    }, [field.key, setLocalInputs]);

    const [focused, setFocused] = React.useState(false);
    const prevExternalRawRef = React.useRef(externalRaw);
    React.useEffect(() => {
        const prevExternalRaw = prevExternalRawRef.current;
        prevExternalRawRef.current = externalRaw;
        if (focused) return;
        if (prevExternalRaw === externalRaw) return;
        clearLocalInput();
    }, [clearLocalInput, externalRaw, focused]);

	    return (
	        <View style={[styles.inputContainer, { paddingTop: 0 }]}>
	            <Text style={styles.fieldLabel}>{resolveProviderSettingsText(field.title) ?? ''}</Text>
	            {field.subtitle && (
	                <Text style={{ ...Typography.default(), fontSize: 13, color: theme.colors.text.secondary, marginBottom: 6 }}>
	                    {resolveProviderSettingsText(field.subtitle) ?? ''}
	                </Text>
	            )}
            <TextInput
                style={[
                    styles.textInput,
                    showError ? { borderWidth: 1, borderColor: theme.colors.state.danger.foreground } : null,
                ]}
                placeholder={resolveProviderSettingsText(field.numberSpec?.placeholder) ?? t('common.optional')}
                placeholderTextColor={theme.colors.input.placeholder}
                value={raw}
                keyboardType={Platform.select({ ios: 'number-pad', default: 'numeric' })}
                onFocus={() => setFocused(true)}
                onChangeText={(next) => {
                    setLocalInputs((prev) => ({ ...prev, [field.key]: next }));
                    const trimmed = next.trim();
                    if (!trimmed) {
                        setSetting(field.key, null);
                        return;
                    }
                    const n = Number(trimmed);
                    if (!Number.isFinite(n)) {
                        return;
                    }
                    if (field.numberSpec?.min != null && n < field.numberSpec.min) {
                        return;
                    }
                    if (field.numberSpec?.max != null && n > field.numberSpec.max) {
                        return;
                    }
                    if (field.numberSpec?.step != null && !isStepAligned(n, field.numberSpec.step, field.numberSpec?.min ?? 0)) {
                        return;
                    }
                    setSetting(field.key, n);
                }}
                onBlur={() => {
                    setFocused(false);
                    const trimmed = raw.trim();
                    if (!trimmed) {
                        clearLocalInput();
                        return;
                    }
                    if (isValid) {
                        clearLocalInput();
                    }
                }}
                autoCapitalize="none"
                autoCorrect={false}
            />
            {showError && (
                <Text style={{ ...Typography.default(), fontSize: 12, color: theme.colors.state.danger.foreground, marginTop: 6 }}>
                    {t('settingsProviders.invalidNumber')}
                </Text>
            )}
        </View>
    );
});

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

const ProviderSettingsFallbackScreenInner = React.memo(function ProviderSettingsFallbackScreenInner(props: Readonly<{
    projection: ResolvedProviderCatalogEntry;
}>) {
    const { theme } = useUnistyles();
    const settings = useSettings();
    const applySettings = useApplySettings();
    const providerTargetKey = props.projection.backendTargetKey;
    const backendEnabledByTargetKey = settings.backendEnabledByTargetKey;
    const backendEnabled = providerTargetKey ? backendEnabledByTargetKey?.[providerTargetKey] !== false : null;
    const setBackendEnabled = React.useCallback((next: boolean) => {
        if (!providerTargetKey) return;
        applySettings({
            backendEnabledByTargetKey: {
                ...(backendEnabledByTargetKey ?? {}),
                [providerTargetKey]: next,
            },
        });
    }, [applySettings, backendEnabledByTargetKey, providerTargetKey]);
    const title = props.projection.title;
    const subtitle = props.projection.subtitle ?? props.projection.providerId;
    const ExtraSectionsComponent = props.projection.behavior?.ExtraSectionsComponent ?? null;
    const iconName = resolveProjectionIconName(props.projection);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={title} footer={t('settingsProviders.footer')}>
                <Item
                    title={title}
                    subtitle={subtitle}
                    icon={<Ionicons name={iconName as any} size={29} color={theme.colors.text.secondary} />}
                    mode="info"
                />
                <Item
                    title={t('settingsProviders.enabledTitle')}
                    subtitle={t('settingsProviders.enabledSubtitle')}
                    icon={<Ionicons name="toggle-outline" size={29} color={theme.colors.text.secondary} />}
                    rightElement={backendEnabled === null ? undefined : <Switch value={backendEnabled} onValueChange={setBackendEnabled} />}
                    showChevron={false}
                    onPress={() => {
                        if (backendEnabled === null) return;
                        setBackendEnabled(!backendEnabled);
                    }}
                />
            </ItemGroup>
            {ExtraSectionsComponent ? <ExtraSectionsComponent providerId={props.projection.providerId} /> : null}
            <ItemGroup title={t('settingsProviders.configuration')} footer={t('settingsProviders.notFoundSubtitle')}>
                <Item
                    title={props.projection.isBuiltIn ? t('settingsProviders.notAvailable') : props.projection.title}
                    subtitle={props.projection.isBuiltIn ? t('settingsProviders.notFoundSubtitle') : subtitle}
                    icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.text.secondary} />}
                    mode="info"
                />
            </ItemGroup>
        </ItemList>
    );
});

const ProviderSettingsScreenInner = React.memo(function ProviderSettingsScreenInner(props: Readonly<{
    providerId: string;
    runtimeProviderId: AgentId | null;
    core: ProviderSettingsCore | null;
    projection: ResolvedProviderCatalogEntry;
    descriptor: ResolvedProviderCatalogEntry['descriptor'];
    behavior: ResolvedProviderCatalogEntry['behavior'];
    authPlugin: ResolvedProviderCatalogEntry['authPlugin'];
    activeServerId: string | null;
    capabilityServerId: string | null;
    activeServerMachines: readonly Machine[];
    selectedMachineId: string | null;
    setSelectedMachineId: (machineId: string | null) => void;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const supportsDesktopControls = isTauriDesktop();
    const {
        providerId,
        runtimeProviderId,
        core,
        projection,
        descriptor,
        behavior,
        authPlugin,
        activeServerId,
        capabilityServerId,
        activeServerMachines,
        selectedMachineId,
        setSelectedMachineId,
    } = props;
    const providerIconName = resolveProjectionIconName(projection);
    const profile = useProfile();
    const settings = useSettings();
    const paneScopeId = React.useMemo(
        () => `settings:provider:${providerId}`,
        [providerId],
    );
    const pane = useAppPaneScope(paneScopeId);
    const applySettings = useApplySettings();
    const connectedServicesEnabled = useFeatureEnabled('connectedServices');
    const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');

    const popoverBoundaryRef = React.useRef<any>(null);
    const [openMenu, setOpenMenu] = React.useState<null | string>(null);
    const [localInputs, setLocalInputs] = React.useState<Record<string, string>>({});

    const setSetting = React.useCallback((key: string, value: unknown) => {
        applySettings({ [key]: value } as Partial<typeof settings>);
    }, [applySettings]);

    const sessionModeDescriptor = runtimeProviderId ? getAgentSessionModeDescriptor(runtimeProviderId) : null;
    const agentCliRuntimeSpec = runtimeProviderId ? getAgentCliRuntimeSpec(runtimeProviderId) : null;
    const providerTargetKey = projection.backendTargetKey;
    const backendEnabledByTargetKey = settings.backendEnabledByTargetKey;
    const backendEnabled = providerTargetKey ? backendEnabledByTargetKey?.[providerTargetKey] !== false : null;
    const setBackendEnabled = (next: boolean) => {
        if (!providerTargetKey) return;
        applySettings({
            backendEnabledByTargetKey: {
                ...(backendEnabledByTargetKey ?? {}),
                [providerTargetKey]: next,
            },
        });
    };

    const defaultPermissionByTargetKey = settings.sessionDefaultPermissionModeByTargetKey;
    const permissionMode = providerTargetKey ? (defaultPermissionByTargetKey?.[providerTargetKey] ?? 'default') : 'default';
    const setPermissionMode = (next: PermissionMode) => {
        if (!providerTargetKey) return;
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
        && runtimeProviderId != null
        && (core?.connectedServices?.supportedServiceIds ?? []).length > 0;
    const supportsProviderStateSharingSettings =
        connectedServicesEnabled
        && runtimeProviderId != null
        && resolveProviderStateSharingAgentIds([runtimeProviderId]).length > 0;

    const backendCliSourcePreferenceByTargetKey = settings.backendCliSourcePreferenceByTargetKey;
    const providerCliSourcePreference =
        providerTargetKey && agentCliRuntimeSpec
            ? backendCliSourcePreferenceByTargetKey?.[providerTargetKey] ?? agentCliRuntimeSpec.sourcePreferenceDefault
            : 'system-first';
    const setProviderCliSourcePreference = (next: 'system-first' | 'managed-first') => {
        if (!providerTargetKey) return;
        applySettings({
            backendCliSourcePreferenceByTargetKey: {
                ...(backendCliSourcePreferenceByTargetKey ?? {}),
                [providerTargetKey]: next,
            },
        });
    };

    const effectiveRuntimeControlSurface = React.useMemo(
        () => runtimeProviderId
            ? resolveEffectiveConfiguredRuntimeControlSurface({
                agentId: runtimeProviderId,
                accountSettings: settings as Record<string, unknown>,
            })
            : null,
        [runtimeProviderId, settings],
    );
    const runtimeVendorResumeSupport = effectiveRuntimeControlSurface?.resume.vendorResume;
    const resumeSupportKind = describeResumeSupportKind({
        supportsVendorResume: runtimeVendorResumeSupport === 'supported' || runtimeVendorResumeSupport === 'experimental',
        experimental: runtimeVendorResumeSupport === 'experimental',
    });
    const resumeSupport = {
        supported: t('settingsProviders.resumeSupportSupported'),
        supportedExperimental: t('settingsProviders.resumeSupportSupportedExperimental'),
        notSupported: t('settingsProviders.resumeSupportNotSupported'),
    }[resumeSupportKind];
    const { sessionModeKind, runtimeSwitchKind } = sessionModeDescriptor
        ? classifySessionModeDescriptor(sessionModeDescriptor)
        : { sessionModeKind: 'none', runtimeSwitchKind: 'none' as const };
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
        providerNative: t('settingsProviders.runtimeSwitchProviderNative'),
    }[runtimeSwitchKind];
    const catalogModelList = buildCatalogModelList({
        defaultMode: core?.model.defaultMode ?? 'chat',
        allowedModes: core?.model.allowedModes ?? ['chat'],
        staticModels: core ? getAgentStaticModels(core.id) : [],
    });
    const defaultModelLabel = catalogModelList[0] ?? core?.model.defaultMode ?? t('settingsProviders.notAvailable');
    const catalogModelListText = catalogModelList.length > 0
        ? catalogModelList.join(', ')
        : t('settingsProviders.catalogModelListEmpty');
    const dynamicProbe = core?.model.dynamicProbe === 'static-only'
        ? t('settingsProviders.dynamicModelProbeStaticOnly')
        : t('settingsProviders.dynamicModelProbeAuto');
    const nonAcpApplyScope = core?.model.nonAcpApplyScope === 'spawn_only'
        ? t('settingsProviders.nonAcpApplyScopeSpawnOnly')
        : t('settingsProviders.nonAcpApplyScopeNextPrompt');
    const acpApplyBehavior = core?.model.acpApplyBehavior === 'set_model'
        ? t('settingsProviders.acpApplyBehaviorSetModel')
        : core?.model.acpApplyBehavior === 'restart_session'
            ? t('settingsProviders.acpApplyBehaviorRestartSession')
            : t('settingsProviders.notAvailable');
    const installInfo = !core
        ? t('settingsProviders.notAvailable')
        : core.cli.installBanner.installKind === 'command'
            ? (core.cli.installBanner.installCommand ?? t('settingsProviders.installInfoSeeSetupGuide'))
            : t('settingsProviders.installInfoUseProviderCliInstaller');

    type MachineRecord = (typeof activeServerMachines)[number];
    const primaryMachine = activeServerMachines.find((machine) => machine.id === selectedMachineId) ?? null;
    const automaticLoginStatusAgentIds = React.useMemo(
        () => (runtimeProviderId && isAgentAuthProbeSafeForBackgroundChecks(runtimeProviderId) ? [runtimeProviderId] : []),
        [runtimeProviderId],
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
        agentIds: runtimeProviderId ? [runtimeProviderId] : [],
        includeLoginStatus: Boolean(runtimeProviderId),
        includeLoginStatusForAgentIds: automaticLoginStatusAgentIds,
        serverId: capabilityServerId,
    });
    const providerAuthentication = useProviderAuthenticationState({
        providerId: runtimeProviderId,
        cliAvailability,
        authPlugin,
        primaryMachine,
    });
    const providerCliAvailable = runtimeProviderId ? cliAvailability.available[runtimeProviderId] : null;
    const providerCliManagedInstalled = runtimeProviderId ? cliAvailability.resolutionSource[runtimeProviderId] === 'managed' : false;
    const cliInstallability = useCapabilityInstallability({
        machineId: primaryMachine?.id ?? null,
        serverId: capabilityServerId,
        capabilityId: runtimeProviderId && core ? `cli.${core.cli.detectKey}` as any : null,
        timeoutMs: 5000,
    });
    const ExtraSectionsComponent = behavior?.ExtraSectionsComponent ?? null;
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
            status: effectiveRuntimeControlSurface?.localControl?.supported === true ? 'positive' : 'negative',
            detail: effectiveRuntimeControlSurface?.localControl?.supported === true ? t('settingsProviders.supported') : t('settingsProviders.notSupported'),
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
                if (!runtimeProviderId) return;
                cliAvailability.refresh({
                    bypassCache: true,
                    includeLoginStatusForAgentIds: [runtimeProviderId],
                });
            },
        });
    }, [cliAvailability, runtimeProviderId]);
    const closeProviderAuthTerminal = React.useCallback(() => {
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

    const main = (
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
                <ItemGroup title={t('settingsProviders.configuration')} footer={core ? t(core.subtitleKey) : t('settingsProviders.footer')}>
                <Item
                    title={projection.title}
                    subtitle={projection.subtitle ?? projection.providerId}
                    icon={<Ionicons name={providerIconName as any} size={29} color={theme.colors.text.secondary} />}
                    mode="info"
                />
                <Item
                    title={primaryMachineLabel ? `${primaryMachineLabel} · ${detectedCliStatus}` : detectedCliStatus}
                    subtitle={projection.channel === 'experimental' ? t('settingsProviders.channelExperimental') : t('settingsProviders.channelStable')}
                    icon={<Ionicons name={statusIconName as any} size={29} color={statusIconColor} />}
                        mode="info"
                    />
                    {providerTargetKey ? (
                        <Item
                            title={t('settingsProviders.enabledTitle')}
                            subtitle={t('settingsProviders.enabledSubtitle')}
                            icon={<Ionicons name="toggle-outline" size={29} color={theme.colors.text.secondary} />}
                            rightElement={<Switch value={backendEnabled ?? undefined} onValueChange={setBackendEnabled} />}
                            showChevron={false}
                            onPress={() => {
                                if (backendEnabled === null) return;
                                setBackendEnabled(!backendEnabled);
                            }}
                        />
                    ) : null}
                </ItemGroup>

                {runtimeProviderId && providerTargetKey ? (
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
                            subtitle: getPermissionModeLabelForAgentType(runtimeProviderId, permissionMode),
                            icon: <Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.state.success.foreground} />,
                        }}
                        items={getPermissionModeOptionsForAgentType(runtimeProviderId).map((opt) => ({
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
                            const nextMode = getPermissionModeOptionsForAgentType(runtimeProviderId).find((opt) => opt.value === id)?.value;
                            if (nextMode) setPermissionMode(nextMode);
                            setOpenMenu(null);
                        }}
                    />
                    </ItemGroup>
                ) : null}

                {supportsConnectedServicesDefaultAuth && runtimeProviderId && core ? (
                    <ItemGroup
                        title={t('connectedServices.defaultAuth.agentDetailTitle')}
                        footer={t('connectedServices.defaultAuth.agentDetailFooter')}
                    >
                        <ConnectedServicesDefaultAuthRow
                            agentId={runtimeProviderId}
                            agentTitle={t(core.displayNameKey)}
                            agentCore={core}
                            connectedServicesEnabled={connectedServicesEnabled}
                            accountGroupsEnabled={accountGroupsEnabled}
                            accountProfileConnectedServicesV2={profile.connectedServicesV2 ?? []}
                            settings={{
                                connectedServicesProfileLabelByKey: settings.connectedServicesProfileLabelByKey ?? {},
                                connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId ?? {},
                                connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
                            }}
                            setDefaultAuthSettings={setDefaultAuthSettings}
                            onOpenConnectedServicesSettings={(serviceId) => router.push({
                                pathname: '/(app)/settings/connected-services/[serviceId]',
                                params: { serviceId },
                            } as any)}
                        />
                    </ItemGroup>
                ) : null}

                {supportsProviderStateSharingSettings && runtimeProviderId ? (
                    <ConnectedServicesProviderStateSharingBackendGroups
                        settings={normalizedProviderStateSharingSettings}
                        setSettings={setProviderStateSharingSettings}
                        agentIds={[runtimeProviderId]}
                    />
                ) : null}

                    <ProviderAuthenticationCard
                        providerId={providerId}
                        runtimeProviderId={runtimeProviderId}
                        state={providerAuthentication}
                        showActions={supportsDesktopControls}
                        onCheckNow={() => {
                            if (!runtimeProviderId) return;
                            cliAvailability.refresh({ bypassCache: true, includeLoginStatusForAgentIds: [runtimeProviderId] });
                        }}
                        onLaunchLogin={() => {
                            if (!providerAuthentication.canLaunchLogin || !supportsDesktopControls || !runtimeProviderId) return;
                            pane.openBottom({ tabId: PROVIDER_AUTH_TERMINAL_TAB_ID });
                        }}
                    />

                {(descriptor?.uiSections ?? []).map((section) => (
                    <ItemGroup
                        key={section.id}
	                        title={resolveProviderSettingsText(section.title)}
	                        footer={resolveProviderSettingsText(section.footer)}
                    >
                        {section.fields.map((field) => {
                            const value = readFieldValue(field);

                            if (field.kind === 'boolean') {
                                const boolValue = Boolean(value);
	                                return (
	                                    <Item
	                                        key={field.key}
	                                        title={resolveProviderSettingsText(field.title) ?? ''}
	                                        subtitle={resolveProviderSettingsText(field.subtitle)}
	                                        icon={<Ionicons name="options-outline" size={29} color={theme.colors.text.secondary} />}
	                                        rightElement={<Switch value={boolValue} onValueChange={(v) => setFieldValue(field, v)} />}
	                                        showChevron={false}
	                                        onPress={() => setFieldValue(field, !boolValue)}
	                                    />
	                                );
                            }

                            if (field.kind === 'multiEnum') {
                                const options = field.enumOptions ?? [];
	                                if (options.length === 0) {
	                                    return (
	                                        <Item
	                                            key={field.key}
	                                            title={resolveProviderSettingsText(field.title) ?? ''}
	                                            subtitle={resolveProviderSettingsText(field.subtitle) ?? t('settingsProviders.noOptionsAvailable')}
	                                            icon={<Ionicons name="list-outline" size={29} color={theme.colors.text.secondary} />}
	                                            showChevron={false}
	                                            disabled={true}
	                                        />
	                                    );
	                                }

                                const selectedRaw = Array.isArray(value) ? value : [];
                                const selectedSet = new Set<string>(
                                    selectedRaw.filter((v): v is string => typeof v === 'string'),
                                );
	                                const orderedSelectedOptions = options.filter((opt) => selectedSet.has(opt.id));
	                                const detail =
	                                    orderedSelectedOptions.length === 0
	                                        ? t('common.none')
	                                        : orderedSelectedOptions
	                                            .map((opt) => resolveProviderSettingsText(opt.title))
	                                            .filter((label): label is string => Boolean(label))
	                                            .join(', ');

                                return (
                                    <DropdownMenu
                                        key={field.key}
                                        open={openMenu === field.key}
                                        onOpenChange={(next) => setOpenMenu(next ? field.key : null)}
                                        variant="selectable"
                                        search={false}
                                        selectedId={null}
                                        showCategoryTitles={false}
                                        matchTriggerWidth={true}
                                        connectToTrigger={true}
                                        rowKind="item"
                                        popoverBoundaryRef={popoverBoundaryRef}
                                        closeOnSelect={false}
                                        trigger={({ toggle, open }: any) => (
	                                            <Item
	                                                title={resolveProviderSettingsText(field.title) ?? ''}
	                                                subtitle={resolveProviderSettingsText(field.subtitle)}
	                                                detail={detail}
	                                                icon={<Ionicons name="list-outline" size={29} color={theme.colors.text.secondary} />}
                                                rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.text.secondary} />}
                                                onPress={toggle}
                                                showChevron={false}
                                                selected={false}
                                            />
                                        )}
	                                        items={options.map((opt) => {
	                                            const checked = selectedSet.has(opt.id);
	                                            return {
	                                                id: opt.id,
	                                                title: resolveProviderSettingsText(opt.title) ?? '',
	                                                subtitle: resolveProviderSettingsText(opt.subtitle),
	                                                icon: (
	                                                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
	                                                        <Ionicons
	                                                            name={checked ? 'checkbox-outline' : 'square-outline'}
                                                            size={22}
                                                            color={theme.colors.text.secondary}
                                                        />
                                                    </View>
                                                ),
                                            };
                                        })}
                                        onSelect={(id) => {
                                            const next = new Set(selectedSet);
                                            if (next.has(id)) next.delete(id);
                                            else next.add(id);
                                            const ordered = options.map((opt) => opt.id).filter((optId) => next.has(optId));
                                            setFieldValue(field, ordered);
                                        }}
                                    />
                                );
                            }

	                            if (field.kind === 'enum') {
	                                const options = field.enumOptions ?? [];
	                                if (options.length === 0) {
	                                    return (
	                                        <Item
	                                            key={field.key}
	                                            title={resolveProviderSettingsText(field.title) ?? ''}
	                                            subtitle={resolveProviderSettingsText(field.subtitle) ?? t('settingsProviders.noOptionsAvailable')}
	                                            icon={<Ionicons name="list-outline" size={29} color={theme.colors.text.secondary} />}
	                                            showChevron={false}
	                                            disabled={true}
	                                        />
                                    );
                                }
                                const currentId = typeof value === 'string' ? value : (options[0]?.id ?? '');

                                return (
                                    <DropdownMenu
                                        key={field.key}
                                        open={openMenu === field.key}
                                        onOpenChange={(next) => setOpenMenu(next ? field.key : null)}
                                        variant="selectable"
                                        search={false}
                                        selectedId={currentId}
                                        showCategoryTitles={false}
                                        matchTriggerWidth={true}
                                        connectToTrigger={true}
	                                        rowKind="item"
	                                        popoverBoundaryRef={popoverBoundaryRef}
                                        itemTrigger={{
                                            title: resolveProviderSettingsText(field.title) ?? '',
                                            subtitle: resolveProviderSettingsText(field.subtitle) ?? undefined,
                                            showSelectedSubtitle: field.subtitle ? false : undefined,
                                            icon: <Ionicons name="list-outline" size={29} color={theme.colors.text.secondary} />,
                                            itemProps: {
                                                testID: `settings-provider-field-${field.key}`,
                                            },
                                        }}
                                        items={options.map((opt) => ({
                                            id: opt.id,
                                            title: resolveProviderSettingsText(opt.title) ?? '',
                                            subtitle: resolveProviderSettingsText(opt.subtitle),
	                                            icon: (
	                                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
	                                                    <Ionicons name="radio-button-on-outline" size={22} color={theme.colors.text.secondary} />
	                                                </View>
	                                            ),
	                                        }))}
                                        onSelect={(id) => {
                                            setFieldValue(field, id);
                                            setOpenMenu(null);
                                        }}
                                    />
                                );
                            }

                            if (field.kind === 'number') {
                                return (
                                    <ProviderSettingsNumberField
                                        key={field.key}
                                        field={field}
                                        value={value}
                                        theme={theme}
                                        localInputs={localInputs}
                                        setLocalInputs={setLocalInputs}
                                        setSetting={(key, nextValue) => {
                                            if (key !== field.key) return;
                                            setFieldValue(field, nextValue);
                                        }}
                                    />
                                );
                            }

                            if (field.kind === 'json' || field.kind === 'text') {
                                const textValue = typeof value === 'string' ? value : '';
                                const localValue = localInputs[field.key] ?? textValue;
                                const jsonError =
                                    field.kind === 'json' && localValue.trim().length > 0
                                        ? (() => {
                                            try {
                                                JSON.parse(localValue);
                                                return null;
                                            } catch {
                                                return t('settingsProviders.invalidJson');
                                            }
                                        })()
                                        : null;

                                const commitJsonIfValid = () => {
                                    if (field.kind !== 'json') return;
                                    if (jsonError) return;
                                    setFieldValue(field, localValue);
                                    setLocalInputs((prev) => {
                                        if (!(field.key in prev)) return prev;
                                        const next = { ...prev };
                                        delete next[field.key];
                                        return next;
                                    });
                                };

	                                return (
	                                    <View key={field.key} style={[styles.inputContainer, { paddingTop: 0 }]}>
	                                        <Text style={styles.fieldLabel}>{resolveProviderSettingsText(field.title) ?? ''}</Text>
	                                        {field.subtitle && (
	                                            <Text style={{ ...Typography.default(), fontSize: 13, color: theme.colors.text.secondary, marginBottom: 6 }}>
	                                                {resolveProviderSettingsText(field.subtitle) ?? ''}
	                                            </Text>
	                                        )}
                                        <TextInput
                                            style={[
                                                styles.textInput,
                                                {
                                                    minHeight: field.kind === 'json' ? 110 : 44,
                                                    textAlignVertical: field.kind === 'json' ? 'top' : 'center',
                                                } as any,
                                                jsonError ? { borderWidth: 1, borderColor: theme.colors.state.danger.foreground } : null,
                                            ]}
                                            multiline={field.kind === 'json'}
                                            placeholder={field.kind === 'json' ? '{ }' : ''}
                                            placeholderTextColor={theme.colors.input.placeholder}
                                            value={field.kind === 'json' ? localValue : textValue}
                                            onChangeText={(next) => {
                                                if (field.kind === 'json') {
                                                    setLocalInputs((prev) => ({ ...prev, [field.key]: next }));
                                                    return;
                                                }
                                                setFieldValue(field, next);
                                            }}
                                            onEndEditing={commitJsonIfValid}
                                            onBlur={commitJsonIfValid}
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                        />
                                        {jsonError && (
                                            <Text style={{ ...Typography.default(), fontSize: 12, color: theme.colors.state.danger.foreground, marginTop: 6 }}>
                                                {jsonError}
                                            </Text>
                                        )}
                                    </View>
                                );
                            }

                            return null;
                        })}
                    </ItemGroup>
                ))}

                {ExtraSectionsComponent ? <ExtraSectionsComponent providerId={providerId} /> : null}

                <ItemGroup title={t('settingsProviders.cliConnection')}>
                    <Item
                        testID="settings-provider-target-machine"
                        title={t('settingsProviders.targetMachineTitle')}
                        subtitle={primaryMachineLabel ?? t('machine.detectedCliUnknown')}
                        icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    {core ? (
                        <Item
                            testID="settings-provider-detected-cli"
                            title={t('settingsProviders.detectedCliTitle')}
                            subtitle={`${core.cli.detectKey} • ${detectedCliStatus}`}
                            icon={<Ionicons name="code-slash-outline" size={29} color={theme.colors.text.secondary} />}
                            mode="info"
                        />
                    ) : null}
                    <Item
                        title={t('settingsProviders.installSetupTitle')}
                        subtitle={installSetupSubtitle}
                        icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    {core ? (
                        <ProviderCliInstallItem
                            machineId={primaryMachine?.id ?? null}
                            serverId={capabilityServerId}
                            capabilityId={`cli.${core.cli.detectKey}` as any}
                            providerTitle={projection.title}
                            installed={providerCliAvailable}
                            managedInstalled={providerCliManagedInstalled}
                            installability={cliInstallability}
                        />
                    ) : null}
                    {supportsDesktopControls && agentCliRuntimeSpec?.managedInstall ? (
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
                    {core?.cli.installBanner.guideUrl ? (
                        <Item
                            title={t('settingsProviders.setupGuideUrlTitle')}
                            subtitle={core.cli.installBanner.guideUrl}
                            icon={<Ionicons name="link-outline" size={29} color={theme.colors.text.secondary} />}
                            mode="info"
                            copy={core.cli.installBanner.guideUrl}
                        />
                    ) : null}
                    {core ? (
                        <Item
                            title={t('settingsProviders.connectedServiceTitle')}
                            subtitle={core.uiConnectedService.label}
                            icon={<Ionicons name="cloud-outline" size={29} color={theme.colors.text.secondary} />}
                            mode="info"
                        />
                    ) : null}
                </ItemGroup>

                {core ? (
                    <>
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
                    </>
                ) : null}
            </ItemList>
    );

    return (
        <View
            ref={popoverBoundaryRef}
            style={{ flex: 1, minHeight: 0 }}
        >
            {supportsDesktopControls ? (
                <AppPaneScopeHost
                    scopeId={paneScopeId}
                    main={main}
                    bottomPane={
                        authTerminalOpen && providerAuthentication.loginLaunch && runtimeProviderId ? (
                            <ProviderAuthenticationTerminalPane
                                providerId={runtimeProviderId}
                                machineId={providerAuthentication.machineId}
                                machineHomeDir={providerAuthentication.machineHomeDir}
                                loginLaunch={providerAuthentication.loginLaunch}
                                onRequestClose={closeProviderAuthTerminal}
                                onTerminalExit={handleProviderAuthTerminalExit}
                            />
                        ) : null
                    }
                />
            ) : (
                // Provider settings do not require the multi-pane host in the browser.
                main
            )}
        </View>
    );
});

export default React.memo(function ProviderSettingsScreen() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams();
    const settings = useSettings();
    const machines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const activeServerSnapshot = useActiveServerSnapshot();
    const activeServerId = React.useMemo(() => {
        const value = activeServerSnapshot.serverId;
        return typeof value === 'string' && value.trim().length > 0 ? value : null;
    }, [activeServerSnapshot.serverId]);
    const capabilityServerId = React.useMemo(
        () => String(activeServerSnapshot.serverId ?? '').trim() || null,
        [activeServerSnapshot.serverId],
    );
    const rawProviderId = params.providerId;
    const normalizedProviderId = typeof rawProviderId === 'string' ? rawProviderId.trim() : '';

    const activeServerMachineIds = React.useMemo(() => {
        return resolveActiveServerMachineIds({
            capabilityServerId,
            machineListByServerId,
            machines,
        });
    }, [capabilityServerId, machineListByServerId, machines]);
    const activeServerMachines = React.useMemo(() => {
        if (activeServerMachineIds.length === 0) return [] as typeof machines;
        const machineMap = new Map(machines.map((machine) => [machine.id, machine] as const));
        return activeServerMachineIds
            .map((machineId: string) => machineMap.get(machineId) ?? null)
            .filter((machine): machine is (typeof machines)[number] => machine !== null);
    }, [activeServerMachineIds, machines]);
    const defaultMachineId = activeServerMachines[0]?.id ?? null;
    const {
        machineId: selectedMachineId,
        setMachineId: setSelectedMachineId,
    } = useContextBarSelection({
        selectionKey: `providerSettings.${normalizedProviderId}`,
        defaultMachineId,
    });
    React.useEffect(() => {
        if (selectedMachineId && activeServerMachineIds.includes(selectedMachineId)) {
            return;
        }
        setSelectedMachineId(defaultMachineId);
    }, [activeServerMachineIds, defaultMachineId, selectedMachineId, setSelectedMachineId]);
    const projectionMachineId = selectedMachineId ?? defaultMachineId;
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: projectionMachineId,
        serverId: activeServerId,
        enabled: Boolean(projectionMachineId && activeServerId),
    });
    const daemonMergedProjectionInputs = daemonMergedProjection.phase === 'ready' ? daemonMergedProjection.inputs : null;
    const legacyCompatProviderRedirectId = React.useMemo(() => resolveLegacyCompatProviderRouteRedirect({
        providerId: normalizedProviderId,
        daemonMergedProjectionInputs,
    }), [daemonMergedProjectionInputs, normalizedProviderId]);
    const waitingForLegacyCompatProjection = isLegacyCompatAgentType(normalizedProviderId)
        && daemonMergedProjection.phase === 'loading'
        && Boolean(projectionMachineId && activeServerId);

    if (waitingForLegacyCompatProjection) {
        return null;
    }
    if (isLegacyCompatAgentType(normalizedProviderId)) {
        if (legacyCompatProviderRedirectId) {
            return (
                <Redirect
                    href={{
                        pathname: '/(app)/settings/providers/[providerId]',
                        params: { providerId: legacyCompatProviderRedirectId },
                    } as any}
                />
            );
        }
        return <Redirect href={'/(app)/settings/providers' as any} />;
    }

    const providerProjectionParams = React.useMemo(() => ({
        enabledAgentIds: [],
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
        acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
        mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
        mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
    }), [
        daemonMergedProjectionInputs?.mergedBackendProjectionById,
        daemonMergedProjectionInputs?.mergedProviderProjectionById,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
    ]);
    const knownProviderIds = React.useMemo(() => {
        return new Set(
            getResolvedProviderCatalogEntries(providerProjectionParams).map((entry) => entry.providerId),
        );
    }, [providerProjectionParams]);
    const projection = React.useMemo(() => {
        if (!normalizedProviderId || !knownProviderIds.has(normalizedProviderId)) return null;
        return resolveProviderCatalogProjection(normalizedProviderId, providerProjectionParams);
    }, [
        knownProviderIds,
        normalizedProviderId,
        providerProjectionParams,
    ]);
    if (!normalizedProviderId) {
        return <ProviderSettingsNotFound theme={theme} />;
    }

    if (!projection) {
        return <ProviderSettingsNotFound theme={theme} />;
    }

    const runtimeProviderId = projection.providerAgentId ?? null;
    if (!projection.descriptor && !projection.behavior && !runtimeProviderId) {
        return <ProviderSettingsFallbackScreenInner projection={projection} />;
    }

    return (
        <ProviderSettingsScreenInner
            providerId={normalizedProviderId}
            runtimeProviderId={runtimeProviderId}
            core={runtimeProviderId ? getAgentCore(runtimeProviderId) : null}
            projection={projection}
            descriptor={projection.descriptor}
            behavior={projection.behavior}
            authPlugin={projection.authPlugin}
            activeServerId={activeServerId}
            capabilityServerId={capabilityServerId}
            activeServerMachines={activeServerMachines}
            selectedMachineId={selectedMachineId}
            setSelectedMachineId={setSelectedMachineId}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    inputContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.secondary,
        marginBottom: 4,
    },
    textInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.input.text,
        ...(Platform.select({
            web: {
                outline: 'none',
                outlineStyle: 'none',
                outlineWidth: 0,
                outlineColor: 'transparent',
                boxShadow: 'none',
                WebkitBoxShadow: 'none',
                WebkitAppearance: 'none',
            },
            default: {},
        }) as object),
    },
}));
