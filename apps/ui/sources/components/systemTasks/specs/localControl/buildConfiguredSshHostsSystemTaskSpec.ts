import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';

/** Both pre-sign-in suggestions and Account Actions invoke the existing desktop discovery task. */
export function buildConfiguredSshHostsSystemTaskSpec(): SystemTaskSpec {
    return { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, kind: 'local.ssh.discoverConfiguredHosts.v1', params: {} };
}
