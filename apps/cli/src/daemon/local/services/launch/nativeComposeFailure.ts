import { stripVTControlCharacters } from 'node:util';
import { redactBugReportSensitiveText, trimBugReportTextToMaxBytes } from '@happier-dev/protocol/bugs/reports/redaction';
import type { ActionExecuteFailure, ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentFailureRecoveryV1, type DeploymentNativeComposeFailureV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';

import { MAX_BUFFERED_PLUGIN_PROCESS_OUTPUT_BYTES } from '@/plugins/runtime/exec/processSupervisor';

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
    // The version probe has no deployment inputs, so it can use the normal diagnostic redactor alone.
    const output = redact || args[1] === 'version' ? stripVTControlCharacters(stderr) : '';
    const stderrTail = trimBugReportTextToMaxBytes(redactBugReportSensitiveText(redact?.(output) ?? output).trim(),
        MAX_BUFFERED_PLUGIN_PROCESS_OUTPUT_BYTES);
    return { subcommand, exitStatus, ...(stderrTail ? { stderrTail } : {}) };
}

/** Failure classification uses private process output. Only the masked excerpt can leave the process. */
const nativeFailurePatterns = [
    ['build_platform_unsupported', /no support for running processes with [^\r\n]+ platform,\s*supported:/iu],
    ['deployment_docker_daemon_unavailable', /Cannot connect to the Docker daemon\b/iu],
    ['deployment_execution_format_error', /exec format error/iu],
    ['deployment_disk_full', /no space left on device/iu],
    // Exit 137 and "Killed" alone also describe cancellation, not proven memory exhaustion.
    ['deployment_out_of_memory', /JavaScript heap out of memory|Cannot allocate memory|\bENOMEM\b|\bOOMKilled\b/iu],
    ['deployment_lockfile_mismatch', /ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile[^\r\n]*out of date|package\.json and package-lock\.json[^\r\n]*in sync|npm ci[^\r\n]*can only install with an existing package-lock/iu],
    ['deployment_env_var_missing', /required variable [^\r\n]+ is missing a value|variable [^\r\n]+ is not set[^\r\n]*required/iu],
    ['deployment_health_check_failed', /container [^\r\n]+ is unhealthy|dependency failed to start[^\r\n]*unhealthy/iu],
    ['deployment_port_in_use', /port is already allocated|address already in use|\bEADDRINUSE\b/iu],
    ['deployment_bind_address_unavailable', /bind(?: \S+)?: cannot assign requested address/iu],
    ['deployment_image_rate_limited', /toomanyrequests|You have reached your (?:unauthenticated )?pull rate limit/iu],
    ['deployment_image_pull_denied', /pull access denied|repository does not exist or may require|unauthorized: authentication required|failed to fetch oauth token:[^\r\n]*\b401 Unauthorized\b/iu],
    ['deployment_image_not_found', /manifest unknown|manifest for \S+ not found/iu],
    ['deployment_network_address_pool_exhausted', /all predefined address pools have been fully subnetted/iu],
    ['deployment_network_unavailable', /Could not resolve host|Temporary failure in name resolution|getaddrinfo (?:EAI_AGAIN|ENOTFOUND)|Network is unreachable|TLS handshake timeout/iu],
    ['deployment_build_script_missing', /Missing script: ["']?build["']?/iu],
    ['deployment_build_runtime_incompatible', /npm (?:ERR!|error) code EBADENGINE\b/iu],
    ['deployment_build_dependencies_incompatible', /Your lock file does not contain a compatible set of packages\.|ERROR: No matching distribution found for |\bE: Unable to locate package /iu],
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

export function readNativeComposeRegistryHost(reference: string): string {
    const repository = reference.split('@', 1)[0]!;
    const first = repository.split('/', 1)[0]!;
    return repository.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')
        ? first : 'docker.io';
}

export function readNativeComposeRegistryRateLimit(reference: string, output: string): ActionFailureCauseV1 | undefined {
    // Buildx's manifest HEAD may preserve the HTTP status alone.
    const throttledStatus = /\b429 Too Many Requests\b/iu.test(output);
    if (!throttledStatus && classifyNativeComposeFailure(output) !== 'deployment_image_rate_limited') return undefined;
    const registry = readNativeComposeRegistryHost(reference).toLowerCase();
    return {
        phase: `${NATIVE_COMPOSE_REGISTRY_INSPECT_PHASE}.deployment_image_rate_limited`,
        errorClass: 'Error',
        errorCode: 'deployment_image_rate_limited',
        httpStatus: throttledStatus ? 429 : null,
        ...(['docker.io', 'index.docker.io', 'registry-1.docker.io'].includes(registry) ? { nativeErrorReason: 'docker_hub' } : {}),
    };
}
