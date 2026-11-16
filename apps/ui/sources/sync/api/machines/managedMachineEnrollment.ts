import {
    SystemTaskExecutionError,
    runManagedMachineEnrollment,
    projectManagedMachineBootstrapPrompt,
    installManagedGuestCliViaRemoteDownload,
    type ManagedMachineEnrollmentInput,
    type ManagedMachineEnrollmentDependencies,
} from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { readHostAdmittedReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ManagedAcquireInputV1, ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ActionOperationProgressV1, ManagedMachineBootstrapPromptV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { randomUUID } from '@/platform/randomUUID';
import { approveNativeLocalAuthRequest } from '@/components/systemTasks/remoteSshBootstrap/nativeTask';
import { createUiManagedAccountSshTask } from './managedMachineAccountSsh';
import { answerSshSystemTaskPrompt } from '@/components/systemTasks/ssh/answerSshSystemTaskPrompt';
import { answerManagedCreationEstablish } from '@/components/settings/machines/managed/managedCreationPrompt';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

export type UiManagedMachineEnrollmentInput = ManagedMachineEnrollmentInput & Readonly<{
    credentials: AuthCredentials;
    context: ActionExecutorContext;
    /** The executing consumer's own input, not the reviewed parent's snapshot. */
    reviewedAction: ManagedAcquireInputV1 | ManagedMachineActionInputV1<'machines.managed.bootstrap.retry'>;
    onProgress?(progress: ActionOperationProgressV1): void;
    onPrompt?(prompt: ManagedMachineBootstrapPromptV1 | null): void;
}>;
export type UiManagedMachineEnrollmentDependencies = Omit<ManagedMachineEnrollmentDependencies,
    // Cross-Account requester delivery remains with the existing controller path.
    'runTask' | 'approveLocalAuthRequest' | 'createPromptId' | 'deliverAuthApproval' | 'createPairingDelivery'> & Readonly<{
    readBootstrapCredential?(): Promise<string>;
}>;

/** The default downloader cannot deliver Home-owned payload bytes, even on a native HTTP host. */
export function readUiManagedMachineEnrollmentCapabilities(
    deps?: Pick<UiManagedMachineEnrollmentDependencies, 'installNativePayload'>,
): Readonly<{ localPayloadAvailable: boolean }> {
    return { localPayloadAvailable: typeof deps?.installNativePayload === 'function' };
}

/** Invoking-app IO and private questions for the shared ordinary enrollment recipe. */
export async function runUiManagedMachineEnrollment(input: UiManagedMachineEnrollmentInput,
    deps: UiManagedMachineEnrollmentDependencies): Promise<Readonly<{ machineId: string }>> {
    const reviewedParent = readHostAdmittedReviewedParentV1(input.context.hostReviewedChild);
    if (!reviewedParent || !sameStrictJsonValue(reviewedParent.input, input.reviewedAction)) {
        throw new SystemTaskExecutionError('admission_unavailable', 'Managed enrollment does not match the executing creation.');
    }
    const isCurrent = () => !input.signal?.aborted;
    const cancelled = () => { throw new SystemTaskExecutionError('cancelled', 'Managed installation was cancelled.'); };
    const prompt = async (prompt: Parameters<typeof projectManagedMachineBootstrapPrompt>[0]) => {
        input.signal?.throwIfAborted();
        const projected = projectManagedMachineBootstrapPrompt(prompt);
        input.onPrompt?.(projected);
        try {
            if (projected.kind === 'administrator.establish') {
                const response = await answerManagedCreationEstablish({ prompt: projected, isCurrent,
                    respond: async password => ({ kind: 'completed', value: { password } }),
                    decline: async () => cancelled(),
                });
                if (response.kind !== 'completed') return cancelled();
                return response.value;
            }
            const answer = await answerSshSystemTaskPrompt({ kind: projected.kind, message: projected.message,
                data: 'host' in projected ? { host: projected.host, keyType: projected.keyType,
                    fingerprint: projected.fingerprint, existingFingerprint: projected.existingFingerprint } : {},
            }, { isCurrent, supportsRememberHostKey: false, cancel: async () => cancelled() });
            if (answer === undefined) return cancelled();
            return answer;
        } finally { input.onPrompt?.(null); }
    };
    return await runManagedMachineEnrollment({ ...input, reviewedChild: input.context.hostReviewedChild }, {
        ...deps,
        installNativePayload: deps.installNativePayload ?? (installation => installManagedGuestCliViaRemoteDownload({
            homeUrl: installation.homeUrl, channel: installation.channel, os: installation.os, arch: installation.arch,
            remoteHomeDir: installation.remoteHomeDir, signal: installation.signal, fetchImpl: runtimeFetch,
            runRemoteText: command => installation.exec({ command, signal: installation.signal }),
        })),
        ...(deps.readBootstrapCredential ? { runSshTask: createUiManagedAccountSshTask({
            credentials: input.credentials, readBootstrapCredential: deps.readBootstrapCredential,
            onInstalled: input.onInstalled, prompt, signal: input.signal,
        }) } : {}),
        createPromptId: randomUUID,
        approveLocalAuthRequest: request => approveNativeLocalAuthRequest({ ...request, credentials: input.credentials }),
        runTask: async kind => {
            const result = await kind.run({
                params: {}, signal: input.signal,
                // Task events can contain private authentication or command output.
                // The app publishes only the closed progress shape, never their payload.
                emit: () => input.onProgress?.({ kind: 'indeterminate' }),
                prompt,
            });
            if (!result || typeof result !== 'object' || Array.isArray(result)
                || !('machineId' in result) || typeof result.machineId !== 'string' || !result.machineId) {
                throw new SystemTaskExecutionError('managed_response_invalid', 'Managed installation did not return its enrolled Machine.');
            }
            return { machineId: result.machineId };
        },
    });
}
