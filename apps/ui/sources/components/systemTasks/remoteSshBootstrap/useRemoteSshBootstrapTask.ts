import * as React from 'react';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { parseApproveRemoteProvisioningPromptData, parseSshPasswordPromptData, parseSshTrustPromptData, type ReplaceRemoteBackgroundServicesPromptData, type SshTrustPromptData } from '@happier-dev/protocol/system/tasks/promptPayloadContracts';
import type { SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';

import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import {
    resolveBackgroundServiceReplacementPrompt,
    resolveReleaseChannelSwitchSetupPrompt,
    type ReleaseChannelSwitchSetupPrompt,
} from '@/components/systemTasks/prompts/resolveBackgroundServiceSetupPrompt';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';
import { readLatestSystemTaskPrompt } from '@/components/systemTasks/prompts/readLatestSystemTaskPrompt';
import type { RemoteSshPromptResolution } from './buildRemoteSshBootstrapMachineSystemTaskSpec';
import { startRemoteSshBootstrapTask, continueRemoteSshBootstrapTask } from './remoteSshBootstrapTask';

export type RemoteSshBootstrapPrompt =
    | (Readonly<{
        message: string;
    }> & SshTrustPromptData)
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
    | ReleaseChannelSwitchSetupPrompt
    | (Readonly<{
        kind: 'daemon.replaceRemoteBackgroundServices';
        message: string;
    }> & ReplaceRemoteBackgroundServicesPromptData);

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

export function resolveRemoteSshBootstrapPrompt(snapshot: SystemTaskRunState | null): RemoteSshBootstrapPrompt | null {
    // Failed desktop tasks retain their trust/provisioning prompt for the
    // existing continuation restart; successful or canceled tasks do not.
    if (snapshot?.result?.ok || snapshot?.cancelRequested || snapshot?.status === 'canceled') return null;
    const prompt = readLatestSystemTaskPrompt(snapshot);
    if (!prompt) {
        return null;
    }
    const kind = prompt.kind;
    if (kind === 'ssh.trustHost' || kind === 'ssh.replaceHostKey') {
        const parsed = parseSshTrustPromptData(kind, prompt.data);
        if (!parsed) {
            return null;
        }
        return {
            message: prompt.message,
            ...parsed,
        };
    }

    if (kind === 'auth.approveRemoteProvisioning') {
        return {
            kind,
            message: prompt.message,
            ...parseApproveRemoteProvisioningPromptData(prompt.data),
        };
    }

    if (kind === 'daemon.replaceRemoteBackgroundServices') {
        const parsed = resolveBackgroundServiceReplacementPrompt(prompt);
        return parsed?.kind === 'daemon.replaceRemoteBackgroundServices'
            ? parsed
            : null;
    }

    if (kind === 'releaseChannel.switchDefaultForSetup') {
        return resolveReleaseChannelSwitchSetupPrompt(prompt);
    }

    if (kind === 'ssh.password') {
        return {
            kind,
            message: prompt.message,
            ...parseSshPasswordPromptData(prompt.data),
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
        awaitingInput: resolveRemoteSshBootstrapPrompt(snapshot) != null,
    };
}

export function useRemoteSshBootstrapTask(options: Readonly<{
    runner?: SystemTaskRunner;
    /** undefined preserves legacy presenter-local ownership; null/id is controlled. */
    taskId?: string | null;
    onTaskIdChange?: (taskId: string | null) => void;
    relayUrl: string;
    homeTarget?: ResolvedHomeTarget;
    webappUrl?: string;
    publicRelayUrl?: string;
    serviceMode?: 'user' | 'none';
    intent?: 'machineSetup' | 'personalHome.create';
}>) {
    const runner = options.runner ?? getSystemTasksRunner();
    const [localTaskId, setLocalTaskId] = React.useState<string | null>(null);
    const activeTaskId = options.taskId === undefined ? localTaskId : options.taskId;
    const setActiveTaskId = React.useCallback((taskId: string | null) => {
        setLocalTaskId(taskId);
        options.onTaskIdChange?.(taskId);
    }, [options.onTaskIdChange]);
    const [isStarting, setIsStarting] = React.useState(false);
    const [promptResolution, setPromptResolution] = React.useState<RemoteSshPromptResolution>({});
    const latestPasswordDraftRef = React.useRef('');
    const answeredPasswordPromptTaskIdRef = React.useRef<string | null>(null);
    const rawSnapshot = useSystemTaskSnapshot(runner, activeTaskId);
    const activeTaskSnapshot = React.useMemo(() => normalizeRemoteSnapshot(rawSnapshot), [rawSnapshot]);
    const prompt = React.useMemo(() => resolveRemoteSshBootstrapPrompt(rawSnapshot), [rawSnapshot]);

    const startWithResolution = React.useCallback(async (
        params: RemoteSshBootstrapFormState,
        nextPromptResolution: RemoteSshPromptResolution,
        startSpec?: (spec: SystemTaskSpec) => Promise<string>,
    ) => {
        // Referenced credentials belong to the admitted task, not a later UI
        // auto-response. Only an explicitly entered password draft is retained.
        latestPasswordDraftRef.current = startSpec ? '' : params.sshPassword;
        setIsStarting(true);
        try {
            const taskId = await startRemoteSshBootstrapTask({ ...options, runner, startSpec }, params, nextPromptResolution);
            setActiveTaskId(taskId);
            return taskId;
        } finally {
            setIsStarting(false);
        }
    }, [options.homeTarget, options.intent, options.publicRelayUrl, options.relayUrl, options.serviceMode, options.webappUrl, runner, setActiveTaskId]);

    const start = React.useCallback(async (params: RemoteSshBootstrapFormState, startSpec?: (spec: SystemTaskSpec) => Promise<string>) => {
        return await startWithResolution(params, promptResolution, startSpec);
    }, [promptResolution, startWithResolution]);

    const continueAfterPrompt = React.useCallback(async (params: RemoteSshBootstrapFormState, startSpec?: (spec: SystemTaskSpec) => Promise<string>) => {
        if (!prompt) {
            throw new Error('No prompt is waiting for continuation.');
        }
        if (prompt.kind === 'ssh.password') {
            throw new Error('SSH password prompts must be answered via answerPasswordPrompt().');
        }
        if (!activeTaskId) throw new Error('No remote SSH prompt task is active.');
        latestPasswordDraftRef.current = startSpec ? '' : params.sshPassword;
        const continued = await continueRemoteSshBootstrapTask({ options: { ...options, runner, startSpec }, form: params,
            taskId: activeTaskId, snapshot: rawSnapshot, prompt, resolution: promptResolution });
        setPromptResolution(continued.resolution);
        setActiveTaskId(continued.taskId);
        return continued.taskId;
    }, [activeTaskId, options.homeTarget, options.intent, options.publicRelayUrl, options.relayUrl, options.serviceMode, options.webappUrl, prompt, promptResolution, rawSnapshot, runner, setActiveTaskId]);

    const answerPasswordPrompt = React.useCallback(async (params: RemoteSshBootstrapFormState) => {
        if (!prompt || prompt.kind !== 'ssh.password') {
            throw new Error('No SSH password prompt is waiting for a response.');
        }
        if (!activeTaskId) {
            throw new Error('No SSH password prompt task is active.');
        }

        latestPasswordDraftRef.current = '';
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
        if (!prompt || (prompt.kind !== 'daemon.replaceRemoteBackgroundServices'
            && prompt.kind !== 'releaseChannel.switchDefaultForSetup')) {
            throw new Error('No remote service or release-channel prompt is waiting for a response.');
        }
        if (!activeTaskId) {
            throw new Error('No remote background service replacement task is active.');
        }
        await runner.respond(activeTaskId, prompt.kind === 'daemon.replaceRemoteBackgroundServices'
            ? { replaceExistingServices: false }
            : { switchDefaultReleaseChannel: false });
    }, [activeTaskId, prompt, runner]);

    const dismissPrompt = React.useCallback(() => {
        if (activeTaskId) {
            void runner.cancel(activeTaskId);
        }
        setActiveTaskId(null);
    }, [activeTaskId, runner, setActiveTaskId]);

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
        const password = latestPasswordDraftRef.current.trim();
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
        activeTaskId,
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
