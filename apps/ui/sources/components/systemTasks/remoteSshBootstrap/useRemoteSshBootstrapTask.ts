import * as React from 'react';
import type { SystemTaskJsonObject, SystemTaskResult } from '@happier-dev/protocol';

import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';
import { readLatestSystemTaskPrompt } from '@/components/systemTasks/prompts/readLatestSystemTaskPrompt';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';

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
    }>
    | Readonly<{
        kind: 'daemon.replaceRemoteBackgroundServices';
        message: string;
        targetServerUrl: string | null;
        targetReleaseChannel: string | null;
        services: ReadonlyArray<Readonly<{
            label: string;
            releaseChannel: string | null;
            targetMode: string | null;
            running: boolean;
        }>>;
    }>;

export type RemoteSshBootstrapFormState = Readonly<{
    sshUsername: string;
    sshHost: string;
    sshPort: string;
    sshAuth: 'agent' | 'keyfile' | 'password';
    sshPassword: string;
    identityFilePath: string;
    identityPrivateKey: string;
    installRelayRuntime: boolean;
}>;

function resolveStatus(result: SystemTaskResult): SystemTaskRunState['status'] {
    if (result.ok) {
        return 'succeeded';
    }
    return (result.error.code === 'cancelled' || result.error.code === 'canceled') ? 'canceled' : 'failed';
}

function resolveRemotePrompt(snapshot: SystemTaskRunState | null): RemoteSshBootstrapPrompt | null {
    const prompt = readLatestSystemTaskPrompt(snapshot);
    if (!prompt) {
        return null;
    }
    const record = prompt.data as SystemTaskJsonObject & { kind?: unknown };
    const kind = prompt.kind;
    if (kind === 'ssh.trustHost' || kind === 'ssh.replaceHostKey') {
        const host = typeof record.host === 'string' ? record.host.trim() : '';
        const fingerprint = typeof record.fingerprint === 'string' ? record.fingerprint.trim() : '';
        if (!host || !fingerprint) {
            return null;
        }
        return {
            kind,
            message: prompt.message,
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
            message: prompt.message,
            publicKey: typeof record.publicKey === 'string' ? record.publicKey.trim() : null,
        };
    }

    if (kind === 'daemon.replaceRemoteBackgroundServices') {
        const servicesRaw = Array.isArray(record.services) ? record.services : [];
        const services = servicesRaw.flatMap((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return [];
            }
            const serviceRecord = entry as Record<string, unknown>;
            const label = typeof serviceRecord.label === 'string' ? serviceRecord.label.trim() : '';
            if (!label) {
                return [];
            }
            return [{
                label,
                releaseChannel: typeof serviceRecord.releaseChannel === 'string'
                    ? serviceRecord.releaseChannel.trim()
                    : null,
                targetMode: typeof serviceRecord.targetMode === 'string'
                    ? serviceRecord.targetMode.trim()
                    : null,
                running: serviceRecord.running === true,
            }];
        });
        return {
            kind,
            message: prompt.message,
            targetServerUrl: typeof record.targetServerUrl === 'string' ? record.targetServerUrl.trim() : null,
            targetReleaseChannel: typeof record.targetReleaseChannel === 'string' ? record.targetReleaseChannel.trim() : null,
            services,
        };
    }

    if (kind === 'ssh.password') {
        return {
            kind,
            message: prompt.message,
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
    serviceMode?: 'user' | 'none';
}>) {
    const runner = options.runner ?? getDefaultSystemTaskRunner();
    const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
    const [isStarting, setIsStarting] = React.useState(false);
    const [promptResolution, setPromptResolution] = React.useState<RemoteSshPromptResolution>({});
    const latestFormStateRef = React.useRef<RemoteSshBootstrapFormState | null>(null);
    const answeredPasswordPromptTaskIdRef = React.useRef<string | null>(null);
    const rawSnapshot = useSystemTaskSnapshot(runner, activeTaskId);
    const activeTaskSnapshot = React.useMemo(() => normalizeRemoteSnapshot(rawSnapshot), [rawSnapshot]);
    const prompt = React.useMemo(() => resolveRemotePrompt(rawSnapshot), [rawSnapshot]);

    const startWithResolution = React.useCallback(async (
        params: RemoteSshBootstrapFormState,
        nextPromptResolution: RemoteSshPromptResolution,
    ) => {
        latestFormStateRef.current = params;
        setIsStarting(true);
        try {
            const taskId = await runner.start(buildRemoteSshBootstrapMachineSystemTaskSpec({
                relayUrl: options.relayUrl,
                webappUrl: options.webappUrl,
                publicRelayUrl: options.publicRelayUrl,
                serviceMode: options.serviceMode,
                channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(),
                sshUsername: params.sshUsername,
                sshHost: params.sshHost,
                sshPort: params.sshPort,
                sshAuth: params.sshAuth,
                sshPassword: params.sshPassword,
                identityFilePath: params.identityFilePath,
                identityPrivateKey: params.sshAuth === 'keyfile' ? params.identityPrivateKey : undefined,
                installRelayRuntime: params.installRelayRuntime,
                promptResolution: nextPromptResolution,
            }));
            setActiveTaskId(taskId);
            return taskId;
        } finally {
            setIsStarting(false);
        }
    }, [options.publicRelayUrl, options.relayUrl, options.webappUrl, runner]);

    const start = React.useCallback(async (params: RemoteSshBootstrapFormState) => {
        return await startWithResolution(params, promptResolution);
    }, [promptResolution, startWithResolution]);

    const continueAfterPrompt = React.useCallback(async (params: RemoteSshBootstrapFormState) => {
        if (!prompt) {
            throw new Error('No prompt is waiting for continuation.');
        }
        if (prompt.kind === 'ssh.password') {
            throw new Error('SSH password prompts must be answered via answerPasswordPrompt().');
        }
        if (prompt.kind === 'daemon.replaceRemoteBackgroundServices') {
            if (!activeTaskId) {
                throw new Error('No remote background service prompt task is active.');
            }
            latestFormStateRef.current = params;
            await runner.respond(activeTaskId, { replaceExistingServices: true });
            return activeTaskId;
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

    const answerPasswordPrompt = React.useCallback(async (params: RemoteSshBootstrapFormState) => {
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

    const declinePrompt = React.useCallback(async () => {
        if (!prompt || prompt.kind !== 'daemon.replaceRemoteBackgroundServices') {
            throw new Error('No remote background service replacement prompt is waiting for a response.');
        }
        if (!activeTaskId) {
            throw new Error('No remote background service replacement task is active.');
        }
        await runner.respond(activeTaskId, { replaceExistingServices: false });
    }, [activeTaskId, prompt, runner]);

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
        declinePrompt,
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
