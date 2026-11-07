import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';

/** Only the generation's original lease proves masking of its delivered values.
 * Reopening current grants cannot recover that proof after custody is lost. */
export function assertServiceOutputRedactionForHost(launch: HostAuthorizedPluginExecLaunch): void {
    if (!launch.secretRedactionLease?.isActive()) throw new PluginError({
        code: 'secret_redaction_redeploy_required',
        message: 'Redeploy the Environment to refresh secret masking before opening a shell or running a service command',
        retryable: false,
    });
}
