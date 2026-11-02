import * as React from 'react';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { SERVERS_SETTINGS } from '@/components/settings/server/serverSettings';

import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { parseRelayAccessConfig, relayAccessProviderDescriptors, type RelayAccessConfig, type RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import type { SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';

import { AccessEndpointSettingsSection } from '@/components/settings/server/accessEndpoints/AccessEndpointSettingsSection';
import type { AccessEndpointRemediationPressPayload } from '@/components/settings/server/accessEndpoints/AccessChannelChoiceCard';
import { getDefaultSystemTaskRunner, SystemTaskProgressCard } from '@/components/systemTasks';
import { readLatestSystemTaskPrompt } from '@/components/systemTasks/prompts/readLatestSystemTaskPrompt';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { ActionCard } from '@/components/ui/cards/ActionCard';
import { Item } from '@/components/ui/lists/Item';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { getBlurViewComponent } from '@/components/ui/glass/blurMaterial';
import { createBackdropNativeStyle, createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { Text } from '@/components/ui/text/Text';
import type { AccessChannel } from '@/sync/domains/accessEndpoints/channels/model';
import type { AccessEndpointRemediationAction } from '@/sync/domains/accessEndpoints/model';
import { setActiveShareableServerUrl, setServerProfileShareableUrl } from '@/sync/domains/server/serverRuntime';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import {
    relayAccessConfigStepCatalog,
    type RelayAccessConfigStepDraft,
    type RelayAccessCredentialRefs,
} from '@/components/onboarding/steps/relayAccess/relayAccessConfigStepCatalog';

import {
    getAvailableRelayAccessProviderDescriptors,
    relayAccessProviderSupportsTarget,
    relayAccessProviderUiCatalog,
    relayAccessProviderUsesPrerequisitesStep,
} from './relayAccessUiCatalog';
import { RelayAccessCredentialFields } from './RelayAccessCredentialFields';
import { useRelayAccessControl, type RelayAccessControlOptions } from './useRelayAccessControl';
import { Icon } from '@/components/ui/icons/Icon';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

const EMPTY_DRAFT: RelayAccessConfigStepDraft = Object.freeze({});
const EMPTY_CREDENTIAL_REFS: RelayAccessCredentialRefs = Object.freeze([]);

function resolveStatusSubtitle(state: string | null | undefined): string {
    switch (state) {
        case 'enabled':
            return t('settings.relayAccess.statusEnabled');
        case 'disabled':
            return t('settings.relayAccess.statusDisabled');
        case 'needs_auth':
            return t('settings.relayAccess.statusNeedsAuth');
        case 'error':
            return t('settings.relayAccess.statusError');
        case 'unknown':
        default:
            return t('settings.relayAccess.statusUnknown');
    }
}

function readRelayAccessPromptUrl(snapshot: ReturnType<typeof readLatestSystemTaskPrompt>): string | null {
    const rawUrl = typeof snapshot?.data.url === 'string' ? snapshot.data.url.trim() : '';
    return rawUrl || null;
}

export type RelayAccessControlSectionProps = Readonly<{
    testID?: string;
    runner?: SystemTaskRunner;
    onShareUrlChange?: (shareUrl: string | null) => void;
    serverProfileId?: string | null;
    upstreamUrl?: string | null;
    remoteHost?: RelayAccessControlOptions['remoteHost'];
    actionScope?: RelayAccessControlOptions['actionScope'];
    target?: RelayAccessTaskTarget;
    runWithTarget?: <T>(run: (target: RelayAccessTaskTarget, startSpec?: (spec: SystemTaskSpec) => Promise<string>, admittedUpstreamUrl?: string | null) => Promise<T>) => Promise<T>;
    presentation?: 'settings' | 'wizard';
    onWizardPrimaryChange?: (state: Readonly<{ label: string; disabled: boolean; onPress: (() => void) | (() => Promise<void>) }> | null) => void;
    onRequestAdvance?: () => void;
    onWizardRequestProviderDetails?: (providerId: RelayAccessProviderId) => void;
    onWizardSelectedProviderIdChange?: (providerId: RelayAccessProviderId) => void;
    wizardSelectedProviderId?: RelayAccessProviderId | null;
    forcedProviderId?: RelayAccessProviderId | null;
    showProviderChoices?: boolean;
    allowWizardDetailsRedirect?: boolean;
    accessChannels?: readonly AccessChannel[];
    accessEndpointRemediationActions?: readonly AccessEndpointRemediationAction[];
    accessEndpointsRefreshing?: boolean;
    onAccessEndpointRemediationActionPress?: (payload: AccessEndpointRemediationPressPayload) => void;
}>;

export const RelayAccessControlSection = React.memo(function RelayAccessControlSection(props: RelayAccessControlSectionProps) {
    const router = useRouter();
    const runner = props.runner ?? getDefaultSystemTaskRunner();
    const presentation = props.presentation ?? 'settings';
    const showProviderChoices = props.showProviderChoices ?? true;
    const allowWizardDetailsRedirect = props.allowWizardDetailsRedirect ?? true;
    const target = props.target ?? { kind: 'local' as const };
    const onWizardPrimaryChange = props.onWizardPrimaryChange;
    const onRequestAdvance = props.onRequestAdvance;
    const { theme } = useUnistyles();
    const normalizedUpstreamUrl = React.useMemo(() => {
        const value = typeof props.upstreamUrl === 'string' ? props.upstreamUrl.trim() : '';
        return value.length > 0 ? value : null;
    }, [props.upstreamUrl]);
    const {
        activeTaskSnapshot,
        actionScope,
        actionServerId,
        approval,
        cancelTask,
        actionSnapshot,
        configure,
        disable,
        isBusy,
        isUnavailable,
        lastErrorMessage,
        refreshStatus,
        snapshot,
    } = useRelayAccessControl({ runner, upstreamUrl: normalizedUpstreamUrl, target, runWithTarget: props.runWithTarget, remoteHost: props.remoteHost, actionScope: props.actionScope });

    const resolvedProviderId = snapshot?.providerId ?? null;
    const resolvedShareUrl = snapshot?.status?.shareUrl ?? null;
    const resolvedState = snapshot?.status?.state ?? null;
    const resolvedConfigured = snapshot?.configured === true;

    const [selectedProviderId, setSelectedProviderId] = React.useState<RelayAccessProviderId>(() => (
        props.forcedProviderId
            ?? resolvedProviderId
            ?? (presentation === 'wizard'
                ? (props.wizardSelectedProviderId ?? 'localOnly')
                : 'lan')
    ));
    // Drafts are kept per provider, so switching method and back keeps what was typed or chosen.
    const [drafts, setDrafts] = React.useState<Readonly<Record<string, RelayAccessConfigStepDraft>>>({});
    const [credentialDrafts, setCredentialDrafts] = React.useState<Readonly<Record<string, RelayAccessCredentialRefs>>>({});
    const [advanceAfterSaveRequested, setAdvanceAfterSaveRequested] = React.useState(false);
    const latestPromptSnapshot = actionSnapshot ?? activeTaskSnapshot;
    const latestPrompt = React.useMemo(
        () => readLatestSystemTaskPrompt(latestPromptSnapshot ?? null),
        [latestPromptSnapshot],
    );

    React.useEffect(() => {
        if (props.forcedProviderId) {
            setSelectedProviderId(props.forcedProviderId);
            return;
        }
        if (!resolvedProviderId) {
            return;
        }
        setSelectedProviderId(resolvedProviderId);
    }, [props.forcedProviderId, resolvedProviderId]);

    React.useEffect(() => {
        if (presentation !== 'wizard') return;
        const next = props.wizardSelectedProviderId;
        if (!next) return;
        if (resolvedProviderId) return;
        setSelectedProviderId(next);
    }, [presentation, props.wizardSelectedProviderId, resolvedProviderId]);

    const visibleProviderIds = React.useMemo(() => {
        if (props.forcedProviderId) {
            return relayAccessProviderSupportsTarget(props.forcedProviderId, target)
                ? [props.forcedProviderId]
                : [];
        }
        return getAvailableRelayAccessProviderDescriptors().map((descriptor) => descriptor.id);
    }, [props.forcedProviderId, target]);

    const selectedDescriptor = visibleProviderIds.includes(selectedProviderId)
        ? relayAccessProviderDescriptors.find((descriptor) => descriptor.id === selectedProviderId)
        : undefined;
    const selectedDefinition = selectedDescriptor ? relayAccessConfigStepCatalog[selectedDescriptor.id] : undefined;
    const configuredDraft = React.useMemo(
        () => selectedDefinition?.readConfiguredDraft(snapshot ?? null) ?? EMPTY_DRAFT,
        [selectedDefinition, snapshot],
    );
    const draft = drafts[selectedProviderId] ?? configuredDraft;
    const normalizedDraft = React.useMemo(
        () => selectedDefinition?.normalizeDraft(draft) ?? EMPTY_DRAFT,
        [selectedDefinition, draft],
    );
    const configuredCredentialRefs = snapshot?.providerId === selectedProviderId
        ? snapshot.selection?.credentialRefs ?? EMPTY_CREDENTIAL_REFS
        : EMPTY_CREDENTIAL_REFS;
    const credentialRefs = credentialDrafts[selectedProviderId] ?? configuredCredentialRefs;

    React.useEffect(() => {
        if (visibleProviderIds.includes(selectedProviderId)) {
            return;
        }
        setSelectedProviderId(visibleProviderIds[0] ?? 'lan');
    }, [selectedProviderId, visibleProviderIds]);

    React.useEffect(() => {
        if (presentation !== 'wizard') return;
        props.onWizardSelectedProviderIdChange?.(selectedProviderId);
    }, [presentation, props.onWizardSelectedProviderIdChange, selectedProviderId]);

    React.useEffect(() => {
        props.onShareUrlChange?.(resolvedShareUrl);
    }, [props.onShareUrlChange, resolvedShareUrl]);

    const relayAccessChannel = React.useMemo<AccessChannel>(() => {
        const providerId = resolvedProviderId ?? selectedProviderId;
        return {
            id: `access-channel:relay-access:${providerId}`,
            label: relayAccessProviderUiCatalog[providerId]?.titleKey ?? 'settings.relayAccess.title',
            direction: 'make-current-server-reachable',
            kind: 'relay-access-provider',
            endpointIds: [`relay-access:${providerId}`],
            recommendedUse: resolvedState === 'enabled' ? 'multi-device' : 'diagnostic',
            limitations: resolvedState === 'needs_auth'
                ? [{
                    id: `relay-access:${providerId}:requires-auth`,
                    severity: 'warning',
                    reason: 'requires-auth',
                }]
                : [],
            remediationActionIds: [],
        };
    }, [resolvedProviderId, resolvedState, selectedProviderId]);

    const visibleAccessChannels = React.useMemo(() => {
        const channelsById = new Map<string, AccessChannel>();
        channelsById.set(relayAccessChannel.id, relayAccessChannel);
        for (const channel of props.accessChannels ?? []) {
            channelsById.set(channel.id, channel);
        }
        return [...channelsById.values()];
    }, [props.accessChannels, relayAccessChannel]);

    React.useEffect(() => {
        if (!snapshot) {
            return;
        }
        if (props.serverProfileId) {
            fireAndForget(setServerProfileShareableUrl(props.serverProfileId, resolvedShareUrl, {
                validatedAgainstServerUrl: normalizedUpstreamUrl,
            }), { tag: 'RelayAccessControlSection.persistShareableUrl' });
            return;
        }
        fireAndForget(setActiveShareableServerUrl(resolvedShareUrl, {
            validatedAgainstServerUrl: normalizedUpstreamUrl,
        }), { tag: 'RelayAccessControlSection.persistActiveShareableUrl' });
    }, [normalizedUpstreamUrl, props.serverProfileId, resolvedShareUrl, snapshot]);

    const save = React.useCallback(async (): Promise<boolean> => {
        if (isUnavailable || !selectedDescriptor) {
            return false;
        }
        // A provider with declared fields builds its config through its step definition; one without
        // fields is selected as it is.
        const config: RelayAccessConfig | null = selectedDefinition
            ? await selectedDefinition.createConfig({ normalizedDraft, credentialRefs })
            : parseRelayAccessConfig({ provider: selectedDescriptor.provider, config: {}, credentialRefs: [] });
        if (!config) {
            return false;
        }
        const taskId = await configure({ config });
        return Boolean(taskId);
    }, [configure, credentialRefs, isUnavailable, normalizedDraft, selectedDefinition, selectedDescriptor]);

    const cancel = React.useCallback(() => {
        if (!activeTaskSnapshot) {
            return;
        }
        fireAndForget(cancelTask(activeTaskSnapshot.taskId), { tag: 'RelayAccessControlSection.cancel' });
    }, [activeTaskSnapshot, cancelTask]);

    const disableAction = React.useCallback(async () => {
        if (isUnavailable) return;
        await disable();
    }, [disable, isUnavailable]);

    const selectedProviderNeedsDraftConfig = React.useMemo(() => {
        if (!snapshot) return true;
        if (snapshot.configured !== true) return true;
        if (snapshot.providerId !== selectedProviderId) return true;
        return selectedDefinition?.isSaveNeeded({ configuredDraft, normalizedDraft, configuredCredentialRefs, credentialRefs }) ?? false;
    }, [
        configuredCredentialRefs,
        configuredDraft,
        credentialRefs,
        normalizedDraft,
        selectedDefinition,
        selectedProviderId,
        snapshot,
    ]);

    const relayAccessPromptCard = React.useMemo(() => {
        if (!latestPrompt) {
            return null;
        }

        const promptUrl = readRelayAccessPromptUrl(latestPrompt);
        if (!promptUrl) {
            return null;
        }

        const canRetry = latestPromptSnapshot?.result != null;
        return (
            <ActionCard
                testID="settings.server.relayAccess.promptCard"
                title={latestPrompt.message || t('settings.machineSetupTaskWaitingForInput')}
                description={promptUrl}
                primaryAction={{
                    label: t('common.open'),
                    onPress: async () => {
                        await openExternalUrl(promptUrl);
                    },
                }}
                secondaryAction={canRetry
                    ? {
                        label: t('common.retry'),
                        onPress: () => {
                            void save();
                        },
                    }
                    : activeTaskSnapshot
                        ? {
                            label: t('common.cancel'),
                            onPress: () => {
                                cancel();
                            },
                        }
                        : undefined}
            />
        );
    }, [activeTaskSnapshot, cancel, latestPrompt, latestPromptSnapshot?.result, save]);

    // Whether the chosen method can be saved as drafted: its step definition owns completeness.
    const selectedProviderDraftValid = selectedDescriptor !== undefined && (
        !selectedProviderNeedsDraftConfig
        || !selectedDefinition
        || !selectedDefinition.isPrimaryDisabled({ needsSave: true, normalizedDraft, credentialRefs })
    );

    const handleWizardPrimaryPress = React.useCallback(async () => {
        if (presentation === 'wizard' && allowWizardDetailsRedirect && relayAccessProviderUsesPrerequisitesStep(selectedProviderId)) {
            props.onWizardRequestProviderDetails?.(selectedProviderId);
            return;
        }
        if (!selectedProviderNeedsDraftConfig) {
            onRequestAdvance?.();
            return;
        }

        if (!selectedProviderDraftValid) {
            await save();
            return;
        }

        const started = await save();
        if (!started) {
            setAdvanceAfterSaveRequested(false);
            return;
        }
        setAdvanceAfterSaveRequested(true);
    }, [
        onRequestAdvance,
        allowWizardDetailsRedirect,
        presentation,
        props.onWizardRequestProviderDetails,
        save,
        selectedProviderDraftValid,
        selectedProviderId,
        selectedProviderNeedsDraftConfig,
    ]);

    React.useEffect(() => {
        if (!advanceAfterSaveRequested) return;
        if (isBusy) return;
        if (lastErrorMessage) {
            setAdvanceAfterSaveRequested(false);
            return;
        }
        if (!snapshot) {
            return;
        }
        if (snapshot.configured === true && snapshot.providerId === selectedProviderId) {
            setAdvanceAfterSaveRequested(false);
            onRequestAdvance?.();
            return;
        }
    }, [advanceAfterSaveRequested, isBusy, lastErrorMessage, onRequestAdvance, selectedProviderId, snapshot]);

    React.useEffect(() => {
        if (presentation !== 'wizard') return;
        if (!onWizardPrimaryChange) return;
        const requiresDetailsStep = allowWizardDetailsRedirect && relayAccessProviderUsesPrerequisitesStep(selectedProviderId);
        onWizardPrimaryChange({
            label: t('common.continue'),
            disabled: isBusy || isUnavailable || (!requiresDetailsStep && !selectedProviderDraftValid && selectedProviderNeedsDraftConfig),
            onPress: handleWizardPrimaryPress,
        });
        return () => {
            onWizardPrimaryChange?.(null);
        };
    }, [
        handleWizardPrimaryPress,
        isBusy,
        isUnavailable,
        allowWizardDetailsRedirect,
        onWizardPrimaryChange,
        presentation,
        selectedProviderDraftValid,
        selectedProviderId,
        selectedProviderNeedsDraftConfig,
    ]);

    const providerChoiceRows = React.useMemo(() => (
        visibleProviderIds.map((providerId: RelayAccessProviderId) => {
            const definition = relayAccessProviderUiCatalog[providerId];
            return (
                <SelectableRow
                    key={providerId}
                    testID={`settings.server.relayAccess.choice:${providerId}`}
                    variant="selectable"
                    selected={selectedProviderId === providerId}
                    disabled={isBusy || isUnavailable}
                    left={(
                        <Icon
                            name={definition.iconName}
                            size={16}
                            color={selectedProviderId === providerId ? theme.colors.text.primary : theme.colors.text.secondary}
                        />
                    )}
                    title={t(definition.titleKey)}
                    subtitle={t(definition.subtitleKey)}
                    onPress={() => setSelectedProviderId(providerId)}
                />
            );
        })
    ), [isBusy, isUnavailable, selectedProviderId, theme.colors.text.primary, theme.colors.text.secondary, visibleProviderIds]);

    const providerConfigFields = selectedDescriptor ? (
        <>
            {selectedDefinition?.fields.map((field) => {
                const declared = selectedDescriptor.homeUi?.configStep?.fields.find((entry) => entry.id === field.id);
                const row = (
                    <Item
                        title={field.label}
                        accessoryLayout="adaptive"
                        showChevron={false}
                        rightElement={(
                            <FieldTextInput
                                testID={declared?.testID ?? `settings.server.relayAccess.${declared?.settingKey ?? field.id}`}
                                accessibilityLabel={field.label}
                                placeholder={field.placeholder}
                                value={draft[field.id] ?? ''}
                                onChangeText={(value) => setDrafts((current) => ({
                                    ...current,
                                    [selectedProviderId]: { ...draft, [field.id]: value },
                                }))}
                            />
                        )}
                    />
                );
                return declared?.settingKey
                    ? <SettingAnchor key={field.id} setting={SERVERS_SETTINGS.settings[declared.settingKey]}>{row}</SettingAnchor>
                    : <React.Fragment key={field.id}>{row}</React.Fragment>;
            })}
            <RelayAccessCredentialFields
                key={selectedDescriptor.id}
                descriptor={selectedDescriptor}
                value={credentialRefs}
                accountScope={actionScope}
                disabled={isBusy || isUnavailable}
                testIDPrefix="settings.server.relayAccess"
                onChange={(value) => setCredentialDrafts((current) => ({ ...current, [selectedProviderId]: value }))}
            />
        </>
    ) : null;

    if (presentation === 'wizard') {
        const overlayScrimColor = theme.colors.overlay?.scrimWizard ?? theme.colors.surface.base;
        const showBusyOverlay = isBusy && activeTaskSnapshot != null;
        const BlurView = showBusyOverlay ? getBlurViewComponent() : null;
        return (
            <View testID={props.testID} style={{ width: '100%', gap: theme.space.s12, position: 'relative' }}>
                <View style={{ width: '100%', gap: theme.space.s12 }}>
                    {showProviderChoices ? (
                        <View style={{ width: '100%', gap: theme.space.s8 }}>
                            {providerChoiceRows}
                        </View>
                    ) : null}

                    {lastErrorMessage ? (
                        <Text style={{ color: theme.colors.text.secondary, textAlign: 'center' }}>
                            {lastErrorMessage}
                        </Text>
                    ) : null}
                </View>

                {showBusyOverlay ? (
                    <View
                        testID="settings.server.relayAccess.busyOverlay"
                        style={[
                            StyleSheet.absoluteFillObject,
                            {
                                position: 'absolute',
                                alignItems: 'center',
                                justifyContent: 'center',
                                padding: theme.space.s12,
                                borderRadius: 12,
                                overflow: 'hidden',
                            },
                        ]}
                    >
                        {Platform.OS !== 'web' ? (
                            (() => {
                                if (BlurView) {
                                    return <BlurView testID="settings.server.relayAccess.busyOverlay.frosted"
                                        intensity={12} tint="default" pointerEvents="none"
                                        style={StyleSheet.absoluteFillObject} />;
                                }
                                return (
                                    <View
                                        testID="settings.server.relayAccess.busyOverlay.fallback"
                                        pointerEvents="none"
                                        style={[
                                            StyleSheet.absoluteFillObject,
                                            createBackdropNativeStyle({ backgroundColor: overlayScrimColor }),
                                        ]}
                                    />
                                );
                            })()
                        ) : (
                            <View
                                testID="settings.server.relayAccess.busyOverlay.frosted"
                                pointerEvents="none"
                                style={[
                                    StyleSheet.absoluteFillObject,
                                    (createBackdropWebStyle({ backgroundColor: overlayScrimColor, blurPx: 2 }) as unknown as Record<string, unknown>),
                                ]}
                            />
                        )}

                        <View style={{ width: '100%', maxWidth: 420 }}>
                            <View style={{ width: '100%', gap: theme.space.s12 }}>
                                <SystemTaskProgressCard
                                    snapshot={activeTaskSnapshot}
                                    variant="checklistOnly"
                                    title={null}
                                    showStepMessages={false}
                                    showOpenLogs={false}
                                    onCancel={cancel}
                                />
                                {relayAccessPromptCard}
                            </View>
                        </View>
                    </View>
                ) : null}

                {!showBusyOverlay ? relayAccessPromptCard : null}
            </View>
        );
    }

    return (
        <>
            <AccessEndpointSettingsSection
                channels={visibleAccessChannels}
                remediationActions={props.accessEndpointRemediationActions}
                isRefreshing={props.accessEndpointsRefreshing}
                onRemediationActionPress={props.onAccessEndpointRemediationActionPress}
            />
            <SettingSection section={SERVERS_SETTINGS.sectionRefs.relayAccess}>
            <ItemGroup
                title={t('settings.relayAccess.title')}
                description={t('settings.relayAccess.footer')}
                action={(
                    <SectionActionButton
                        testID="settings.server.relayAccess.refresh"
                        icon="arrows-clockwise"
                        title={t('settings.relayAccess.refreshAction')}
                        onPress={() => {
                            void refreshStatus();
                        }}
                        disabled={isBusy || isUnavailable}
                    />
                )}
            >
                {approval.approvalPending && approval.approvalId && actionServerId ? <ActionApprovalPendingNotice
                    testID="home-reach-relay-approval"
                    message={t('secrets.catalog.approvalPending')}
                    onOpenApproval={() => router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(actionServerId)}`)}
                /> : null}
                <Item
                    testID="settings.server.relayAccess.status"
                    title={t('settings.relayAccess.statusTitle')}
                    subtitle={isUnavailable
                        ? t('settings.systemTaskBridgeUnavailable')
                        : snapshot == null
                            ? t('settings.relayAccess.statusWorking')
                            : snapshot.configured !== true
                                ? t('settings.relayAccess.statusNotConfigured')
                                : resolveStatusSubtitle(resolvedState)}
                    showChevron={false}
                />
                <Item
                    testID="settings.server.relayAccess.method"
                    title={t('settings.relayAccess.methodTitle')}
                    subtitle={resolvedProviderId
                        ? t(relayAccessProviderUiCatalog[resolvedProviderId]?.titleKey ?? 'settings.relayAccess.statusUnknown')
                        : (resolvedConfigured ? '' : t('settings.relayAccess.statusNotConfigured'))}
                    showChevron={false}
                />
                {resolvedShareUrl ? (
                    <Item
                        testID="settings.server.relayAccess.shareUrl"
                        title={t('settings.relayAccess.shareableUrlTitle')}
                        subtitle={resolvedShareUrl}
                        showChevron={false}
                    />
                ) : null}

                {showProviderChoices ? (
                    <SettingAnchor setting={SERVERS_SETTINGS.settings.accessMethod}>
                        <SectionContentRow>
                            <View style={{ gap: theme.space.s8 }}>
                                {providerChoiceRows}
                            </View>
                        </SectionContentRow>
                    </SettingAnchor>
                ) : null}

                {providerConfigFields}

                {lastErrorMessage ? (
                    <Item
                        testID="settings.server.relayAccess.error"
                        title={t('common.error')}
                        subtitle={lastErrorMessage}
                        subtitleLines={0}
                        showChevron={false}
                    />
                ) : null}

                <SectionContentRow>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s12 }}>
                        <RoundButton
                            testID="settings.server.relayAccess.save"
                            size="small"
                            title={t('settings.relayAccess.saveAction')}
                            onPress={() => {
                                void save();
                            }}
                            disabled={isBusy || isUnavailable || !selectedProviderDraftValid}
                        />
                        <RoundButton
                            testID="settings.server.relayAccess.disable"
                            size="small"
                            display="secondary"
                            title={t('settings.relayAccess.disableAction')}
                            onPress={() => {
                                void disableAction();
                            }}
                            disabled={isBusy || isUnavailable}
                        />
                    </View>
                </SectionContentRow>
            </ItemGroup>
            </SettingSection>

            {activeTaskSnapshot ? (
                <SystemTaskProgressCard
                    title={t('settings.relayAccess.statusWorking')}
                    snapshot={activeTaskSnapshot}
                    onCancel={cancel}
                />
            ) : null}
            {relayAccessPromptCard}
        </>
    );
});
