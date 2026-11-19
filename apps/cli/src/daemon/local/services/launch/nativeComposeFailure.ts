export const NATIVE_COMPOSE_REGISTRY_INSPECT_PHASE = 'deployment.native.image.registry';

/** Closed observations only: private native output stays at this process boundary. */
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
