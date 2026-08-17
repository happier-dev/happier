import * as React from 'react';

import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { buildSshHostKeyPromptBody } from '@/components/ssh/buildSshHostKeyPromptBody';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';
import { readLatestSystemTaskPrompt } from '@/components/systemTasks/prompts/readLatestSystemTaskPrompt';
import { useSshSystemTaskPromptModals } from '@/components/systemTasks/ssh/useSshSystemTaskPromptModals';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import type { RemoteHost, RemoteHostsV1Raw } from '@/sync/domains/remoteHosts/remoteHostModel';
import { getRemoteHostLocalOverrides } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';
import {
    resolveRemoteHostEffectiveSshConfig,
    type RemoteHostEffectiveSshConfig,
} from '@/sync/domains/remoteHosts/resolveRemoteHostEffectiveSshConfig';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { persistRemoteHostAfterRemoteSshCompletion } from '@/components/onboarding/checklists/remoteSsh/persistRemoteHostAfterRemoteSshCompletion';

import {
    buildSshTunnelEnsureSystemTaskSpec,
} from '@/components/systemTasks/specs/localControl/buildSshTunnelSystemTaskSpec';
import {
    buildRelayAccessSshTargetFromRemoteHostConfig,
    buildNativeSshTunnelCredentialsFromRemoteHostConfig,
    buildNativeSshTunnelRequestFromRemoteHostConfig,
    buildRemoteHostBootstrapSystemTaskSpec,
    buildSshTunnelEnsureRequestFromRemoteHostConfig,
    buildSshCredentialsDraftFromRemoteHostConfig,
} from './remoteHostOutcomeActions';
import {
    getNativeSshTunnelRuntime,
    setNativeSshTunnelAuthPromptResolver,
    setNativeSshTunnelCredentialResolution,
    setNativeSshTunnelHostKeyPromptResolver,
    startNativeSshTunnelRuntimeAppStateLifecycle,
} from '@/sync/runtime/nativeSshTunnels/runtime';

const REMOTE_HOST_FORM_NEW_SENTINEL_ID = '__new__';

type RelayAccessSelection = Readonly<{
    host: RemoteHost;
    target: RelayAccessTaskTarget;
    upstreamUrl: string | null;
}>;

function readCompletionString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readBootstrapCompletion(resultData: unknown): Readonly<{
    machineId: string | null;
    relayRuntimeUrl: string | null;
}> {
    const data = resultData && typeof resultData === 'object'
        ? resultData as Record<string, unknown>
        : {};
    return {
        machineId: readCompletionString(data.machineId),
        relayRuntimeUrl: readCompletionString(data.relayRuntimeUrl),
    };
}

export function useRemoteHostOutcomeActions(options: Readonly<{
    runner: SystemTaskRunner;
    remoteHosts: readonly RemoteHost[];
    remoteHostsRaw: RemoteHostsV1Raw;
    secretMaterialAllowed: boolean;
    onSshTunnelEnsured?: () => void;
}>) {
    const activeServerSnapshot = useActiveServerSnapshot();
    const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
    const [activeTaskHostId, setActiveTaskHostId] = React.useState<string | null>(null);
    const [activeTaskConfig, setActiveTaskConfig] = React.useState<RemoteHostEffectiveSshConfig | null>(null);
    const [activeTaskTitle, setActiveTaskTitle] = React.useState<string | null>(null);
    const [activeTaskKind, setActiveTaskKind] = React.useState<'setupAsMachine' | 'connectFromThisDevice' | null>(null);
    const [relayAccessSelection, setRelayAccessSelection] = React.useState<RelayAccessSelection | null>(null);
    const nativeLoopbackTunnelAvailable = options.runner.mode === 'native'
        && options.runner.capabilities?.nativeSsh?.available === true
        && options.runner.capabilities.nativeSsh.supportsLoopbackTunnel === true;
    const activeTaskSnapshot = useSystemTaskSnapshot(options.runner, activeTaskId);
    const latestPrompt = React.useMemo(() => readLatestSystemTaskPrompt(activeTaskSnapshot), [activeTaskSnapshot]);

    React.useEffect(() => {
        if (!nativeLoopbackTunnelAvailable) {
            setNativeSshTunnelHostKeyPromptResolver(null);
            setNativeSshTunnelAuthPromptResolver(null);
            return;
        }
        setNativeSshTunnelHostKeyPromptResolver(async (event) => {
            const isReplacement = event.status === 'changed';
            const accepted = await Modal.confirm(
                isReplacement
                    ? t('settings.remoteHostsReplaceHostKeyTitle')
                    : t('setupOnboarding.remoteSshChecklist.trustHostTitle'),
                buildSshHostKeyPromptBody({
                    host: event.host,
                    fingerprint: event.fingerprintSha256,
                    existingFingerprint: isReplacement ? event.existingFingerprintSha256 ?? null : null,
                }),
                {
                    confirmText: isReplacement
                        ? t('settings.remoteHostsReplaceHostKeyAction')
                        : t('setupOnboarding.remoteSshChecklist.trustHostTitle'),
                    cancelText: t('common.cancel'),
                },
            );
            return accepted
                ? {
                    decision: 'accept-once',
                    fingerprintSha256: event.fingerprintSha256,
                }
                : {
                    decision: 'reject',
                    reason: 'SSH host trust was declined.',
                };
        });
        setNativeSshTunnelAuthPromptResolver(async (event) => {
            if (event.kind === 'private-key-passphrase') {
                const passphrase = await Modal.prompt(
                    t('settings.remoteHostsPrivateKeyPassphraseTitle'),
                    event.host || undefined,
                    { inputType: 'secure-text', confirmText: t('common.continue'), cancelText: t('common.cancel') },
                );
                return passphrase == null
                    ? {
                        decision: 'cancel',
                        reason: 'cancelled',
                    }
                    : {
                        decision: 'submit',
                        value: passphrase,
                    };
            }

            const answers: Array<{ id: string; value: string }> = [];
            for (const prompt of event.prompts) {
                const value = await Modal.prompt(
                    prompt.label || t('settings.remoteHostsKeyboardInteractivePromptLabel'),
                    t('settings.remoteHostsKeyboardInteractiveTitle'),
                    {
                        inputType: prompt.echo ? 'default' : 'secure-text',
                        confirmText: t('common.continue'),
                        cancelText: t('common.cancel'),
                    },
                );
                if (value == null) {
                    return {
                        decision: 'cancel',
                        reason: 'cancelled',
                    };
                }
                answers.push({ id: prompt.id, value });
            }
            return {
                decision: 'submit',
                answers,
            };
        });
        startNativeSshTunnelRuntimeAppStateLifecycle();
        return () => {
            setNativeSshTunnelHostKeyPromptResolver(null);
            setNativeSshTunnelAuthPromptResolver(null);
        };
    }, [nativeLoopbackTunnelAvailable]);

    useSshSystemTaskPromptModals({
        runner: options.runner,
        taskId: activeTaskId,
        snapshot: activeTaskSnapshot,
        prompt: latestPrompt,
    });

    const resolveConfig = React.useCallback(async (remoteHost: RemoteHost) => {
        const resolved = await resolveRemoteHostEffectiveSshConfig({
            remoteHost,
            localOverrides: getRemoteHostLocalOverrides(remoteHost.id),
            secretMaterialAllowed: options.secretMaterialAllowed,
            decryptSecretValue: (input) => sync.decryptSecretValue(input),
        });
        if (!resolved.ok) {
            Modal.alert(t('common.error'), resolved.error.message);
            return null;
        }
        return resolved.value;
    }, [options.secretMaterialAllowed]);

    const setupAsMachine = React.useCallback(async (remoteHost: RemoteHost) => {
        const config = await resolveConfig(remoteHost);
        if (!config) return;

        const spec = buildRemoteHostBootstrapSystemTaskSpec({
            remoteHostId: remoteHost.id,
            config,
            activeServerSnapshot,
        });
        if (!spec) {
            Modal.alert(t('common.error'), t('settings.remoteHostsMissingServerUrl'));
            return;
        }

        try {
            const taskId = await options.runner.start(spec);
            setActiveTaskId(taskId);
            setActiveTaskHostId(remoteHost.id);
            setActiveTaskConfig(config);
            setActiveTaskTitle(t('settings.remoteHostsSetupAsMachineTitle'));
            setActiveTaskKind('setupAsMachine');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            Modal.alert(t('common.error'), message || t('settings.systemTaskStartFailed'));
        }
    }, [activeServerSnapshot, options.runner, resolveConfig]);

    const openRelayAccess = React.useCallback(async (remoteHost: RemoteHost) => {
        const config = await resolveConfig(remoteHost);
        if (!config) return;

        const target = buildRelayAccessSshTargetFromRemoteHostConfig(config);
        if (!target) {
            Modal.alert(t('common.error'), t('settings.remoteHostsRelayAccessIdentityFileRequired'));
            return;
        }

        setRelayAccessSelection({
            host: remoteHost,
            target,
            upstreamUrl: String(activeServerSnapshot.serverUrl ?? '').trim() || null,
        });
    }, [activeServerSnapshot.serverUrl, resolveConfig]);

    const connectFromThisDevice = React.useCallback(async (remoteHost: RemoteHost) => {
        const config = await resolveConfig(remoteHost);
        if (!config) return;

        if (options.runner.mode === 'native') {
            const credentials = buildNativeSshTunnelCredentialsFromRemoteHostConfig(config);
            if (!credentials || !nativeLoopbackTunnelAvailable) {
                Modal.alert(
                    t('common.info'),
                    t('settings.remoteHostsNativeSshTunnelRequiresEngine'),
                );
                return;
            }
            const tunnelRequest = buildNativeSshTunnelRequestFromRemoteHostConfig({
                remoteHostId: remoteHost.id,
                config,
            });
            setNativeSshTunnelCredentialResolution(tunnelRequest.credentialsRef, credentials);
            try {
                await getNativeSshTunnelRuntime().ensureTunnel(tunnelRequest);
                options.onSshTunnelEnsured?.();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error ?? '');
                Modal.alert(t('common.error'), message || t('settings.remoteHostsConnectFromThisDeviceFailed'));
            }
            return;
        }

        try {
            const taskId = await options.runner.start(buildSshTunnelEnsureSystemTaskSpec(
                buildSshTunnelEnsureRequestFromRemoteHostConfig({
                    remoteHostId: remoteHost.id,
                    serverId: activeServerSnapshot.serverId,
                    config,
                }),
            ));
            setActiveTaskId(taskId);
            setActiveTaskHostId(null);
            setActiveTaskConfig(null);
            setActiveTaskTitle(t('settings.remoteHostsConnectFromThisDeviceTitle'));
            setActiveTaskKind('connectFromThisDevice');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            Modal.alert(t('common.error'), message || t('settings.systemTaskStartFailed'));
        }
    }, [activeServerSnapshot.serverId, nativeLoopbackTunnelAvailable, options, resolveConfig]);

    React.useEffect(() => {
        const result = activeTaskSnapshot?.result;
        if (!result) return;

        if (activeTaskKind === 'connectFromThisDevice') {
            if (result.ok) {
                options.onSshTunnelEnsured?.();
            } else {
                const message = result.error.message || t('settings.remoteHostsConnectFromThisDeviceFailed');
                Modal.alert(t('common.error'), message);
            }
            setActiveTaskId(null);
            setActiveTaskTitle(null);
            setActiveTaskKind(null);
            return;
        }

        if (!activeTaskHostId || !activeTaskConfig) {
            setActiveTaskId(null);
            setActiveTaskTitle(null);
            setActiveTaskKind(null);
            return;
        }

        if (result.ok) {
            persistRemoteHostAfterRemoteSshCompletion({
                managementEnabled: true,
                secretMaterialEnabled: options.secretMaterialAllowed,
                remoteHostsRaw: options.remoteHostsRaw,
                selectedSavedRemoteHostId: activeTaskHostId,
                runContext: {
                    selectedSavedRemoteHostId: activeTaskHostId,
                    saveHost: false,
                    saveSecretMaterial: false,
                },
                newHostSentinelId: REMOTE_HOST_FORM_NEW_SENTINEL_ID,
                draft: buildSshCredentialsDraftFromRemoteHostConfig(activeTaskConfig),
                privateKeyMaterialDraft: '',
                completion: readBootstrapCompletion(result.data),
            });
        } else {
            const message = result.error.message || t('settings.remoteHostsSetupAsMachineFailed');
            Modal.alert(t('common.error'), message);
        }

        setActiveTaskId(null);
        setActiveTaskHostId(null);
        setActiveTaskConfig(null);
        setActiveTaskTitle(null);
        setActiveTaskKind(null);
    }, [
        activeTaskConfig,
        activeTaskKind,
        activeTaskHostId,
        activeTaskSnapshot?.result,
        options.onSshTunnelEnsured,
        options.remoteHosts,
        options.secretMaterialAllowed,
    ]);

    return {
        activeTaskSnapshot,
        activeTaskTitle,
        connectFromThisDevice,
        relayAccessSelection,
        setupAsMachine,
        openRelayAccess,
    };
}
