import * as React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import type { SystemTaskResult } from '@happier-dev/protocol';

import { SystemTaskProgressCard, getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { setActiveShareableServerUrl } from '@/sync/domains/server/serverRuntime';
import { buildLocalTailscaleSecureAccessSystemTaskSpec } from './buildLocalTailscaleSecureAccessSystemTaskSpec';
import { decorateLocalControlSnapshot } from './decorateLocalControlSnapshot';

type TailscaleResultData = Readonly<{
    tailscaleInstalled: boolean;
    tailscaleLoggedIn: boolean;
    serveEnabled: boolean;
    shareableHttpsUrl: string | null;
    requiresApproval: Readonly<{ url: string }> | null;
}>;

function readTailscaleResultData(result: SystemTaskResult | null): TailscaleResultData | null {
    if (!result?.ok) {
        return null;
    }
    const data = result.data as Record<string, unknown> | undefined;
    return {
        tailscaleInstalled: data?.tailscaleInstalled === true,
        tailscaleLoggedIn: data?.tailscaleLoggedIn === true,
        serveEnabled: data?.serveEnabled === true,
        shareableHttpsUrl: typeof data?.shareableHttpsUrl === 'string' ? data.shareableHttpsUrl : null,
        requiresApproval: data?.requiresApproval && typeof data.requiresApproval === 'object' && typeof (data.requiresApproval as Record<string, unknown>).url === 'string'
            ? { url: String((data.requiresApproval as Record<string, unknown>).url) }
            : null,
    };
}

function readLatestPromptUrl(snapshot: SystemTaskRunState | null, wantedKind: string): string | null {
    const latestPrompt = snapshot?.events
        .slice()
        .reverse()
        .find((event) => {
            if (event.type !== 'prompt') {
                return false;
            }
            if (!event.data || typeof event.data !== 'object') {
                return false;
            }
            const record = event.data as Record<string, unknown>;
            if (record.kind !== wantedKind) {
                return false;
            }
            return typeof record.url === 'string';
        });
    const url = latestPrompt?.data && typeof latestPrompt.data === 'object'
        ? (latestPrompt.data as Record<string, unknown>).url
        : null;
    return typeof url === 'string' && url.trim().length > 0 ? url.trim() : null;
}

function readLatestPromptAnyUrl(snapshot: SystemTaskRunState | null, wantedKinds: readonly string[]): string | null {
    for (const kind of wantedKinds) {
        const url = readLatestPromptUrl(snapshot, kind);
        if (url) {
            return url;
        }
    }
    return null;
}

function resolveStatusSubtitle(params: Readonly<{
    installUrl: string | null;
    loginActionUrl: string | null;
    approvalUrl: string | null;
    hasUpstreamUrl: boolean;
    resultData: TailscaleResultData | null;
    snapshot: SystemTaskRunState | null;
}>): string {
    if (!params.hasUpstreamUrl) {
        return t('settings.localTailscale.statusUnavailable');
    }
    if (params.resultData?.shareableHttpsUrl) {
        return t('settings.localTailscale.statusReady');
    }
    if (params.installUrl) {
        return t('settings.localTailscale.statusInstallRequired');
    }
    if (params.loginActionUrl) {
        return t('settings.localTailscale.statusLoginRequired');
    }
    if (params.approvalUrl) {
        return t('settings.localTailscale.statusNeedsApproval');
    }
    if (params.snapshot && params.snapshot.result == null) {
        return t('settings.localTailscale.statusWorking');
    }
    return t('settings.localTailscale.statusIdle');
}

export const LocalTailscaleSecureAccessSection = React.memo(function LocalTailscaleSecureAccessSection(props: Readonly<{
    runner?: SystemTaskRunner;
    upstreamUrl: string | null;
}>) {
    const runner = props.runner ?? getDefaultSystemTaskRunner();
    const activeServerSnapshot = getActiveServerSnapshot();
    const [bridgeUnavailable, setBridgeUnavailable] = React.useState(false);
    const [taskId, setTaskId] = React.useState<string | null>(null);
    const [lastResult, setLastResult] = React.useState<TailscaleResultData | null>(null);
    const [lastErrorMessage, setLastErrorMessage] = React.useState<string | null>(null);
    const snapshot = useSystemTaskSnapshot(runner, taskId);
    const normalizedUpstreamUrl = React.useMemo(() => {
        const value = typeof props.upstreamUrl === 'string' ? props.upstreamUrl.trim() : '';
        return value.length > 0 ? value : null;
    }, [props.upstreamUrl]);
    const previousUpstreamUrlRef = React.useRef<string | null>(normalizedUpstreamUrl);

    React.useEffect(() => {
        const nextResult = readTailscaleResultData(snapshot?.result ?? null);
        if (nextResult) {
            setLastResult(nextResult);
            setLastErrorMessage(null);
            setActiveShareableServerUrl(nextResult.shareableHttpsUrl);
            return;
        }

        if (snapshot?.result && !snapshot.result.ok) {
            const message = typeof snapshot.result.error?.message === 'string' ? snapshot.result.error.message.trim() : '';
            if (message) {
                setLastErrorMessage(message);
            }
        }
    }, [snapshot]);

    React.useEffect(() => {
        if (previousUpstreamUrlRef.current === normalizedUpstreamUrl) {
            return;
        }
        previousUpstreamUrlRef.current = normalizedUpstreamUrl;
        setLastResult(null);
        setLastErrorMessage(null);
        if (!normalizedUpstreamUrl) {
            setTaskId(null);
        }
    }, [normalizedUpstreamUrl]);

    const decoratedSnapshot = React.useMemo(() => snapshot ? decorateLocalControlSnapshot(snapshot) : null, [snapshot]);
    const installUrl = readLatestPromptUrl(snapshot, 'tailscaleInstall');
    const loginActionUrl = readLatestPromptAnyUrl(snapshot, ['needsUserAction.openUrl', 'needsUserAction.scanQr']);
    const approvalUrl = lastResult?.requiresApproval?.url ?? readLatestPromptUrl(snapshot, 'tailscaleServeApproval');
    const hasUpstreamUrl = normalizedUpstreamUrl != null;
    const shareableHttpsUrl = hasUpstreamUrl
        ? (lastResult ? lastResult.shareableHttpsUrl : activeServerSnapshot.activeShareableServerUrl ?? null)
        : null;
    const isUnavailable = runner.mode === 'unavailable' || bridgeUnavailable;
    const isAwaitingPrompt = snapshot?.awaitingInput === true && taskId != null;
    const isBusy = snapshot != null && snapshot.result == null && !isAwaitingPrompt;

    const start = React.useCallback(async () => {
        if (isUnavailable || !normalizedUpstreamUrl || !hasUpstreamUrl) {
            return;
        }
        try {
            if (isAwaitingPrompt && taskId) {
                await runner.cancel(taskId).catch(() => {});
            }
            const nextTaskId = await runner.start(buildLocalTailscaleSecureAccessSystemTaskSpec({
                upstreamUrl: normalizedUpstreamUrl,
            }));
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
            setTaskId(nextTaskId);
        } catch (error) {
            const message = readSystemTaskStartErrorMessage(error);
            const unavailable = isSystemTaskBridgeUnavailableError(error);
            setBridgeUnavailable(unavailable);
            setLastErrorMessage(unavailable
                ? t('settings.systemTaskBridgeUnavailable')
                : (message ?? t('settings.systemTaskStartFailed')));
        }
    }, [hasUpstreamUrl, isAwaitingPrompt, isUnavailable, normalizedUpstreamUrl, runner, taskId]);

    const cancel = React.useCallback(() => {
        if (!taskId) {
            return;
        }
        void runner.cancel(taskId);
    }, [runner, taskId]);

    const openApproval = React.useCallback(() => {
        if (!approvalUrl) {
            return;
        }
        void openExternalUrl(approvalUrl);
    }, [approvalUrl]);
    const openInstallDocs = React.useCallback(() => {
        if (!installUrl) {
            return;
        }
        void openExternalUrl(installUrl);
    }, [installUrl]);
    const openLoginAction = React.useCallback(() => {
        if (!loginActionUrl) {
            return;
        }
        void openExternalUrl(loginActionUrl);
    }, [loginActionUrl]);
    const copyShareableUrl = React.useCallback(() => {
        if (!shareableHttpsUrl) {
            return;
        }
        void setClipboardStringSafe(shareableHttpsUrl).then((copied) => {
            if (copied) {
                Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: t('settings.localTailscale.shareableUrlTitle') }));
                return;
            }
            Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
        });
    }, [shareableHttpsUrl]);

    const handleAddThisPhone = React.useCallback(() => {
        if (!shareableHttpsUrl) {
            return;
        }
        router.push('/settings/add-phone');
    }, [shareableHttpsUrl]);

    return (
        <>
            <ItemGroup
                title={t('settings.localTailscale.title')}
                footer={t('settings.localTailscale.footer')}
            >
                <Item
                    testID="settings.localTailscale.status"
                    title={t('settings.localTailscale.statusTitle')}
                    subtitle={isUnavailable ? t('settings.systemTaskBridgeUnavailable') : resolveStatusSubtitle({
                        installUrl,
                        loginActionUrl,
                        approvalUrl,
                        hasUpstreamUrl,
                        resultData: lastResult,
                        snapshot,
                    })}
                    showChevron={false}
                    mode="info"
                />
                {shareableHttpsUrl ? (
                    <Item
                        testID="settings.localTailscale.shareableUrl"
                        title={t('settings.localTailscale.shareableUrlTitle')}
                        subtitle={shareableHttpsUrl}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                {shareableHttpsUrl ? (
                    <Item
                        testID="settings.localTailscale.copyShareableUrl"
                        title={t('common.copy')}
                        onPress={copyShareableUrl}
                    />
                ) : null}
                {shareableHttpsUrl ? (
                    <Item
                        testID="settings.localTailscale.addPhone"
                        title={t('settings.addYourPhone')}
                        onPress={handleAddThisPhone}
                    />
                ) : null}
                {approvalUrl ? (
                    <Item
                        testID="settings.localTailscale.approval"
                        title={t('settings.localTailscale.approvalTitle')}
                        subtitle={t('settings.localTailscale.approvalSubtitle')}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                {installUrl ? (
                    <Item
                        testID="settings.localTailscale.install"
                        title={t('settings.localTailscale.installTitle')}
                        subtitle={t('settings.localTailscale.installSubtitle')}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                {loginActionUrl ? (
                    <Item
                        testID="settings.localTailscale.login"
                        title={t('settings.localTailscale.loginTitle')}
                        subtitle={t('settings.localTailscale.loginSubtitle')}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                <Item
                    testID="settings.localTailscale.enable"
                    title={(shareableHttpsUrl || isAwaitingPrompt) ? t('settings.localTailscale.refreshAction') : t('settings.localTailscale.enableAction')}
                    onPress={() => {
                        void start();
                    }}
                    disabled={(!isAwaitingPrompt && isBusy) || !hasUpstreamUrl || isUnavailable}
                />
                {approvalUrl ? (
                    <Item
                        testID="settings.localTailscale.openApproval"
                        title={t('settings.localTailscale.openApprovalAction')}
                        onPress={openApproval}
                    />
                ) : null}
                {installUrl ? (
                    <Item
                        testID="settings.localTailscale.openInstall"
                        title={t('settings.localTailscale.openInstallAction')}
                        onPress={openInstallDocs}
                    />
                ) : null}
                {loginActionUrl ? (
                    <Item
                        testID="settings.localTailscale.openLogin"
                        title={t('settings.localTailscale.openLoginAction')}
                        onPress={openLoginAction}
                    />
                ) : null}
                {lastErrorMessage ? (
                    <Item
                        title={t('common.error')}
                        subtitle={lastErrorMessage}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
            </ItemGroup>
            {decoratedSnapshot && decoratedSnapshot.result == null ? (
                <SystemTaskProgressCard
                    title={t('settings.localTailscale.progressTitle')}
                    snapshot={decoratedSnapshot}
                    onCancel={cancel}
                />
            ) : null}
        </>
    );
});
