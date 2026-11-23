import { stripVTControlCharacters } from 'node:util';
import { redactBugReportSensitiveText, trimBugReportTextToMaxBytes } from '@happier-dev/protocol/bugs/reports/redaction';
import type { ActionExecuteFailure, ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentFailureRecoveryV1, type DeploymentNativeComposeFailureV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';

export const NATIVE_COMPOSE_REGISTRY_INSPECT_PHASE = 'deployment.native.image.registry';

/** Docker reports its attempted socket. Publish only a closed cause and the shared recovery. */
export function readNativeDockerSocketAccessFailure(
    stderr: string,
    errorCode: 'native_failed' | 'native_tool_unavailable',
    phase: string,
    effectAttempted?: true,
): (ActionExecuteFailure & Readonly<{ details: { requiredFact: string; remedy: string } }>) | undefined {
    const denied = /permission denied while trying to connect to the docker (?:API|daemon socket)\b(?: at ([^\s]+))?/iu.exec(stderr);
    if (!denied) return undefined;
    const failureCause: ActionFailureCauseV1 = { phase, errorClass: 'Error', errorCode: 'deployment_docker_socket_access_denied',
        nativeErrorCode: 'EACCES', httpStatus: null };
    const { requiredFact, remedy } = projectDeploymentFailureRecoveryV1({
        failureCause, dockerEndpoint: denied[1]?.replace(/:$/u, ''),
    }, errorCode);
    return { ok: false, errorCode, error: errorCode, failureCause, details: { requiredFact, remedy },
        ...(effectAttempted ? { effectAttempted } : {}) };
}

/** Args contain the admitted Docker invocation, without the executable prefix. */
export function readNativeComposeCommandFailure(args: readonly string[], exitStatus: number,
    stderr: string, redact?: (value: string) => string): DeploymentNativeComposeFailureV1 | undefined {
    if (args[0] !== 'compose') return undefined;
    // Our Compose global options precede the subcommand and each takes one argv element.
    let index = 1;
    while (args[index]?.startsWith('--')) index += 2;
    const subcommand = args[index];
    if (!subcommand || !/^[a-z][a-z-]*$/u.test(subcommand)) return undefined;
    const stderrTail = redact
        ? trimBugReportTextToMaxBytes(redactBugReportSensitiveText(redact(stripVTControlCharacters(stderr)).trim()), 8_192)
        : '';
    return { subcommand, exitStatus, ...(stderrTail ? { stderrTail } : {}) };
}

/** Failure classification uses private process output. Only the masked excerpt can leave the process. */
const nativeFailurePatterns = [
    ['build_platform_unsupported', /no support for running processes with [^\r\n]+ platform,\s*supported:/iu],
    ['deployment_execution_format_error', /exec format error/iu],
    ['deployment_disk_full', /no space left on device/iu],
    // Exit 137 and "Killed" alone also describe cancellation, not proven memory exhaustion.
    ['deployment_out_of_memory', /JavaScript heap out of memory|Cannot allocate memory|\bENOMEM\b|\bOOMKilled\b/iu],
    ['deployment_lockfile_mismatch', /ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile[^\r\n]*out of date|package\.json and package-lock\.json[^\r\n]*in sync|npm ci[^\r\n]*can only install with an existing package-lock/iu],
    ['deployment_env_var_missing', /required variable [^\r\n]+ is missing a value|variable [^\r\n]+ is not set[^\r\n]*required/iu],
    ['deployment_health_check_failed', /container [^\r\n]+ is unhealthy|dependency failed to start[^\r\n]*unhealthy/iu],
    ['deployment_port_in_use', /port is already allocated|address already in use|\bEADDRINUSE\b/iu],
    ['deployment_image_rate_limited', /toomanyrequests|You have reached your (?:unauthenticated )?pull rate limit/iu],
    ['deployment_image_pull_denied', /pull access denied|repository does not exist or may require|unauthorized: authentication required/iu],
    ['deployment_image_not_found', /manifest unknown|manifest for \S+ not found/iu],
    ['deployment_network_address_pool_exhausted', /all predefined address pools have been fully subnetted/iu],
    ['deployment_network_unavailable', /Could not resolve host|Temporary failure in name resolution|getaddrinfo (?:EAI_AGAIN|ENOTFOUND)|Network is unreachable|TLS handshake timeout/iu],
    ['deployment_build_script_missing', /Missing script: ["']?build["']?/iu],
    ['deployment_build_input_missing', /COPY failed:[^\r\n]*(?:not found|no source files)|failed to calculate checksum of ref[^\r\n]*not found/iu],
] as const;

export type NativeComposeFailureCode = (typeof nativeFailurePatterns)[number][0];

/** Called once per failed process; successful commands need no output diagnosis. */
export function classifyNativeComposeFailure(output: string, registryReference?: string): NativeComposeFailureCode | null {
    const classified = nativeFailurePatterns.find(([, pattern]) => pattern.test(output))?.[0];
    if (classified) return classified;
    return registryReference && output.split(/\r?\n/u).some(line => line.trim() === `ERROR: ${registryReference}: not found`)
        ? 'deployment_image_not_found' : null;
}
