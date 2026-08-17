import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { relayAccessProviderIds, type RelayAccessConfig, type RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import { AccessEndpointSettingsSection } from '@/components/settings/server/accessEndpoints/AccessEndpointSettingsSection';
import type { AccessEndpointRemediationPressPayload } from '@/components/settings/server/accessEndpoints/AccessChannelChoiceCard';
import { getDefaultSystemTaskRunner, SystemTaskProgressCard } from '@/components/systemTasks';
import { readLatestSystemTaskPrompt } from '@/components/systemTasks/prompts/readLatestSystemTaskPrompt';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { ActionCard } from '@/components/ui/cards/ActionCard';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { createBackdropNativeStyle, createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import type { AccessChannel } from '@/sync/domains/accessEndpoints/channels/model';
import type { AccessEndpointRemediationAction } from '@/sync/domains/accessEndpoints/model';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { setActiveShareableServerUrl, setServerProfileShareableUrl } from '@/sync/domains/server/serverRuntime';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import {
    relayAccessProviderSupportsTarget,
    relayAccessProviderUiCatalog,
    relayAccessProviderUsesPrerequisitesStep,
} from './relayAccessUiCatalog';
import { useRelayAccessControl } from './useRelayAccessControl';
import { Icon } from '@/components/ui/icons/Icon';

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
    target?: RelayAccessTaskTarget;
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
    const runner = props.runner ?? getDefaultSystemTaskRunner();
    const presentation = props.presentation ?? 'settings';
    const showProviderChoices = props.showProviderChoices ?? true;
    const allowWizardDetailsRedirect = props.allowWizardDetailsRedirect ?? true;
    const target = props.target ?? { kind: 'local' as const };
    const onWizardPrimaryChange = props.onWizardPrimaryChange;
    const onRequestAdvance = props.onRequestAdvance;
    const { theme } = useUnistyles();
    const setupPolicy = React.useMemo(() => resolveSetupSurfacePolicy(), []);
    const normalizedUpstreamUrl = React.useMemo(() => {
        const value = typeof props.upstreamUrl === 'string' ? props.upstreamUrl.trim() : '';
        return value.length > 0 ? value : null;
    }, [props.upstreamUrl]);
    const {
        activeTaskSnapshot,
        actionSnapshot,
        configure,
        disable,
        isBusy,
        isUnavailable,
        lastErrorMessage,
        refreshStatus,
        snapshot,
    } = useRelayAccessControl({ runner, upstreamUrl: normalizedUpstreamUrl, target });

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
    const [lanUrlDraft, setLanUrlDraft] = React.useState('');
    const [cloudflareHostnameDraft, setCloudflareHostnameDraft] = React.useState('');
    const [cloudflareTokenDraft, setCloudflareTokenDraft] = React.useState('');
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
                : relayAccessProviderIds.filter((providerId) => relayAccessProviderSupportsTarget(providerId, target));
        }
        return relayAccessProviderIds.filter((providerId) => {
            if (!relayAccessProviderSupportsTarget(providerId, target)) {
                return false;
            }
            if (providerId === 'tailscaleServe' || providerId === 'tailscaleFunnel') {
                return setupPolicy.relayAccess.allowTailscale;
            }
            if (providerId === 'cloudflareNamed') {
                return setupPolicy.relayAccess.allowCloudflareTunnel;
            }
            return true;
        });
    }, [props.forcedProviderId, setupPolicy.relayAccess.allowCloudflareTunnel, setupPolicy.relayAccess.allowTailscale, target]);

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
            setServerProfileShareableUrl(props.serverProfileId, resolvedShareUrl, {
                validatedAgainstServerUrl: normalizedUpstreamUrl,
            });
            return;
        }
        setActiveShareableServerUrl(resolvedShareUrl, {
            validatedAgainstServerUrl: normalizedUpstreamUrl,
        });
    }, [normalizedUpstreamUrl, props.serverProfileId, resolvedShareUrl, snapshot]);

    const save = React.useCallback(async (): Promise<boolean> => {
        if (isUnavailable) {
            return false;
        }

        let config: RelayAccessConfig;
        if (selectedProviderId === 'lan') {
            const normalized = lanUrlDraft.trim();
            if (!normalized) {
                await Modal.alert(t('common.error'), t('settings.relayAccess.missingUrl'));
                return false;
            }
            config = { providerId: 'lan', url: normalized };
        } else if (selectedProviderId === 'cloudflareNamed') {
            const hostname = cloudflareHostnameDraft.trim();
            const token = cloudflareTokenDraft.trim();
            if (!hostname) {
                await Modal.alert(t('common.error'), t('settings.relayAccess.missingHostname'));
                return false;
            }
            if (!token) {
                await Modal.alert(t('common.error'), t('settings.relayAccess.missingToken'));
                return false;
            }
            config = { providerId: 'cloudflareNamed', hostname, token };
        } else {
            config = { providerId: selectedProviderId } as RelayAccessConfig;
        }

        const taskId = await configure({ providerId: selectedProviderId, config });
        return Boolean(taskId);
    }, [
        cloudflareHostnameDraft,
        cloudflareTokenDraft,
        configure,
        isUnavailable,
        lanUrlDraft,
        selectedProviderId,
    ]);

    const cancel = React.useCallback(() => {
        if (!activeTaskSnapshot) {
            return;
        }
        void runner.cancel(activeTaskSnapshot.taskId);
    }, [activeTaskSnapshot, runner]);

    const disableAction = React.useCallback(async () => {
        if (isUnavailable) return;
        await disable();
    }, [disable, isUnavailable]);

    const selectedProviderNeedsDraftConfig = React.useMemo(() => {
        if (!snapshot) return true;
        if (snapshot.configured !== true) return true;
        if (snapshot.providerId !== selectedProviderId) return true;
        if (selectedProviderId === 'lan') {
            return lanUrlDraft.trim().length > 0;
        }
        if (selectedProviderId === 'cloudflareNamed') {
            return cloudflareHostnameDraft.trim().length > 0 || cloudflareTokenDraft.trim().length > 0;
        }
        return false;
    }, [
        cloudflareHostnameDraft,
        cloudflareTokenDraft,
        lanUrlDraft,
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
                        await openExternalUrl(promptUrl, { platformOS: Platform.OS });
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

    const selectedProviderDraftValid = React.useMemo(() => {
        if (!selectedProviderNeedsDraftConfig) return true;
        if (selectedProviderId === 'lan') {
            return lanUrlDraft.trim().length > 0;
        }
        if (selectedProviderId === 'cloudflareNamed') {
            return cloudflareHostnameDraft.trim().length > 0 && cloudflareTokenDraft.trim().length > 0;
        }
        return true;
    }, [
        cloudflareHostnameDraft,
        cloudflareTokenDraft,
        lanUrlDraft,
        selectedProviderId,
        selectedProviderNeedsDraftConfig,
    ]);

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

    const providerConfigFields = (
        <>
            {selectedProviderId === 'lan' ? (
                <View>
                    <TextInput
                        testID="settings.server.relayAccess.lanUrl"
                        placeholder={t('settings.relayAccess.fields.urlLabel')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        value={lanUrlDraft}
                        onChangeText={setLanUrlDraft}
                    />
                </View>
            ) : null}

            {selectedProviderId === 'cloudflareNamed' ? (
                <View>
                    <TextInput
                        testID="settings.server.relayAccess.cloudflareHostname"
                        placeholder={t('settings.relayAccess.fields.hostnameLabel')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        value={cloudflareHostnameDraft}
                        onChangeText={setCloudflareHostnameDraft}
                    />
                    <TextInput
                        testID="settings.server.relayAccess.cloudflareToken"
                        placeholder={t('settings.relayAccess.fields.tokenLabel')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry={true}
                        value={cloudflareTokenDraft}
                        onChangeText={setCloudflareTokenDraft}
                    />
                </View>
            ) : null}
        </>
    );

    if (presentation === 'wizard') {
        const overlayScrimColor = theme.colors.overlay?.scrimWizard ?? theme.colors.surface.base;
        const showBusyOverlay = isBusy && activeTaskSnapshot != null;
        return (
            <View testID={props.testID} style={{ width: '100%', gap: 12, position: 'relative' }}>
                <View style={{ width: '100%', gap: 12 }}>
                    {showProviderChoices ? (
                        <View style={{ width: '100%', gap: 8 }}>
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
                                padding: 12,
                                borderRadius: 12,
                                overflow: 'hidden',
                            },
                        ]}
                    >
                        {Platform.OS !== 'web' ? (
                            (() => {
                                try {
                                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                                    const { BlurView } = require('expo-blur');
                                    if (BlurView) {
                                        return (
                                            <BlurView
                                                testID="settings.server.relayAccess.busyOverlay.frosted"
                                                intensity={Platform.OS === 'ios' ? 12 : 3}
                                                tint="default"
                                                pointerEvents="none"
                                                style={StyleSheet.absoluteFillObject}
                                            />
                                        );
                                    }
                                } catch {
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
                            <View style={{ width: '100%', gap: 12 }}>
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
            <ItemGroup
                title={t('settings.relayAccess.title')}
                footer={t('settings.relayAccess.footer')}
            >
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
                    mode="info"
                />
                <Item
                    testID="settings.server.relayAccess.method"
                    title={t('settings.relayAccess.methodTitle')}
                    subtitle={resolvedProviderId
                        ? t(relayAccessProviderUiCatalog[resolvedProviderId].titleKey)
                        : (resolvedConfigured ? '' : t('settings.relayAccess.statusNotConfigured'))}
                    showChevron={false}
                    mode="info"
                />
                {resolvedShareUrl ? (
                    <Item
                        testID="settings.server.relayAccess.shareUrl"
                        title={t('settings.relayAccess.shareableUrlTitle')}
                        subtitle={resolvedShareUrl}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}

                <Item
                    testID="settings.server.relayAccess.refresh"
                    title={t('settings.relayAccess.refreshAction')}
                    onPress={() => {
                        void refreshStatus();
                    }}
                    disabled={isBusy || isUnavailable}
                />

                {showProviderChoices ? (
                    <View>
                        {providerChoiceRows}
                    </View>
                ) : null}

                {providerConfigFields}

                <Item
                    testID="settings.server.relayAccess.save"
                    title={t('settings.relayAccess.saveAction')}
                    onPress={() => {
                        void save();
                    }}
                    disabled={isBusy || isUnavailable}
                />
                <Item
                    testID="settings.server.relayAccess.disable"
                    title={t('settings.relayAccess.disableAction')}
                    onPress={() => {
                        void disableAction();
                    }}
                    disabled={isBusy || isUnavailable}
                />
                {lastErrorMessage ? (
                    <Item
                        title={t('common.error')}
                        subtitle={lastErrorMessage}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
            </ItemGroup>

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
