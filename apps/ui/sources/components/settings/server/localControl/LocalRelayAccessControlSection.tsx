import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { relayAccessProviderIds, type RelayAccessConfig, type RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess';

import { getDefaultSystemTaskRunner, SystemTaskProgressCard } from '@/components/systemTasks';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { resolveSystemTaskStepLabel } from '@/components/systemTasks/resolveSystemTaskStepLabel';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { setActiveShareableServerUrl } from '@/sync/domains/server/serverRuntime';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { t, type TranslationKey } from '@/text';

import { useLocalRelayAccessControl } from './useLocalRelayAccessControl';

const PROVIDER_TITLE_KEYS: Readonly<Record<RelayAccessProviderId, TranslationKey>> = Object.freeze({
    localOnly: 'settings.relayAccess.providers.localOnly.title',
    lan: 'settings.relayAccess.providers.lan.title',
    tailscaleServe: 'settings.relayAccess.providers.tailscaleServe.title',
    tailscaleFunnel: 'settings.relayAccess.providers.tailscaleFunnel.title',
    cloudflareNamed: 'settings.relayAccess.providers.cloudflareNamed.title',
});

const PROVIDER_SUBTITLE_KEYS: Readonly<Record<RelayAccessProviderId, TranslationKey>> = Object.freeze({
    localOnly: 'settings.relayAccess.providers.localOnly.subtitle',
    lan: 'settings.relayAccess.providers.lan.subtitle',
    tailscaleServe: 'settings.relayAccess.providers.tailscaleServe.subtitle',
    tailscaleFunnel: 'settings.relayAccess.providers.tailscaleFunnel.subtitle',
    cloudflareNamed: 'settings.relayAccess.providers.cloudflareNamed.subtitle',
});

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

export const LocalRelayAccessControlSection = React.memo(function LocalRelayAccessControlSection(props: Readonly<{
    runner?: SystemTaskRunner;
    onShareUrlChange?: (shareUrl: string | null) => void;
    upstreamUrl?: string | null;
    presentation?: 'settings' | 'wizard';
}>) {
    const runner = props.runner ?? getDefaultSystemTaskRunner();
    const presentation = props.presentation ?? 'settings';
    const { theme } = useUnistyles();
    const setupPolicy = React.useMemo(() => resolveSetupSurfacePolicy(), []);
    const {
        activeTaskSnapshot,
        configure,
        disable,
        isBusy,
        isUnavailable,
        lastErrorMessage,
        refreshStatus,
        snapshot,
    } = useLocalRelayAccessControl({ runner, upstreamUrl: props.upstreamUrl });

    const resolvedProviderId = snapshot?.providerId ?? null;
    const resolvedShareUrl = snapshot?.status?.shareUrl ?? null;
    const resolvedState = snapshot?.status?.state ?? null;
    const resolvedConfigured = snapshot?.configured === true;

    const [selectedProviderId, setSelectedProviderId] = React.useState<RelayAccessProviderId>(() => (
        resolvedProviderId ?? 'lan'
    ));
    const [lanUrlDraft, setLanUrlDraft] = React.useState('');
    const [cloudflareHostnameDraft, setCloudflareHostnameDraft] = React.useState('');
    const [cloudflareTokenDraft, setCloudflareTokenDraft] = React.useState('');

    React.useEffect(() => {
        if (resolvedProviderId && resolvedProviderId !== selectedProviderId) {
            setSelectedProviderId(resolvedProviderId);
        }
    }, [resolvedProviderId, selectedProviderId]);

    const visibleProviderIds = React.useMemo(() => {
        return relayAccessProviderIds.filter((providerId) => {
            if (providerId === 'tailscaleServe' || providerId === 'tailscaleFunnel') {
                return setupPolicy.relayAccess.allowTailscale;
            }
            if (providerId === 'cloudflareNamed') {
                return setupPolicy.relayAccess.allowCloudflareTunnel;
            }
            return true;
        });
    }, [setupPolicy.relayAccess.allowCloudflareTunnel, setupPolicy.relayAccess.allowTailscale]);

    React.useEffect(() => {
        if (visibleProviderIds.includes(selectedProviderId)) {
            return;
        }
        setSelectedProviderId(visibleProviderIds[0] ?? 'lan');
    }, [selectedProviderId, visibleProviderIds]);

    React.useEffect(() => {
        props.onShareUrlChange?.(resolvedShareUrl);
    }, [props.onShareUrlChange, resolvedShareUrl]);

    React.useEffect(() => {
        if (!snapshot) {
            return;
        }
        setActiveShareableServerUrl(resolvedShareUrl);
    }, [resolvedShareUrl, snapshot]);

    const save = React.useCallback(async () => {
        if (isUnavailable) {
            return;
        }

        let config: RelayAccessConfig;
        if (selectedProviderId === 'lan') {
            const normalized = lanUrlDraft.trim();
            if (!normalized) {
                await Modal.alert(t('common.error'), t('settings.relayAccess.missingUrl'));
                return;
            }
            config = { providerId: 'lan', url: normalized };
        } else if (selectedProviderId === 'cloudflareNamed') {
            const hostname = cloudflareHostnameDraft.trim();
            const token = cloudflareTokenDraft.trim();
            if (!hostname) {
                await Modal.alert(t('common.error'), t('settings.relayAccess.missingHostname'));
                return;
            }
            if (!token) {
                await Modal.alert(t('common.error'), t('settings.relayAccess.missingToken'));
                return;
            }
            config = { providerId: 'cloudflareNamed', hostname, token };
        } else {
            config = { providerId: selectedProviderId } as RelayAccessConfig;
        }

        await configure({ providerId: selectedProviderId, config });
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

    if (presentation === 'wizard') {
        const inlineStepLabel = activeTaskSnapshot?.currentStepId ? resolveSystemTaskStepLabel(activeTaskSnapshot.currentStepId) : null;
        const inlineLatestMessage = typeof activeTaskSnapshot?.latestMessage === 'string' ? activeTaskSnapshot.latestMessage : null;
        return (
            <>
                <View style={{ width: '100%', gap: 12 }}>
                    <Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>
                        {t('settings.relayAccess.footer')}
                    </Text>
                    {resolvedShareUrl ? (
                        <Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>
                            {resolvedShareUrl}
                        </Text>
                    ) : null}

                    <View style={{ width: '100%', gap: 8 }}>
                        {visibleProviderIds.map((providerId: RelayAccessProviderId) => (
                            <SelectableRow
                                key={providerId}
                                testID={`settings.server.relayAccess.choice:${providerId}`}
                                variant="selectable"
                                selected={selectedProviderId === providerId}
                                disabled={isBusy || isUnavailable}
                                title={t(PROVIDER_TITLE_KEYS[providerId])}
                                subtitle={t(PROVIDER_SUBTITLE_KEYS[providerId])}
                                onPress={() => setSelectedProviderId(providerId)}
                            />
                        ))}
                    </View>

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

                    <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'center' }}>
                        <RoundButton
                            testID="settings.server.relayAccess.refresh"
                            size="small"
                            display="inverted"
                            title={t('settings.relayAccess.refreshAction')}
                            onPress={() => {
                                void refreshStatus();
                            }}
                            disabled={isBusy || isUnavailable}
                        />
                        <RoundButton
                            testID="settings.server.relayAccess.save"
                            size="small"
                            display="inverted"
                            title={t('settings.relayAccess.saveAction')}
                            onPress={() => {
                                void save();
                            }}
                            disabled={isBusy || isUnavailable}
                        />
                        {resolvedConfigured ? (
                            <RoundButton
                                testID="settings.server.relayAccess.disable"
                                size="small"
                                display="inverted"
                                title={t('settings.relayAccess.disableAction')}
                                onPress={() => {
                                    void disableAction();
                                }}
                                disabled={isBusy || isUnavailable}
                            />
                        ) : null}
                    </View>

                    {lastErrorMessage ? (
                        <Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>
                            {lastErrorMessage}
                        </Text>
                    ) : null}
                    {activeTaskSnapshot ? (
                        <View style={{ width: '100%', gap: 6 }}>
                            <Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>
                                {t('settings.relayAccess.statusWorking')}
                            </Text>
                            {inlineStepLabel ? (
                                <Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>
                                    {inlineStepLabel}
                                </Text>
                            ) : null}
                            {inlineLatestMessage ? (
                                <Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>
                                    {inlineLatestMessage}
                                </Text>
                            ) : null}
                            <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
                                <RoundButton
                                    testID="settings.server.relayAccess.cancel"
                                    size="small"
                                    display="inverted"
                                    title={t('common.cancel')}
                                    onPress={cancel}
                                />
                            </View>
                        </View>
                    ) : null}
                </View>
            </>
        );
    }

    return (
        <>
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
                        ? t(PROVIDER_TITLE_KEYS[resolvedProviderId])
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

                <View>
                    {visibleProviderIds.map((providerId: RelayAccessProviderId) => (
                        <SelectableRow
                            key={providerId}
                            testID={`settings.server.relayAccess.choice:${providerId}`}
                            variant="selectable"
                            selected={selectedProviderId === providerId}
                            disabled={isBusy || isUnavailable}
                            title={t(PROVIDER_TITLE_KEYS[providerId])}
                            subtitle={t(PROVIDER_SUBTITLE_KEYS[providerId])}
                            onPress={() => setSelectedProviderId(providerId)}
                        />
                    ))}
                </View>

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
        </>
    );
});
