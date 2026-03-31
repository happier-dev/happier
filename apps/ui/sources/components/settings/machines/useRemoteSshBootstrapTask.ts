import * as React from 'react';
import type { SystemTaskEvent, SystemTaskJsonObject, SystemTaskResult } from '@happier-dev/protocol';

import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';

import {
    buildRemoteSshBootstrapMachineSystemTaskSpec,
    type RemoteSshPromptResolution,
} from './buildRemoteSshBootstrapMachineSystemTaskSpec';

export type RemoteSshBootstrapPrompt =
    | Readonly<{
        kind: 'ssh.trustHost' | 'ssh.replaceHostKey';
        message: string;
        host: string;
        keyType: string | null;
        fingerprint: string;
        existingFingerprint: string | null;
    }>
    | Readonly<{
        kind: 'ssh.password';
        message: string;
        target: string;
    }>
    | Readonly<{
        kind: 'auth.approveRemoteProvisioning';
        message: string;
        publicKey: string | null;
    }>;

type RemoteSshFormState = Readonly<{
    sshUsername: string;
    sshHost: string;
    sshPort: string;
    sshAuth: 'agent' | 'keyfile' | 'password';
    sshPassword: string;
    identityFilePath: string;
    installRelayRuntime: boolean;
}>;

function resolveStatus(result: SystemTaskResult): SystemTaskRunState['status'] {
    if (result.ok) {
        return 'succeeded';
    }
    return (result.error.code === 'cancelled' || result.error.code === 'canceled') ? 'canceled' : 'failed';
}

function resolveRemotePrompt(snapshot: SystemTaskRunState | null): RemoteSshBootstrapPrompt | null {
    if (!snapshot) {
        return null;
    }

    const promptEvent = [...snapshot.events].reverse().find((event) => event.type === 'prompt');
    if (!promptEvent) {
        return null;
    }

    const promptData = promptEvent.data;
    if (!promptData || typeof promptData !== 'object' || Array.isArray(promptData)) {
        return null;
    }

    const record = promptData as SystemTaskJsonObject & { kind?: unknown };
    const kind = typeof record.kind === 'string' ? record.kind : '';
    if (kind === 'ssh.trustHost' || kind === 'ssh.replaceHostKey') {
        const host = typeof record.host === 'string' ? record.host.trim() : '';
        const fingerprint = typeof record.fingerprint === 'string' ? record.fingerprint.trim() : '';
        if (!host || !fingerprint) {
            return null;
        }
        return {
            kind,
            message: promptEvent.message ?? snapshot.latestMessage ?? '',
            host,
            keyType: typeof record.keyType === 'string' ? record.keyType.trim() : null,
            fingerprint,
            existingFingerprint: typeof record.existingFingerprint === 'string'
                ? record.existingFingerprint.trim()
                : null,
        };
    }

    if (kind === 'auth.approveRemoteProvisioning') {
        return {
            kind,
            message: promptEvent.message ?? snapshot.latestMessage ?? '',
            publicKey: typeof record.publicKey === 'string' ? record.publicKey.trim() : null,
        };
    }

    if (kind === 'ssh.password') {
        return {
            kind,
            message: promptEvent.message ?? snapshot.latestMessage ?? '',
            target: typeof record.target === 'string' ? record.target.trim() : '',
        };
    }

    return null;
}

function normalizeRemoteSnapshot(snapshot: SystemTaskRunState | null): SystemTaskRunState | null {
    if (!snapshot) {
        return null;
    }

    return {
        ...snapshot,
        status: snapshot.result ? resolveStatus(snapshot.result) : snapshot.status,
        awaitingInput: resolveRemotePrompt(snapshot) != null,
    };
}

export function useRemoteSshBootstrapTask(options: Readonly<{
    runner?: SystemTaskRunner;
    relayUrl: string;
    webappUrl?: string;
    publicRelayUrl?: string;
}>) {
    const runner = options.runner ?? getDefaultSystemTaskRunner();
    const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
    const [isStarting, setIsStarting] = React.useState(false);
    const [promptResolution, setPromptResolution] = React.useState<RemoteSshPromptResolution>({});
    const latestFormStateRef = React.useRef<RemoteSshFormState | null>(null);
    const answeredPasswordPromptTaskIdRef = React.useRef<string | null>(null);
    const rawSnapshot = useSystemTaskSnapshot(runner, activeTaskId);
    const activeTaskSnapshot = React.useMemo(() => normalizeRemoteSnapshot(rawSnapshot), [rawSnapshot]);
    const prompt = React.useMemo(() => resolveRemotePrompt(rawSnapshot), [rawSnapshot]);

    const startWithResolution = React.useCallback(async (
        params: RemoteSshFormState,
        nextPromptResolution: RemoteSshPromptResolution,
    ) => {
        latestFormStateRef.current = params;
        setIsStarting(true);
        try {
            const taskId = await runner.start(buildRemoteSshBootstrapMachineSystemTaskSpec({
                relayUrl: options.relayUrl,
                webappUrl: options.webappUrl,
                publicRelayUrl: options.publicRelayUrl,
                sshUsername: params.sshUsername,
                sshHost: params.sshHost,
                sshPort: params.sshPort,
                sshAuth: params.sshAuth,
                identityFilePath: params.identityFilePath,
                installRelayRuntime: params.installRelayRuntime,
                promptResolution: nextPromptResolution,
            }));
            setActiveTaskId(taskId);
            return taskId;
        } finally {
            setIsStarting(false);
        }
    }, [options.publicRelayUrl, options.relayUrl, options.webappUrl, runner]);

    const start = React.useCallback(async (params: RemoteSshFormState) => {
        return await startWithResolution(params, promptResolution);
    }, [promptResolution, startWithResolution]);

    const continueAfterPrompt = React.useCallback(async (params: RemoteSshFormState) => {
        if (!prompt) {
            throw new Error('No prompt is waiting for continuation.');
        }
        if (prompt.kind === 'ssh.password') {
            throw new Error('SSH password prompts must be answered via answerPasswordPrompt().');
        }

        latestFormStateRef.current = params;

        const nextPromptResolution: RemoteSshPromptResolution = prompt.kind === 'auth.approveRemoteProvisioning'
            ? {
                ...promptResolution,
                ...(prompt.publicKey ? { authApproval: { publicKey: prompt.publicKey } } : {}),
            }
            : {
                ...promptResolution,
                hostTrust: {
                    kind: prompt.kind,
                    fingerprint: prompt.fingerprint,
                    ...(prompt.kind === 'ssh.replaceHostKey'
                        ? { existingFingerprint: prompt.existingFingerprint }
                        : {}),
                },
            };

        if (activeTaskId && rawSnapshot?.result == null) {
            await runner.cancel(activeTaskId).catch(() => {});
        }

        setPromptResolution(nextPromptResolution);
        return await startWithResolution(params, nextPromptResolution);
    }, [activeTaskId, prompt, promptResolution, rawSnapshot, runner, startWithResolution]);

    const answerPasswordPrompt = React.useCallback(async (params: RemoteSshFormState) => {
        if (!prompt || prompt.kind !== 'ssh.password') {
            throw new Error('No SSH password prompt is waiting for a response.');
        }
        if (!activeTaskId) {
            throw new Error('No SSH password prompt task is active.');
        }

        latestFormStateRef.current = params;
        const password = String(params.sshPassword ?? '').trim();
        if (!password) {
            throw new Error('SSH password is required.');
        }
        answeredPasswordPromptTaskIdRef.current = activeTaskId;
        await runner.respond(activeTaskId, { password });
    }, [activeTaskId, prompt, runner]);

    const cancel = React.useCallback(() => {
        if (!activeTaskId) {
            return;
        }
        void runner.cancel(activeTaskId);
    }, [activeTaskId, runner]);

    const dismissPrompt = React.useCallback(() => {
        setActiveTaskId(null);
    }, []);

    const resetPromptResolution = React.useCallback(() => {
        setPromptResolution({});
    }, []);

    React.useEffect(() => {
        if (!prompt || prompt.kind !== 'ssh.password') {
            answeredPasswordPromptTaskIdRef.current = null;
            return;
        }
        if (!activeTaskId || answeredPasswordPromptTaskIdRef.current === activeTaskId) {
            return;
        }
        const password = String(latestFormStateRef.current?.sshPassword ?? '').trim();
        if (!password) {
            return;
        }
        answeredPasswordPromptTaskIdRef.current = activeTaskId;
        void runner.respond(activeTaskId, { password }).catch(() => {
            answeredPasswordPromptTaskIdRef.current = null;
        });
    }, [activeTaskId, prompt, runner]);

    const completedMachineId = React.useMemo(() => {
        if (!activeTaskSnapshot?.result?.ok) {
            return null;
        }
        const machineId = (activeTaskSnapshot.result.data as { machineId?: unknown } | undefined)?.machineId;
        return typeof machineId === 'string' && machineId.trim() ? machineId.trim() : null;
    }, [activeTaskSnapshot]);

    return {
        activeTaskSnapshot,
        cancel,
        completedMachineId,
        continueAfterPrompt,
        dismissPrompt,
        isStarting,
        prompt,
        resetPromptResolution,
        answerPasswordPrompt,
        start,
    };
}
