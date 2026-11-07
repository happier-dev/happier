import { SystemTaskExecutionError, type ManagedMachineEnrollmentDependencies } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createNativeSshBridge } from '@/components/systemTasks/createNativeSshBridge';
import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import { NATIVE_SSH_BOOTSTRAP_TASK_KIND } from '@/components/systemTasks/bridges/native';
import { runNativeRemoteSshBootstrapTask } from '@/components/systemTasks/remoteSshBootstrap/nativeTask';
import type { SystemTaskPromptContinuation } from '@/components/systemTasks/types';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

/** Invocation-only native transport for the existing shared managed enrollment recipe. */
export function createUiManagedAccountSshTask(input: Readonly<{
    credentials: AuthCredentials;
    readBootstrapCredential(): Promise<string>;
    onInstalled?(): Promise<void>;
    prompt: SystemTaskPromptContinuation;
    signal?: AbortSignal;
}>): NonNullable<ManagedMachineEnrollmentDependencies['runSshTask']> {
    return async task => {
        const privateKey = await input.readBootstrapCredential();
        input.signal?.throwIfAborted();
        const bridge = createNativeSshBridge({
            // This finite invocation has no unrelated RemoteHost or persistent
            // interrupted-task record; Home's managed row owns retry.
            interruptionStore: null, trustedHostKeyStore: null, completedRecordRetentionMs: 0,
            runBootstrapTask: params => runNativeRemoteSshBootstrapTask({ ...params,
                reviewedChild: task.reviewedChild, prepareDedicatedBootstrap: task.prepareDedicatedBootstrap,
                assertManagedEnrollmentCurrent: task.assertCurrent, onEnrollmentDeadline: task.onEnrollmentDeadline,
                onInstalled: input.onInstalled,
                approvalCredentials: input.credentials,
            }),
        });
        const runner = createSystemTaskRunner({ bridge, mode: 'native' });
        const taskId = await runner.start({ protocolVersion: 1, kind: NATIVE_SSH_BOOTSTRAP_TASK_KIND,
            params: projectNativeJsonValueForTransport({ ...task.configuration, remoteHostId: `managed-bootstrap:${task.carrier.user}@${task.carrier.address}`,
                knownHostsMode: 'app', ssh: { target: `${task.carrier.user}@${task.carrier.address}`, auth: 'keyfile',
                    identityPrivateKey: privateKey, ...(task.carrier.port ? { port: task.carrier.port } : {}),
                    ...(task.carrier.hostKeyEvidence ? { hostKeyEvidence: task.carrier.hostKeyEvidence } : {}),
                    ...(task.trustedHostKey ? { trustedHostKey: task.trustedHostKey } : {}),
                } }),
        }, input.prompt);
        let unlisten = () => {};
        const cancel = () => { void runner.cancel(taskId); };
        try {
            return await new Promise<Readonly<{ machineId: string }>>((resolve, reject) => {
                const settle = () => {
                    const result = runner.getSnapshot(taskId)?.result;
                    if (!result) return;
                    if (!result.ok) return reject(new SystemTaskExecutionError(result.error.code, result.error.message));
                    const value = result.data;
                    if (!value || typeof value !== 'object' || Array.isArray(value)
                        || !('machineId' in value) || typeof value.machineId !== 'string') {
                        return reject(new SystemTaskExecutionError('managed_response_invalid', 'Managed installation did not return its enrolled Machine.'));
                    }
                    resolve({ machineId: value.machineId });
                };
                unlisten = runner.subscribe(taskId, settle);
                input.signal?.addEventListener('abort', cancel, { once: true });
                if (input.signal?.aborted) cancel();
                settle();
            });
        } finally {
            unlisten();
            input.signal?.removeEventListener('abort', cancel);
        }
    };
}
