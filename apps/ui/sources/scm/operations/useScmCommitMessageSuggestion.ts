import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import { useSessionAgentTargetKey, useSessionMachineId } from '@/sync/store/hooks';
import { t } from '@/text';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
    generateScmCommitMessage,
    readScmCommitMessageSuggestion,
    stopScmCommitMessageSuggestion,
    type CommitMessageHostV1,
} from './commitMessageGenerator';

function hostKey(host: CommitMessageHostV1 | null): string {
    if (!host) return '';
    return host.kind === 'workspace'
        ? JSON.stringify(['workspace', host.workspace.serverId, host.workspace.workspaceId, host.workspace.machineId, host.workspace.rootPath])
        : JSON.stringify(['session', host.serverId, host.sessionId]);
}

/** One suggestion owner for both hosts; an accepted pending Run is observed rather than restarted. */
export function useScmCommitMessageSuggestion(host: CommitMessageHostV1 | null, scopePaths: readonly string[], comparisonKey?: string) {
    const home = host?.kind === 'workspace' ? host.workspace.serverId : host?.serverId;
    const binding = useServerCredentialAccountScopeBinding(home).binding;
    // Auto resolves the runner on the machine that runs the commit message.
    const sessionMachineId = useSessionMachineId(host?.kind === 'session' ? host.sessionId : '');
    const sessionAgentTargetKey = useSessionAgentTargetKey(host?.kind === 'session' ? host.sessionId : '');
    const resolvedHost = React.useMemo(() => host?.kind === 'session' && binding
        ? { ...host, serverId: binding.scope.serverId, machineId: sessionMachineId, agentTargetKey: sessionAgentTargetKey } : host,
        [host, binding?.scope.serverId, sessionMachineId, sessionAgentTargetKey]);
    const enabledSetting = useSetting('scmCommitMessageGeneratorEnabled');
    const runnerChoice = useSetting('scmCommitMessageGeneratorRunnerV1');
    const instructions = useSetting('scmCommitMessageGeneratorInstructions');
    const pendingRef = React.useRef<Readonly<{ host: CommitMessageHostV1; key: string; runId: string }> | null>(null);
    const key = JSON.stringify([hostKey(resolvedHost), binding?.scope.serverId ?? null, binding?.scope.accountId ?? null, scopePaths, comparisonKey]);
    const currentKeyRef = React.useRef(key);
    currentKeyRef.current = key;
    const enabled = enabledSetting === true && host !== null && binding?.isCurrent() === true;
    const generate = React.useCallback(async () => {
        if (!resolvedHost || enabledSetting !== true || !binding?.isCurrent()) return { ok: false as const, error: t('files.commitMessageEditor.generatorDisabled') };
        const pending = pendingRef.current;
        const result = pending?.key === key
            ? await readScmCommitMessageSuggestion({ host: pending.host, runId: pending.runId })
            : await generateScmCommitMessage({
                host: resolvedHost,
                choice: runnerChoice ?? null,
                instructions: typeof instructions === 'string' ? instructions : undefined,
                scopePaths,
            });
        // The Action front door retires its in-flight call as soon as the Account changes, which can precede this
        // hook's own rerender; both are the same retired scope and neither may disclose the old Account's outcome.
        const retiredByAction = !result.ok && result.errorCode === 'action_account_scope_changed';
        if (!binding.isCurrent() || currentKeyRef.current !== key || retiredByAction) return { ok: false as const,
            error: t('common.unavailable'), errorCode: 'SCM_COMMIT_MESSAGE_SCOPE_RETIRED' };
        if (!result.ok && result.runId && result.outcome) {
            pendingRef.current = { host: resolvedHost, key, runId: result.runId };
        } else if (pendingRef.current?.key === key) {
            pendingRef.current = null;
        }
        return !result.ok && result.outcome === 'pending'
            ? { ...result, error: t('common.running') }
            : result;
    }, [binding, runnerChoice, enabledSetting, resolvedHost, instructions, key, scopePaths]);
    const cancel = React.useCallback(async () => {
        const pending = pendingRef.current;
        if (!binding?.isCurrent() || !pending || pending.key !== key) return;
        // Stop acknowledgement is not a terminal fact. Retain the handle for the next observation.
        const result = await stopScmCommitMessageSuggestion({ host: pending.host, runId: pending.runId });
        if (!result.ok) throw new Error(result.error);
        return result;
    }, [binding, key]);
    return { enabled, generate, cancel, contextKey: key };
}
