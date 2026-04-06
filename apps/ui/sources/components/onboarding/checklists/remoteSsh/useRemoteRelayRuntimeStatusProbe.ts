import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol';

import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { readLatestSystemTaskPrompt } from '@/components/systemTasks/prompts/readLatestSystemTaskPrompt';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { t } from '@/text';
import type { RemoteSshBootstrapFormState } from '@/components/systemTasks/remoteSshBootstrap/useRemoteSshBootstrapTask';
import { buildRemoteSshManageHostSystemTaskSpec } from '@/components/systemTasks/specs/remoteSsh/buildRemoteSshManageHostSystemTaskSpec';

export type RemoteRelayRuntimeStatusProbeResult = Readonly<{
    installed: boolean;
    relayUrl: string | null;
}>;

function readRemoteRelayRuntimeStatus(result: SystemTaskResult | null): RemoteRelayRuntimeStatusProbeResult | null {
    if (!result?.ok) {
        return null;
    }

    const data = result.data as { relayRuntime?: unknown } | null | undefined;
    const relayRuntime = data?.relayRuntime;
    if (!relayRuntime || typeof relayRuntime !== 'object' || Array.isArray(relayRuntime)) {
        return null;
    }

    const record = relayRuntime as {
        installed?: unknown;
        relayUrl?: unknown;
        health?: { url?: unknown } | null;
    };
    const relayUrl = typeof record.relayUrl === 'string'
        ? record.relayUrl.trim()
        : (typeof record.health?.url === 'string' ? record.health.url.trim() : '');

    return {
        installed: record.installed === true,
        relayUrl: relayUrl.length > 0 ? relayUrl : null,
    };
}

function readResultErrorMessage(result: SystemTaskResult | null): string | null {
    if (!result || result.ok) {
        return null;
    }
    const code = typeof result.error?.code === 'string' ? result.error.code.trim().toLowerCase() : '';
    if (code === 'cancelled' || code === 'canceled') {
        return null;
    }
    const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
    return message || null;
}

function buildProbeSignature(formState: RemoteSshBootstrapFormState): string {
    return JSON.stringify({
        sshUsername: formState.sshUsername,
        sshHost: formState.sshHost,
        sshPort: formState.sshPort,
        sshAuth: formState.sshAuth,
        sshPassword: formState.sshPassword,
        identityFilePath: formState.identityFilePath,
        identityPrivateKey: formState.identityPrivateKey,
    });
}

export function useRemoteRelayRuntimeStatusProbe(options: Readonly<{
    enabled: boolean;
    runner?: SystemTaskRunner;
    resolveFormState: () => Promise<RemoteSshBootstrapFormState>;
}>) {
    const runner = options.runner ?? getDefaultSystemTaskRunner();
    const [bridgeUnavailable, setBridgeUnavailable] = React.useState(false);
    const [taskId, setTaskId] = React.useState<string | null>(null);
    const [isStarting, setIsStarting] = React.useState(false);
    const [result, setResult] = React.useState<RemoteRelayRuntimeStatusProbeResult | null>(null);
    const [lastErrorMessage, setLastErrorMessage] = React.useState<string | null>(null);
    const snapshot = useSystemTaskSnapshot(runner, taskId);
    const prompt = React.useMemo(() => readLatestSystemTaskPrompt(snapshot), [snapshot]);
    const lastProbeSignatureRef = React.useRef<string | null>(null);
    const latestFormStateRef = React.useRef<RemoteSshBootstrapFormState | null>(null);
    const answeredPromptTaskIdRef = React.useRef<string | null>(null);
    const canceledPromptTaskIdRef = React.useRef<string | null>(null);
    const isUnavailable = runner.mode === 'unavailable' || bridgeUnavailable;

    React.useEffect(() => {
        if (!options.enabled || isUnavailable) {
            return;
        }

        let canceled = false;
        void (async () => {
            const formState = await options.resolveFormState();
            if (canceled) {
                return;
            }

            const signature = buildProbeSignature(formState);
            if (lastProbeSignatureRef.current === signature) {
                return;
            }
            lastProbeSignatureRef.current = signature;
            latestFormStateRef.current = formState;
            setResult(null);
            setLastErrorMessage(null);
            setIsStarting(true);
            try {
                const nextTaskId = await runner.start(buildRemoteSshManageHostSystemTaskSpec({
                    action: 'relayRuntime.status',
                    channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(),
                    sshUsername: formState.sshUsername,
                    sshHost: formState.sshHost,
                    sshPort: formState.sshPort,
                    sshAuth: formState.sshAuth,
                    sshPassword: formState.sshPassword,
                    identityFilePath: formState.identityFilePath,
                    identityPrivateKey: formState.identityPrivateKey,
                    knownHostsMode: 'app',
                    serviceMode: 'none',
                    relayRuntime: {
                        channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(),
                        mode: 'user',
                    },
                }));
                if (canceled) {
                    await runner.cancel(nextTaskId).catch(() => {});
                    return;
                }
                answeredPromptTaskIdRef.current = null;
                canceledPromptTaskIdRef.current = null;
                setBridgeUnavailable(false);
                setTaskId(nextTaskId);
            } catch (error) {
                const message = readSystemTaskStartErrorMessage(error);
                const unavailable = isSystemTaskBridgeUnavailableError(error);
                setBridgeUnavailable(unavailable);
                setLastErrorMessage(unavailable
                    ? t('settings.systemTaskBridgeUnavailable')
                    : (message ?? t('settings.systemTaskStartFailed')));
            } finally {
                if (!canceled) {
                    setIsStarting(false);
                }
            }
        })().catch((error) => {
            if (canceled) {
                return;
            }
            setLastErrorMessage(error instanceof Error ? error.message : t('settings.systemTaskStartFailed'));
            setIsStarting(false);
        });

        return () => {
            canceled = true;
        };
    }, [isUnavailable, options.enabled, options.resolveFormState, runner]);

    React.useEffect(() => {
        if (!taskId || !prompt || snapshot?.result) {
            return;
        }

        if (prompt.kind === 'ssh.password') {
            if (answeredPromptTaskIdRef.current === taskId) {
                return;
            }
            const password = String(latestFormStateRef.current?.sshPassword ?? '').trim();
            if (!password) {
                if (canceledPromptTaskIdRef.current === taskId) {
                    return;
                }
                canceledPromptTaskIdRef.current = taskId;
                void runner.cancel(taskId).catch(() => {});
                return;
            }
            answeredPromptTaskIdRef.current = taskId;
            void runner.respond(taskId, { password }).catch(() => {
                answeredPromptTaskIdRef.current = null;
            });
            return;
        }

        if (canceledPromptTaskIdRef.current === taskId) {
            return;
        }
        canceledPromptTaskIdRef.current = taskId;
        void runner.cancel(taskId).catch(() => {});
    }, [prompt, runner, snapshot?.result, taskId]);

    React.useEffect(() => {
        const nextResult = readRemoteRelayRuntimeStatus(snapshot?.result ?? null);
        if (nextResult) {
            setResult(nextResult);
            setLastErrorMessage(null);
            return;
        }

        const errorMessage = readResultErrorMessage(snapshot?.result ?? null);
        if (errorMessage) {
            setLastErrorMessage(errorMessage);
        }
    }, [snapshot]);

    const isBusy = options.enabled && (isStarting || (taskId != null && snapshot?.result == null));

    return {
        isBusy,
        isUnavailable,
        lastErrorMessage,
        result,
    };
}
