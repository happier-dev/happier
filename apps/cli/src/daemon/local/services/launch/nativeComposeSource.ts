import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readProjectDefinitionFileBytes } from '@/workspaces/projectSetup/nativeDefinitionFiles';

/** Keep the file boundary's cause through native preparation and child transport. */
export async function readNativeComposeSourceBytes(root: string, path: string): Promise<Buffer> {
    const read = await readProjectDefinitionFileBytes(root, path);
    if (read.kind === 'read') return read.bytes;
    const reason = read.kind === 'absent' ? 'absent' : read.code;
    const error = `The selected Compose file "${path}" ${read.kind === 'absent' ? 'is missing from' : 'cannot be read within'} the selected revision. Open Environment Settings and set the Compose path relative to the repository root, then review the deployment again.`;
    const failure = {
        ok: false, errorCode: 'deployment_source_unavailable', error,
        details: { kind: 'deploymentSourceFileUnavailable', path, reason },
        failureCause: { phase: `deployment.source.compose_file.${reason}`, errorClass: 'Error',
            errorCode: read.kind === 'absent' ? 'ENOENT' : read.code, httpStatus: null },
    } satisfies ActionExecuteFailure;
    throw new PluginError({ code: failure.errorCode, message: error, details: failure.details,
        failureCause: failure.failureCause }, { cause: failure });
}
