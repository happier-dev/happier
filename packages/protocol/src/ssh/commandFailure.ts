import type { ManagedBootstrapFailureDetailsV1 } from '../actions/operations/v1.js';
import { formatHomeAuthorityMismatchFacts, readHomeAuthorityMismatchFacts, splitHomeAuthorityMismatchSuffix,
    type HomeAuthorityMismatchFacts, type HomeAuthorityMismatchFailureDetailsV1 } from './homeAuthorityMismatch.js';
export { formatHomeAuthorityMismatchFacts, formatHomeAuthorityMismatchFailure, readHomeAuthorityMismatchFacts,
    readHomeAuthorityMismatchFailure, type HomeAuthorityMismatchFacts } from './homeAuthorityMismatch.js';

/** Closed, content-free SSH failures shared by the host and Action settlement. */
export const SSH_COMMAND_FAILURE_MESSAGES = {
    ssh_password_expired: 'The SSH login account requires a password change.',
    ssh_host_key_changed: 'The SSH host key could not be verified.',
    ssh_host_key_unverified: 'The SSH host key could not be verified.',
    ssh_command_failed: 'The SSH command failed.',
    ssh_invalid_response: 'The SSH command returned an invalid response.',
} as const;

export type SshCommandFailureCode = keyof typeof SSH_COMMAND_FAILURE_MESSAGES;

// Presentation vocabulary only; these labels cannot select or execute a command.
const phases = ['ssh.command', 'preflight.platform', 'server.configure', 'auth.status', 'daemon.status',
    'daemon.service.list', 'daemon.service.install', 'daemon.service.uninstallAll', 'daemon.service.start',
    'daemon.service.stop', 'daemon.service.restart', 'relay.runtime.install', 'relay.host.uninstall'] as const;
export type SshCommandFailurePhase = typeof phases[number];
const launchctlReasons = ['launchctl_io_error', 'launchctl_domain_unsupported', 'launchctl_service_missing'] as const;
export type SshCommandFailureReason = typeof launchctlReasons[number];
type ProcessFacts = Partial<Pick<ManagedBootstrapFailureDetailsV1, 'exitStatus' | 'stdoutPresent' | 'stderrPresent'>>;

// Identifiers are admitted from known CLI producers, never arbitrary JSON code fields.
const serviceCodes = ['service_manager_unavailable', 'service_command_failed', 'service_start_timeout',
    'service_ownership_failed', 'service_preflight_failed', 'service_invalid_arguments',
    'not_installed', 'owner_conflict', 'daemon_service_conflict', 'service_inventory_unavailable', 'foreign_home_service',
    'not_supported', 'tail_not_found', 'tail_failed', 'invalid_subcommand'] as const;
const authCodes = ['AUTH_ENROLL_REMOTE_FAILED', 'AUTH_ENROLL_REMOTE_CANCELLED', 'AUTH_ENROLL_REMOTE_TIMEOUT',
    'AUTH_ENROLL_REMOTE_REQUEST_EXPIRED', 'AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE', 'AUTH_ENROLL_REMOTE_IDENTITY_MISMATCH',
    'AUTH_ENROLL_REMOTE_INVALID_RESPONSE', 'AUTH_ENROLL_REMOTE_PAIRING_REQUIRED',
    'AUTH_REQUEST_FAILED', 'AUTH_WAIT_HOME_UNAVAILABLE', 'AUTH_WAIT_FAILED', 'AUTH_WAIT_INVALID_ARGUMENT',
    'AUTH_WAIT_INVALID_STATE', 'AUTH_WAIT_TRANSPORT_UNAVAILABLE', 'AUTH_REQUEST_EXPIRED', 'AUTH_RESPONSE_HOME_MISMATCH',
    'AUTH_RESPONSE_INVALID', 'AUTH_PAIRING_V3_REQUIRED', 'AUTH_WAIT_PROCESS_FAILED',
    'HOME_FEATURES_UNREADABLE', 'HOME_FEATURES_NETWORK', 'HOME_FEATURES_TIMEOUT', 'HOME_FEATURES_HTTP_ERROR',
    'HOME_FEATURES_ENDPOINT_MISSING', 'HOME_IDENTITY_MISSING', 'HOME_CREDENTIAL_DESTINATION_UNVERIFIED',
    'HOME_AUTHORITY_MISMATCH', 'HOME_LEGACY_ORIGIN_MISMATCH', 'HOME_RUNTIME_ORIGIN_INVALID',
    'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE', 'ERR_NETWORK', 'ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT',
    'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_REQUIRE_ESM', 'ERR_DLOPEN_FAILED', 'ENOENT', 'EACCES', 'EPERM'] as const;
const serviceSteps = ['preflight', 'cleanup_bootout', 'bootstrap', 'kickstart', 'wait', 'command'] as const;
const serviceStatuses = ['failed', 'deadline_elapsed', 'unavailable'] as const;
const serviceReasons = [...launchctlReasons, 'deadline_elapsed', 'owner_conflict', 'owner_not_service_managed',
    'owner_service_label_mismatch', 'launcher_action_mismatch', 'systemd_failed', 'systemd_auto_restart_failed',
    'launchd_unloaded', 'launchd_exited', 'scheduled_task_missing', 'scheduled_task_exited'] as const;
const authCategories = ['http_error', 'auth_error', 'cancelled', 'deadline_elapsed', 'unknown'] as const;
const elapsedBuckets = ['under_1s', 'under_10s', 'under_60s', 'under_600s', 'at_least_600s'] as const;
const controllerAbortCategories = ['none', 'caller_abort', 'enrollment_deadline', 'pairing_deadline'] as const;

// Presentation-only projection of acquisition failures; these facts grant no routing authority.
const enrollmentCarriers = ['iroh', 'none'] as const;
const enrollmentCarrierReasons = ['unavailable', 'invalid_descriptor', 'invalid_preference', 'endpoint_identity_invalid',
    'identity_mismatch', 'endpoint_key_unavailable', 'relay_auth_failed', 'invalid_preamble', 'unsupported_alpn',
    'endpoint_config_conflict', 'loopback_bind_failed', 'home_unreachable', 'transport_timeout', 'transport_closed',
    'resource_limit', 'cancelled', 'transport', 'unknown'] as const;
export type HomeEnrollmentCarrierFailure = Readonly<{
    attemptedCarrier: typeof enrollmentCarriers[number];
    reason: typeof enrollmentCarrierReasons[number];
}>;

/** Unknown values withdraw this optional diagnostic leaf; extra private fields are dropped. */
export function readHomeEnrollmentCarrierFailure(value: unknown): HomeEnrollmentCarrierFailure | undefined {
    const input = record(value);
    const attemptedCarrier = member(enrollmentCarriers, input?.attemptedCarrier);
    const reason = member(enrollmentCarrierReasons, input?.reason);
    return attemptedCarrier && reason ? { attemptedCarrier, reason } : undefined;
}

function member<T extends string>(values: readonly T[], value: unknown): T | undefined {
    return values.find(item => item === value);
}
function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function readGuestAuthErrorCode(value: unknown): typeof authCodes[number] | undefined {
    return member(authCodes, value);
}
export function readGuestServiceErrorCode(value: unknown): typeof serviceCodes[number] | undefined {
    return member(serviceCodes, value);
}
export type GuestCliFailureFacts = Readonly<{
    guestCliCode?: typeof serviceCodes[number] | typeof authCodes[number];
    serviceStep?: typeof serviceSteps[number];
    serviceStepStatus?: typeof serviceStatuses[number];
    serviceReason?: typeof serviceReasons[number];
    guestAuthCategory?: typeof authCategories[number];
    carrierFailure?: HomeEnrollmentCarrierFailure;
    homeAuthority?: HomeAuthorityMismatchFacts;
}>;

/** Only declared CLI error envelopes qualify. Extra payload fields are dropped. */
export function readGuestCliFailure(value: unknown): GuestCliFailureFacts | null {
    const envelope = record(value);
    if (!envelope || envelope.ok !== false) return null;
    const serviceCode = member(serviceCodes, envelope.error);
    if (serviceCode) {
        const step = member(serviceSteps, envelope.serviceStep);
        const status = member(serviceStatuses, envelope.serviceStepStatus);
        const reason = member(serviceReasons, envelope.reason);
        return { guestCliCode: serviceCode, ...(step && status ? { serviceStep: step, serviceStepStatus: status,
            ...(reason ? { serviceReason: reason } : {}) } : {}) };
    }
    const error = record(envelope.error);
    if (envelope.v !== 1 || !['auth_enroll_remote', 'auth_request', 'auth_wait'].includes(String(envelope.kind)) || !error) return null;
    const carrierFailure = envelope.kind === 'auth_enroll_remote' && error.code === 'AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE'
        ? readHomeEnrollmentCarrierFailure(error.carrierFailure) : undefined;
    const homeAuthority = error.code === 'HOME_AUTHORITY_MISMATCH' ? readHomeAuthorityMismatchFacts(error) : undefined;
    return { guestCliCode: readGuestAuthErrorCode(error.code), guestAuthCategory: member(authCategories, error.category) ?? 'unknown',
        ...(homeAuthority ? { homeAuthority } : {}),
        ...(carrierFailure ? { carrierFailure } : {}) };
}

/** Each stream is one JSON document; prose, nested code bags and fragments cannot qualify. */
export function readGuestCliFailureOutput(stdout: string, stderr: string): GuestCliFailureFacts | null {
    for (const output of [stdout, stderr]) {
        try {
            const facts = readGuestCliFailure(JSON.parse(output));
            if (facts) return facts;
        } catch { /* Older CLIs can emit prose; it remains presence-only. */ }
    }
    return null;
}

export type RemoteEnrollmentFailureFacts = Readonly<{
    elapsedBucket: typeof elapsedBuckets[number];
    requestEventSeen: boolean;
    finalResultEventSeen: boolean;
    guestCliCode?: typeof authCodes[number];
    guestAuthCategory: typeof authCategories[number];
    controllerAbortCategory: typeof controllerAbortCategories[number];
    carrierFailure?: HomeEnrollmentCarrierFailure;
    homeAuthority?: HomeAuthorityMismatchFacts;
}>;

/** Buckets discriminate the guest's ten-minute auth wait, not a new time budget. */
export function remoteEnrollmentElapsedBucket(elapsedMs: number): RemoteEnrollmentFailureFacts['elapsedBucket'] {
    return elapsedMs < 1_000 ? 'under_1s' : elapsedMs < 10_000 ? 'under_10s' : elapsedMs < 60_000 ? 'under_60s'
        : elapsedMs < 600_000 ? 'under_600s' : 'at_least_600s';
}

function serviceSuffix(facts: GuestCliFailureFacts): string {
    return `${facts.guestCliCode ? `; guestCliCode ${facts.guestCliCode}` : ''}${facts.serviceStep && facts.serviceStepStatus
        ? `; serviceStep ${facts.serviceStep}; serviceStepStatus ${facts.serviceStepStatus}${facts.serviceReason ? `; serviceReason ${facts.serviceReason}` : ''}` : ''}`;
}

export function formatSshCommandFailure(code: SshCommandFailureCode,
    facts?: ProcessFacts & GuestCliFailureFacts & Readonly<{ phase?: SshCommandFailurePhase; reason?: SshCommandFailureReason }>): string {
    const message = SSH_COMMAND_FAILURE_MESSAGES[code];
    return facts ? `${message} (phase ${facts.phase ?? 'ssh.command'}; exitStatus ${facts.exitStatus ?? 'unknown'}; stdoutPresent ${facts.stdoutPresent ?? 'unknown'}; stderrPresent ${facts.stderrPresent ?? 'unknown'}${facts.reason ? `; reason ${facts.reason}` : ''}${serviceSuffix(facts)})` : message;
}

/** An older/plain message stays valid. Untrusted prose never survives normalization. */
export function readSshCommandFailure(code: unknown, message?: unknown): Readonly<{ code: SshCommandFailureCode; message: string }> | null {
    if (typeof code !== 'string' || !Object.hasOwn(SSH_COMMAND_FAILURE_MESSAGES, code)) return null;
    const known = code as SshCommandFailureCode;
    const base = SSH_COMMAND_FAILURE_MESSAGES[known];
    const suffix = typeof message === 'string' && message.startsWith(base) ? message.slice(base.length) : '';
    const match = /^ \(phase ([a-zA-Z.]+); exitStatus (-?\d+|unknown); stdoutPresent (true|false|unknown); stderrPresent (true|false|unknown)(?:; reason ([a-z_]+))?(?:; guestCliCode ([A-Za-z][A-Za-z0-9_.-]{1,63})(?:; serviceStep ([a-z_]+); serviceStepStatus ([a-z_]+)(?:; serviceReason ([a-z_]+))?)?)?\)$/u.exec(suffix);
    const phase = match && phases.find(phase => phase === match[1]);
    const exitStatus = match?.[2] === 'unknown' ? undefined : match ? Number(match[2]) : NaN;
    const reason = launchctlReasons.find(reason => reason === match?.[5]);
    const guestCliCode = member(serviceCodes, match?.[6]);
    const serviceStep = member(serviceSteps, match?.[7]);
    const serviceStepStatus = member(serviceStatuses, match?.[8]);
    const serviceReason = member(serviceReasons, match?.[9]);
    if (!match || !phase || exitStatus !== undefined && !Number.isSafeInteger(exitStatus)
        || match[5] && (!reason || known !== 'ssh_command_failed' || !phase.startsWith('daemon.service.'))
        || match[6] && (!guestCliCode || known !== 'ssh_command_failed' || !phase.startsWith('daemon.service.'))
        || match[7] && (!serviceStep || !serviceStepStatus) || match[9] && !serviceReason) return { code: known, message: base };
    return { code: known, message: formatSshCommandFailure(known, { phase, exitStatus, reason, guestCliCode, serviceStep, serviceStepStatus, serviceReason,
        stdoutPresent: match[3] === 'unknown' ? undefined : match[3] === 'true',
        stderrPresent: match[4] === 'unknown' ? undefined : match[4] === 'true' }) };
}

const REMOTE_ENROLLMENT_FAILURE_MESSAGE = 'Remote Home enrollment failed.';
type RemoteEnrollmentPhase = 'auth.request' | 'auth.wait' | 'auth.enroll-remote';

/** Shell status 128 + 9 is kill-compatible, not evidence of an OOM killer. */
export function formatRemoteEnrollmentCommandFailure(facts: ProcessFacts & Partial<RemoteEnrollmentFailureFacts> & Readonly<{ phase: RemoteEnrollmentPhase }>): string {
    const signal = facts.exitStatus === 137 ? 'SIGKILL-compatible' : 'unknown';
    const diagnostics = facts.elapsedBucket ? `; elapsedBucket ${facts.elapsedBucket}; requestEventSeen ${facts.requestEventSeen}; finalResultEventSeen ${facts.finalResultEventSeen}; guestCliCode ${facts.guestCliCode ?? 'unknown'}; guestAuthCategory ${facts.guestAuthCategory ?? 'unknown'}; controllerAbortCategory ${facts.controllerAbortCategory ?? 'none'}` : '';
    const carrierFailure = facts.elapsedBucket && facts.guestCliCode === 'AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE'
        ? readHomeEnrollmentCarrierFailure(facts.carrierFailure) : undefined;
    const carrier = carrierFailure ? `; attemptedCarrier ${carrierFailure.attemptedCarrier}; carrierReason ${carrierFailure.reason}` : '';
    const homeAuthority = facts.guestCliCode === 'HOME_AUTHORITY_MISMATCH' ? readHomeAuthorityMismatchFacts(facts.homeAuthority) : undefined;
    return `${REMOTE_ENROLLMENT_FAILURE_MESSAGE} (phase ${facts.phase}; exitStatus ${facts.exitStatus ?? 'unknown'}; signal ${signal}; stdoutPresent ${facts.stdoutPresent ?? 'unknown'}; stderrPresent ${facts.stderrPresent ?? 'unknown'}${diagnostics}${carrier}${homeAuthority ? `; ${formatHomeAuthorityMismatchFacts(homeAuthority)}` : ''})`;
}

/** Retain only closed process facts or the active finite auth diagnostic grammar. */
export function readRemoteEnrollmentCommandFailure(code: unknown, message?: unknown): Readonly<{ code: 'remote_command_failed' | 'auth_enrollment_timeout' | 'auth_request_expired' | 'cancelled'; message: string; details?: HomeAuthorityMismatchFailureDetailsV1 }> | null {
    if (code !== 'remote_command_failed' && code !== 'auth_enrollment_timeout' && code !== 'auth_request_expired' && code !== 'cancelled') return null;
    const authority = splitHomeAuthorityMismatchSuffix(message);
    const baseMessage = authority.message;
    const details = authority.facts ? { kind: 'homeAuthorityMismatch' as const, ...authority.facts } : undefined;
    const match = typeof baseMessage === 'string' ? /^Remote Home enrollment failed\. \(phase (auth\.(?:request|wait|enroll-remote)); exitStatus (-?\d+|unknown); signal (SIGKILL-compatible|unknown); stdoutPresent (true|false|unknown); stderrPresent (true|false|unknown)(?:; elapsedBucket ([a-z_0-9]+); requestEventSeen (true|false); finalResultEventSeen (true|false); guestCliCode ([A-Za-z][A-Za-z0-9_.-]{1,63}); guestAuthCategory ([a-z_]+); controllerAbortCategory ([a-z_]+)(?:; attemptedCarrier ([a-z_]+); carrierReason ([a-z_]+))?)?\)$/u.exec(baseMessage) : null;
    const exitStatus = match?.[2] === 'unknown' ? undefined : match ? Number(match[2]) : NaN;
    const elapsedBucket = member(elapsedBuckets, match?.[6]);
    const guestCliCode = readGuestAuthErrorCode(match?.[9]);
    const guestAuthCategory = member(authCategories, match?.[10]);
    const controllerAbortCategory = member(controllerAbortCategories, match?.[11]);
    const carrierFailure = readHomeEnrollmentCarrierFailure({ attemptedCarrier: match?.[12], reason: match?.[13] });
    if (match && (exitStatus === undefined || Number.isSafeInteger(exitStatus))
        && (!match[6] || elapsedBucket && (guestCliCode || match[9] === 'unknown') && guestAuthCategory && controllerAbortCategory)
        && (!match[12] || carrierFailure && guestCliCode === 'AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE')) {
        const formatted = formatRemoteEnrollmentCommandFailure({ phase: match[1] as RemoteEnrollmentPhase, exitStatus,
            stdoutPresent: match[4] === 'unknown' ? undefined : match[4] === 'true', stderrPresent: match[5] === 'unknown' ? undefined : match[5] === 'true',
            ...(elapsedBucket ? { elapsedBucket, requestEventSeen: match[7] === 'true', finalResultEventSeen: match[8] === 'true',
                guestCliCode, guestAuthCategory, controllerAbortCategory, ...(carrierFailure ? { carrierFailure } : {}),
                ...(authority.facts ? { homeAuthority: authority.facts } : {}) } : {}) });
        if (formatted === message) return { code, message: formatted, ...(details ? { details } : {}) };
    }
    // Buffered native request/wait already projects these identifier-only fields.
    // Keep that live producer's Home error codes without accepting native prose.
    const buffered = typeof baseMessage === 'string' && /^Remote Home enrollment failed during auth (request|wait) \(exit (-?\d+)(?:; code ([A-Za-z][A-Za-z0-9_.-]{1,63}))?(?:; diagnostic (?:absent|invalid)(?:; check (?:parse|v|ok|kind|code))?)?(?:; category (?:http_error|auth_error))?(?:; HTTP [1-5]\d{2})?(?:; server code (?:database_transaction_conflict_exhausted|database_transaction_timeout|database_connection_unavailable))?\)\.$/u.exec(baseMessage);
    if (code === 'remote_command_failed' && buffered && Number.isSafeInteger(Number(buffered[2]))
        && (!buffered[3] || readGuestAuthErrorCode(buffered[3]))
        && (!details || buffered[3] === 'HOME_AUTHORITY_MISMATCH')) return { code, message: String(message), ...(details ? { details } : {}) };
    if (code === 'cancelled') return null;
    return { code, message: code === 'auth_enrollment_timeout' ? 'Remote Home enrollment timed out. Retry setup to request fresh approval.'
        : code === 'auth_request_expired' ? 'Remote machine pairing approval expired. Retry setup to request fresh approval.' : 'Remote command failed.' };
}
