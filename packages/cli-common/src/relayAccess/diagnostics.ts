import { RelayAccessDeadlineExceededError } from './deadline.js';
import type { RelayAccessDiagnosticCodeV1, RelayAccessDiagnosticV1, RelayAccessProviderId } from './types.js';

const MAX_DEVELOPER_MESSAGE_LENGTH = 500;

function truncateDiagnosticText(value: string): string {
    if (value.length <= MAX_DEVELOPER_MESSAGE_LENGTH) return value;
    return `${value.slice(0, MAX_DEVELOPER_MESSAGE_LENGTH)}...`;
}

export function sanitizeRelayAccessDiagnosticText(input: unknown): string {
    const raw = input instanceof Error && input.message.trim()
        ? input.message
        : String(input ?? '');
    const sanitized = raw
        .replace(/\/Users\/[^\s'")]+/g, '[path]')
        .replace(/\b(token|auth|key|secret|password)=([^\s'")]+)/gi, '$1=[redacted]')
        .replace(/https:\/\/login\.tailscale\.com\/[^\s'")]+/gi, 'https://login.tailscale.com/[redacted]')
        .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
        .trim();
    return truncateDiagnosticText(sanitized);
}

export function classifyRelayAccessDiagnosticCode(error: unknown): RelayAccessDiagnosticCodeV1 {
    if (error instanceof RelayAccessDeadlineExceededError) {
        return 'provider_command_timeout';
    }
    if (error instanceof SyntaxError) {
        return 'invalid_provider_output';
    }

    const message = sanitizeRelayAccessDiagnosticText(error).toLowerCase();
    if (/(cli not found|not found|enoent|cannot find)/i.test(message)) {
        return 'provider_not_installed';
    }
    if (/(timeout|timed out|deadline)/i.test(message)) {
        return 'provider_command_timeout';
    }
    if (/(not logged in|need login|needslogin|authentication required)/i.test(message)) {
        return 'provider_not_authenticated';
    }
    if (/(invalid json|unexpected token|parse)/i.test(message)) {
        return 'invalid_provider_output';
    }
    return 'provider_command_failed';
}

function defaultMessageForCode(code: RelayAccessDiagnosticCodeV1): string {
    switch (code) {
        case 'provider_not_installed':
            return 'Provider CLI is not installed.';
        case 'provider_not_authenticated':
            return 'Provider authentication is required.';
        case 'provider_disabled':
            return 'Provider is disabled.';
        case 'provider_command_timeout':
            return 'Provider command timed out.';
        case 'provider_unreachable':
            return 'Provider is unreachable.';
        case 'invalid_provider_output':
            return 'Provider returned invalid status output.';
        case 'unknown':
            return 'Provider status is unknown.';
        case 'provider_command_failed':
        default:
            return 'Provider command failed.';
    }
}

export function createRelayAccessDiagnostic(params: Readonly<{
    providerId: RelayAccessProviderId;
    phase: string;
    error: unknown;
    code?: RelayAccessDiagnosticCodeV1;
}>): RelayAccessDiagnosticV1 {
    const code = params.code ?? classifyRelayAccessDiagnosticCode(params.error);
    const developerMessage = sanitizeRelayAccessDiagnosticText(params.error);
    return {
        code,
        providerId: params.providerId,
        phase: params.phase,
        message: defaultMessageForCode(code),
        ...(developerMessage ? { developerMessage } : {}),
    };
}

