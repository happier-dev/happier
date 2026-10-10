import * as React from 'react';

import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import type { RemoteHostActionIdV1 } from '@happier-dev/protocol/remoteHosts/remoteHostActionIdsV1';

import type { SystemTaskRunner } from '@/components/systemTasks/types';
import type { SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { startAdmittedRemoteHostSystemTask } from './remoteHostTaskOperations';
import { buildSshHostKeyPromptBody } from '@/components/ssh/buildSshHostKeyPromptBody';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';
import { readLatestSystemTaskPrompt } from '@/components/systemTasks/prompts/readLatestSystemTaskPrompt';
import { useSshSystemTaskPromptModals } from '@/components/systemTasks/ssh/useSshSystemTaskPromptModals';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { getRemoteHostLocalOverrides } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { runRemoteHostRelayAccessTask } from '@/sync/ops/remoteHosts/remoteHostOperations';
import {
    buildRelayAccessSshTargetFromRemoteHostConfig,
} from './remoteHostOutcomeActions';
import {
    setNativeSshTunnelAuthPromptResolver,
    setNativeSshTunnelHostKeyPromptResolver,
} from '@/sync/runtime/nativeSshTunnels/runtime';
import { startNativeLoopbackTunnelRuntimeAppStateLifecycle } from '@/sync/runtime/nativeLoopbackTunnels/runtime';

type RelayAccessSelection = Readonly<{
    host: RemoteHost;
    target: RelayAccessTaskTarget;
    upstreamUrl: string | null;
    scope: ServerAccountScope;
    revision: number;
}>;

export function useRemoteHostOutcomeActions(options: Readonly<{
    runner: SystemTaskRunner;
    remoteHosts: readonly RemoteHost[];
    scope: ServerAccountScope | null;
    catalogRevision: number | 'absent' | null;
    secretMaterialAllowed: boolean;
    onSshTunnelEnsured?: () => void;
}>) {
    const activeServerSnapshot = useActiveServerSnapshot();
    const actionExecutor = React.useRef<Promise<ReturnType<typeof createDefaultActionExecutor>> | null>(null);
    const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
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
        startNativeLoopbackTunnelRuntimeAppStateLifecycle();
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

    const executeHostAction = React.useCallback(async (actionId: Extract<RemoteHostActionIdV1,
        'remote_hosts.setup_as_machine' | 'remote_hosts.relay.use' | 'remote_hosts.connect'>, remoteHost: RemoteHost) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!options.scope || typeof options.catalogRevision !== 'number'
            || !lifetime || !areServerAccountScopesEqual(lifetime.scope, options.scope)) {
            Modal.alert(t('common.error'), t('errors.operationFailed'));
            return null;
        }
        actionExecutor.current ??= import('@/sync/ops/actions/defaultActionExecutor').then(owner => owner.createDefaultActionExecutor());
        const executor = await actionExecutor.current;
        if (!lifetime.isCurrent()) {
            Modal.alert(t('common.error'), t('errors.operationFailed'));
            return null;
        }
        const result = await executor.execute(actionId,
            { hostId: remoteHost.id, expectedRevision: options.catalogRevision },
            { surface: 'ui', authority: 'present_user', serverId: options.scope.serverId, expectedAccountId: options.scope.accountId });
        if (!result.ok) {
            Modal.alert(t('common.error'), result.error);
            return null;
        }
        if (result.result && typeof result.result === 'object' && 'status' in result.result
            && (result.result.status === 'unavailable' || result.result.status === 'conflict' || result.result.status === 'outcome_unknown')) {
            Modal.alert(t('common.error'), t('errors.operationFailed'));
            return null;
        }
        return result.result;
    }, [options.catalogRevision, options.scope]);

    const setupAsMachine = React.useCallback(async (remoteHost: RemoteHost) => {
        const result = await executeHostAction('remote_hosts.setup_as_machine', remoteHost);
        if (result && typeof result === 'object' && 'status' in result && result.status === 'task_started'
            && 'taskId' in result && typeof result.taskId === 'string') {
            setActiveTaskId(result.taskId);
            setActiveTaskTitle(t('settings.remoteHostsSetupAsMachineTitle'));
            setActiveTaskKind('setupAsMachine');
        }
    }, [executeHostAction]);

    /** Relay navigation carries an address only; each actual task opens current material. */
    const selectRelayAccess = React.useCallback((remoteHost: RemoteHost) => {
        if (!options.scope || typeof options.catalogRevision !== 'number') return;
        const overrides = getRemoteHostLocalOverrides(remoteHost.id);
        const target = buildRelayAccessSshTargetFromRemoteHostConfig({ sshTarget: remoteHost.ssh.target,
            sshPort: remoteHost.ssh.port ?? null, sshAuth: remoteHost.ssh.authMode,
            identityFilePath: overrides?.identityFilePath ?? '', sshConfigFilePath: overrides?.sshConfigFilePath ?? '',
            identityPrivateKey: '', password: '' });
        if (!target) {
            Modal.alert(t('common.error'), t('settings.remoteHostsRelayAccessIdentityFileRequired'));
            return;
        }
        setRelayAccessSelection({ host: remoteHost, target,
            upstreamUrl: String(activeServerSnapshot.serverUrl ?? '').trim() || null,
            scope: options.scope, revision: options.catalogRevision });
    }, [activeServerSnapshot.serverUrl, options.catalogRevision, options.scope]);
    const openRelayAccess = React.useCallback(async (remoteHost: RemoteHost) => {
        await executeHostAction('remote_hosts.relay.use', remoteHost);
    }, [executeHostAction]);
    const configureRelayAccess = React.useCallback(async (remoteHost: RemoteHost) => {
        await executeHostAction('remote_hosts.relay.use', remoteHost);
    }, [executeHostAction]);
    const runRelayAccessTask = React.useCallback(async <T,>(run: (target: RelayAccessTaskTarget,
        startSpec?: (spec: SystemTaskSpec) => Promise<string>, admittedUpstreamUrl?: string | null) => Promise<T>): Promise<T> => {
        if (!relayAccessSelection) throw new Error('remote_host_unavailable');
        return runRemoteHostRelayAccessTask({ scope: relayAccessSelection.scope, hostId: relayAccessSelection.host.id,
            expectedRevision: relayAccessSelection.revision,
            run: (target, admittedUpstreamUrl, assertCurrent) => run(target,
                async spec => (await startAdmittedRemoteHostSystemTask({ runner: options.runner, assertCurrent }, spec)).taskId,
                admittedUpstreamUrl) });
    }, [options.runner, relayAccessSelection]);

    const connectFromThisDevice = React.useCallback(async (remoteHost: RemoteHost) => {
        const result = await executeHostAction('remote_hosts.connect', remoteHost);
        if (!result || typeof result !== 'object' || !('status' in result)) return;
        if (result.status === 'connected') { options.onSshTunnelEnsured?.(); return; }
        if (result.status === 'task_started' && 'taskId' in result && typeof result.taskId === 'string') {
            setActiveTaskId(result.taskId);
            setActiveTaskTitle(t('settings.remoteHostsConnectFromThisDeviceTitle'));
            setActiveTaskKind('connectFromThisDevice');
        }
    }, [executeHostAction, options.onSshTunnelEnsured]);

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

        if (!result.ok) {
            const message = resolveSystemTaskFailureMessage(result.error) ?? t('settings.remoteHostsSetupAsMachineFailed');
            Modal.alert(t('common.error'), message);
        }

        setActiveTaskId(null);
        setActiveTaskTitle(null);
        setActiveTaskKind(null);
    }, [
        activeTaskKind,
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
        configureRelayAccess,
        selectRelayAccess,
        runRelayAccessTask,
    };
}
