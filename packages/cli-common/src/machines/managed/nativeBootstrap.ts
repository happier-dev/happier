import type { ManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedNativeBootstrapIO } from '../../systemTasks/kinds/managedMachineEnrollment.js';
import type { ManagedNativeInvocation } from './reconcile.js';
import { ManagedMachineControllerError } from './controllerErrors.js';
import { MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { encodeBase64, decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SystemTaskExecutionError } from '../../systemTasks/runSystemTask.js';

/** Adapt the provider's native byte/exec roles to the one shared enrollment recipe. */
export function createManagedNativeBootstrapIO(correlation: ManagedEnrollmentCorrelationV1, invoke: ManagedNativeInvocation): ManagedNativeBootstrapIO {
    return {
        exec: async request => {
            const result = MachineProvisionerNativeExecResultV1Schema.parse(await invoke('exec', {
                resource: correlation.resource.value, argv: ['sh', '-c', request.command],
                ...(request.input === undefined ? {} : { inputBase64: encodeBase64(new TextEncoder().encode(request.input)) }),
                ...(request.processConfig ? { processConfig: request.processConfig } : {}),
            }, request));
            if ('kind' in result) {
                if (!request.processConfig) throw new SystemTaskExecutionError('provider_unavailable',
                    'Native guest command failed (process configured without completion).');
                return { status: 0, stdout: '', stderr: '' };
            }
            if (request.processConfig) throw new ManagedMachineControllerError('native_boot_unconfirmed');
            if (result.termination.requestedBy.kind !== 'none' || result.termination.observed.kind !== 'exit'
                || result.stdoutTruncated || result.stderrTruncated) {
                const { requestedBy, observed } = result.termination;
                const facts = [`requested ${requestedBy.kind}`, `observed ${observed.kind}`,
                    ...(observed.kind === 'exit' ? [`exit ${observed.exitCode}`] : []),
                    `stdout truncated ${result.stdoutTruncated}`, `stderr truncated ${result.stderrTruncated}`];
                if (requestedBy.kind === 'dispose' && requestedBy.reason) facts.push(`dispose reason ${requestedBy.reason}`);
                if (observed.kind === 'failed') {
                    const code = readUnexpectedActionErrorDiagnosticV1({ code: observed.diagnostic.code }).errorCode;
                    if (code !== null) facts.push(`code ${code}`);
                }
                throw new SystemTaskExecutionError('provider_unavailable', `Native guest command failed (${facts.join('; ')}).`);
            }
            return { status: result.termination.observed.exitCode,
                stdout: new TextDecoder('utf-8', { ignoreBOM: true }).decode(decodeBase64(result.stdoutBase64)),
                stderr: new TextDecoder('utf-8', { ignoreBOM: true }).decode(decodeBase64(result.stderrBase64)) };
        },
        putFile: async request => {
            const result = MachineProvisionerPutFileResultV1Schema.parse(await invoke('putFile', {
                resource: correlation.resource.value, guestPath: request.path, bytesBase64: encodeBase64(request.bytes),
            }, request));
            if (result.kind !== 'confirmed') throw new ManagedMachineControllerError(result.code ?? 'provider_unavailable', undefined,
                result.nativeCause ? { kind: 'managedNative', nativeCause: result.nativeCause } : undefined);
        },
    };
}
