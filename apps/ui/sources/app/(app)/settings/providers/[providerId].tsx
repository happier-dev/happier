import React from 'react';
import { Platform, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { sync } from '@/sync/sync';
import { useAllMachines, useSettings } from '@/sync/domains/state/storage';
import { isAgentId, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { getProviderSettingsPlugin } from '@/agents/providers/_registry/providerSettingsRegistry';
import { t } from '@/text';
import { getAgentAdvancedModeCapabilities } from '@happier-dev/agents';
import {
    buildCatalogModelList,
    classifyRuntimeSwitchKind,
    classifySessionModeKind,
    describeResumeSupportKind,
} from '@/agents/catalog/providerDetailsInfo';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { useCapabilityInstallability } from '@/hooks/machine/useCapabilityInstallability';
import { ProviderCliInstallItem } from '@/components/settings/providers/ProviderCliInstallItem';
import { getPermissionModeLabelForAgentType, getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';

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
            <Text style={styles.fieldLabel}>{field.title}</Text>
            {field.subtitle && (
                <Text style={{ ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary, marginBottom: 6 }}>
                    {field.subtitle}
                </Text>
            )}
            <TextInput
                style={[
                    styles.textInput,
                    showError ? { borderWidth: 1, borderColor: theme.colors.textDestructive } : null,
                ]}
                placeholder={field.numberSpec?.placeholder ?? t('common.optional')}
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
                <Text style={{ ...Typography.default(), fontSize: 12, color: theme.colors.textDestructive, marginTop: 6 }}>
                    {t('settingsProviders.invalidNumber')}
                </Text>
            )}
        </View>
    );
});

export default React.memo(function ProviderSettingsScreen() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams();
    const rawProviderId = params.providerId;
    const providerId = typeof rawProviderId === 'string' && isAgentId(rawProviderId) ? (rawProviderId as AgentId) : null;
    const core = providerId ? getAgentCore(providerId) : null;
    const plugin = providerId ? getProviderSettingsPlugin(providerId) : null;
    const settings = useSettings();

    const popoverBoundaryRef = React.useRef<any>(null);
    const [openMenu, setOpenMenu] = React.useState<null | string>(null);
    const [localInputs, setLocalInputs] = React.useState<Record<string, string>>({});

    const setSetting = React.useCallback((key: string, value: unknown) => {
        sync.applySettings({ [key]: value } as any);
    }, []);

    if (!providerId || !core) {
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup>
                    <View style={{ alignItems: 'center', paddingVertical: 32, paddingHorizontal: 16 }}>
                        <Ionicons name="warning-outline" size={48} color={theme.colors.textDestructive} style={{ marginBottom: 16 }} />
                        <Text style={{ ...Typography.default('semiBold'), fontSize: 16, color: theme.colors.textDestructive, textAlign: 'center', marginBottom: 8 }}>
                            {t('settingsProviders.notFoundTitle')}
                        </Text>
                        <Text style={{ ...Typography.default(), fontSize: 14, color: theme.colors.textSecondary, textAlign: 'center', lineHeight: 20 }}>
                            {t('settingsProviders.notFoundSubtitle')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    const advanced = getAgentAdvancedModeCapabilities(providerId);
    const backendEnabledById = (settings as any).backendEnabledById as Record<string, boolean> | undefined;
    const backendEnabled = backendEnabledById?.[providerId] !== false;
    const setBackendEnabled = (next: boolean) => {
        sync.applySettings({
            backendEnabledById: {
                ...(backendEnabledById ?? {}),
                [providerId]: next,
            },
        } as any);
    };

    const defaultPermissionByAgent = (settings as any).sessionDefaultPermissionModeByAgent as Record<string, PermissionMode> | undefined;
    const permissionMode = ((defaultPermissionByAgent as any)?.[providerId] ?? 'default') as PermissionMode;
    const setPermissionMode = (next: PermissionMode) => {
        sync.applySettings({
            sessionDefaultPermissionModeByAgent: {
                ...(defaultPermissionByAgent ?? {}),
                [providerId]: next,
            },
        } as any);
    };

    const resumeSupportKind = describeResumeSupportKind({
        supportsVendorResume: core.resume.supportsVendorResume,
        experimental: core.resume.experimental,
        runtimeGate: core.resume.runtimeGate,
    });
    const resumeSupport = {
        supported: t('settingsProviders.resumeSupportSupported'),
        supportedExperimental: t('settingsProviders.resumeSupportSupportedExperimental'),
        runtimeGatedAcpLoadSession: t('settingsProviders.resumeSupportRuntimeGatedAcpLoadSession'),
        notSupported: t('settingsProviders.resumeSupportNotSupported'),
    }[resumeSupportKind];
    const sessionModeKind = classifySessionModeKind(core.sessionModes.kind);
    const sessionModeSupport = {
        none: t('settingsProviders.sessionModeNone'),
        acpPolicyPresets: t('settingsProviders.sessionModeAcpPolicyPresets'),
        acpAgentModes: t('settingsProviders.sessionModeAcpAgentModes'),
    }[sessionModeKind];
    const runtimeSwitchKind = classifyRuntimeSwitchKind(advanced.supportsRuntimeModeSwitch);
    const runtimeSwitchSupport = {
        none: t('settingsProviders.runtimeSwitchNone'),
        metadataGating: t('settingsProviders.runtimeSwitchMetadataGating'),
        acpSetSessionMode: t('settingsProviders.runtimeSwitchAcpSetSessionMode'),
        providerNative: t('settingsProviders.runtimeSwitchProviderNative'),
    }[runtimeSwitchKind];
    const catalogModelList = buildCatalogModelList({
        defaultMode: core.model.defaultMode,
        allowedModes: core.model.allowedModes,
    });
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
    const primaryMachine = machines[0] ?? null;
    const cliAvailability = useCLIDetection(primaryMachine?.id ?? null, { autoDetect: true });
    const providerCliAvailable = cliAvailability.available[providerId];
    const cliInstallability = useCapabilityInstallability({
        machineId: primaryMachine?.id ?? null,
        capabilityId: `cli.${core.cli.detectKey}` as any,
        timeoutMs: 5000,
    });
    const primaryMachineLabel = primaryMachine?.metadata?.displayName ?? primaryMachine?.metadata?.host ?? primaryMachine?.id ?? null;
    const detectedCliStatus = providerCliAvailable === true
        ? 'Detected'
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

    return (
        <View ref={popoverBoundaryRef} style={{ flex: 1 }}>
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup title={t(core.displayNameKey)} footer={t(core.subtitleKey)}>
                    <Item
                        title={t('settingsProviders.enabledTitle')}
                        subtitle={t('settingsProviders.enabledSubtitle')}
                        icon={<Ionicons name="toggle-outline" size={29} color={theme.colors.textSecondary} />}
                        rightElement={<Switch value={backendEnabled} onValueChange={setBackendEnabled} />}
                        showChevron={false}
                        onPress={() => setBackendEnabled(!backendEnabled)}
                    />
                    <Item
                        title={t('settingsProviders.releaseChannelTitle')}
                        subtitle={core.availability.experimental ? t('settingsProviders.channelExperimental') : t('settingsProviders.channelStable')}
                        icon={<Ionicons name="flask-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
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
                        selectedId={permissionMode as any}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        itemTrigger={{
                            title: t('settingsSession.permissions.defaultPermissionModeTitle'),
                            subtitle: getPermissionModeLabelForAgentType(providerId as any, permissionMode),
                            icon: <Ionicons name="shield-checkmark-outline" size={29} color="#34C759" />,
                        }}
                        items={getPermissionModeOptionsForAgentType(providerId as any).map((opt) => ({
                            id: opt.value,
                            title: opt.label,
                            subtitle: opt.description,
                            icon: (
                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                    <Ionicons name={opt.icon as any} size={22} color={theme.colors.textSecondary} />
                                </View>
                            ),
                        }))}
                        onSelect={(id) => {
                            setPermissionMode(id as any);
                            setOpenMenu(null);
                        }}
                    />
                </ItemGroup>

                {(plugin?.uiSections ?? []).map((section) => (
                    <ItemGroup key={section.id} title={section.title} footer={section.footer}>
                        {section.fields.map((field) => {
                            const value = (settings as any)[field.key];

                            if (field.kind === 'boolean') {
                                const boolValue = Boolean(value);
                                return (
                                    <Item
                                        key={field.key}
                                        title={field.title}
                                        subtitle={field.subtitle}
                                        icon={<Ionicons name="options-outline" size={29} color={theme.colors.textSecondary} />}
                                        rightElement={<Switch value={boolValue} onValueChange={(v) => setSetting(field.key, v)} />}
                                        showChevron={false}
                                        onPress={() => setSetting(field.key, !boolValue)}
                                    />
                                );
                            }

                            if (field.kind === 'enum') {
                                const options = field.enumOptions ?? [];
                                if (options.length === 0) {
                                    return (
                                        <Item
                                            key={field.key}
                                            title={field.title}
                                            subtitle={field.subtitle ?? t('settingsProviders.noOptionsAvailable')}
                                            icon={<Ionicons name="list-outline" size={29} color={theme.colors.textSecondary} />}
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
                                            title: field.title,
                                            subtitle: field.subtitle ?? undefined,
                                            showSelectedSubtitle: field.subtitle ? false : undefined,
                                            icon: <Ionicons name="list-outline" size={29} color={theme.colors.textSecondary} />,
                                        }}
                                        items={options.map((opt) => ({
                                            id: opt.id,
                                            title: opt.title,
                                            subtitle: opt.subtitle,
                                            icon: (
                                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                    <Ionicons name="radio-button-on-outline" size={22} color={theme.colors.textSecondary} />
                                                </View>
                                            ),
                                        }))}
                                        onSelect={(id) => {
                                            setSetting(field.key, id);
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
                                        setSetting={setSetting}
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
                                    setSetting(field.key, localValue);
                                    setLocalInputs((prev) => {
                                        if (!(field.key in prev)) return prev;
                                        const next = { ...prev };
                                        delete next[field.key];
                                        return next;
                                    });
                                };

                                return (
                                    <View key={field.key} style={[styles.inputContainer, { paddingTop: 0 }]}>
                                        <Text style={styles.fieldLabel}>{field.title}</Text>
                                        {field.subtitle && (
                                            <Text style={{ ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary, marginBottom: 6 }}>
                                                {field.subtitle}
                                            </Text>
                                        )}
                                        <TextInput
                                            style={[
                                                styles.textInput,
                                                {
                                                    minHeight: field.kind === 'json' ? 110 : 44,
                                                    textAlignVertical: field.kind === 'json' ? 'top' : 'center',
                                                } as any,
                                                jsonError ? { borderWidth: 1, borderColor: theme.colors.textDestructive } : null,
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
                                                setSetting(field.key, next);
                                            }}
                                            onEndEditing={commitJsonIfValid}
                                            onBlur={commitJsonIfValid}
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                        />
                                        {jsonError && (
                                            <Text style={{ ...Typography.default(), fontSize: 12, color: theme.colors.textDestructive, marginTop: 6 }}>
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

                <ItemGroup title={t('settingsProviders.cliConnectionTitle')}>
                    <Item
                        title="Target machine"
                        subtitle={primaryMachineLabel ?? t('machine.detectedCliUnknown')}
                        icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsProviders.detectedCliTitle')}
                        subtitle={`${core.cli.detectKey} • ${detectedCliStatus}`}
                        icon={<Ionicons name="code-slash-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsProviders.installSetupTitle')}
                        subtitle={installSetupSubtitle}
                        icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                    <ProviderCliInstallItem
                        machineId={primaryMachine?.id ?? null}
                        capabilityId={`cli.${core.cli.detectKey}` as any}
                        providerTitle={t(core.displayNameKey)}
                        installed={providerCliAvailable}
                        installability={cliInstallability}
                    />
                    {core.cli.installBanner.guideUrl ? (
                        <Item
                            title={t('settingsProviders.setupGuideUrlTitle')}
                            subtitle={core.cli.installBanner.guideUrl}
                            icon={<Ionicons name="link-outline" size={29} color={theme.colors.textSecondary} />}
                            showChevron={false}
                            copy={core.cli.installBanner.guideUrl}
                        />
                    ) : null}
                    <Item
                        title={t('settingsProviders.connectedServiceTitle')}
                        subtitle={core.connectedService.name}
                        icon={<Ionicons name="cloud-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                </ItemGroup>

                <ItemGroup title={t('settingsProviders.capabilitiesTitle')}>
                    <Item
                        title={t('settingsProviders.resumeSupportTitle')}
                        subtitle={resumeSupport}
                        icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsProviders.sessionModeSupportTitle')}
                        subtitle={sessionModeSupport}
                        icon={<Ionicons name="layers-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsProviders.runtimeModeSwitchingTitle')}
                        subtitle={runtimeSwitchSupport}
                        icon={<Ionicons name="swap-horizontal-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsProviders.localControlTitle')}
                        subtitle={core.localControl?.supported === true ? t('settingsProviders.supported') : t('settingsProviders.notSupported')}
                        icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                </ItemGroup>

                <ItemGroup title={t('settingsProviders.modelsTitle')}>
                    <Item
                        title={t('settingsProviders.modelSelectionTitle')}
                        subtitle={core.model.supportsSelection ? t('settingsProviders.supported') : t('settingsProviders.notSupported')}
                        icon={<Ionicons name="list-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsProviders.freeformModelIdsTitle')}
                        subtitle={core.model.supportsFreeform ? t('settingsProviders.allowed') : t('settingsProviders.notAllowed')}
                        icon={<Ionicons name="create-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsProviders.defaultModelTitle')}
                        subtitle={core.model.defaultMode}
                        icon={<Ionicons name="star-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsProviders.catalogModelListTitle')}
                        subtitle={catalogModelListText}
                        icon={<Ionicons name="albums-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsProviders.dynamicModelProbeTitle')}
                        subtitle={dynamicProbe}
                        icon={<Ionicons name="pulse-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsProviders.nonAcpApplyScopeTitle')}
                        subtitle={nonAcpApplyScope}
                        icon={<Ionicons name="arrow-forward-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsProviders.acpApplyBehaviorTitle')}
                        subtitle={acpApplyBehavior}
                        icon={<Ionicons name="sync-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsProviders.acpConfigOptionTitle')}
                        subtitle={core.model.acpModelConfigOptionId ?? t('settingsProviders.notAvailable')}
                        icon={<Ionicons name="settings-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        </View>
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
        color: theme.colors.groupped.sectionTitle,
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
