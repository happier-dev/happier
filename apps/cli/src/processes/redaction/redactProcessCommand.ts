import { parseHappierLinuxScopeName } from '@/daemon/platform/linux/systemdUserResourceGovernor';
import { parseWindowsJobCustodyOwnerTag } from '@/subprocess/supervision/processCustody';

// A shell word may join quoted/unquoted fragments or contain escaped whitespace.
const SECRET_VALUE_SOURCE = String.raw`(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'[^']*(?:'|$)|\\[\s\S]|[^\s"'\\])*`;
const SECRET_FLAG_PATTERN = new RegExp(String.raw`((?:--?|\/)(?:api[-_]?key|auth|bearer|password|passwd|pwd|secret|token)(?:=|\s+))(${SECRET_VALUE_SOURCE})`, 'gi');
const SECRET_ENV_NAME_SOURCE = '(?=[A-Za-z_])[A-Za-z0-9_]*(?:api[-_]?key|auth|bearer|password|passwd|pwd|secret|token)[A-Za-z0-9_]*';
const QUOTED_SECRET_ENV_ASSIGNMENT_PATTERN = new RegExp(String.raw`(^|\s)(?:"(${SECRET_ENV_NAME_SOURCE})=(?:\\[\s\S]|[^"\\])*(?:"|$)|'(${SECRET_ENV_NAME_SOURCE})=[^']*(?:'|$))`, 'gi');
const SECRET_ENV_ASSIGNMENT_PATTERN = new RegExp(`((?:^|[\\s{,])${SECRET_ENV_NAME_SOURCE}=)(${SECRET_VALUE_SOURCE})`, 'gi');
const URL_USERINFO_PATTERN = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s\/?#"'<>]*@/gu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PROVIDER_KEY_PATTERN = /\b(?:sk|pk|rk|ghp|github_pat|glpat|xox[baprs])[-_][A-Za-z0-9._-]{8,}\b/g;
const AWS_ACCESS_KEY_ID_PATTERN = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const GOOGLE_API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{30,}\b/g;
const PREFIXED_PROVIDER_TOKEN_PATTERN = /\b(?:hf|npm)_[A-Za-z0-9]{16,}\b/g;
const SECRET_ARGUMENT_NAME = /^(?:--?|\/)(?:api[-_]?key|auth|bearer|password|passwd|pwd|secret|token)$/iu;
const SECRET_ENV_ARGUMENT_NAME = new RegExp(`^${SECRET_ENV_NAME_SOURCE}$`, 'iu');

function redactText(command: string): string {
    return command
        .replace(/(--(?:unit|job)(?:=|\s+))("[^"\n]*"|'[^'\n]*'|[^\s]+)/gu, (match, prefix: string, value: string) => {
            const unquoted = /^["']/u.test(value) ? value.slice(1, -1) : value;
            return isPrivateContainer(unquoted) ? `${prefix}[REDACTED]` : match;
        })
        .replace(/(\bHAPPIER_PROCESS_OWNER=)("[^"\n]*"|'[^'\n]*'|[^\s]+)/gu, (_match, prefix: string) => `${prefix}[REDACTED]`)
        .replace(QUOTED_SECRET_ENV_ASSIGNMENT_PATTERN, (_match, prefix: string, doubleQuotedName: string | undefined, singleQuotedName: string | undefined) =>
            `${prefix}${doubleQuotedName ?? singleQuotedName}=[REDACTED]`)
        .replace(SECRET_ENV_ASSIGNMENT_PATTERN, (_match, prefix: string) => `${prefix}[REDACTED]`)
        .replace(URL_USERINFO_PATTERN, (_match, scheme: string) => `${scheme}[REDACTED]@`)
        .replace(SECRET_FLAG_PATTERN, (_match, prefix: string) => `${prefix}[REDACTED]`)
        .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
        .replace(PROVIDER_KEY_PATTERN, '[REDACTED]')
        .replace(AWS_ACCESS_KEY_ID_PATTERN, '[REDACTED]')
        .replace(GOOGLE_API_KEY_PATTERN, '[REDACTED]')
        .replace(PREFIXED_PROVIDER_TOKEN_PATTERN, '[REDACTED]');
}

function isPrivateContainer(value: string): boolean {
    return parseHappierLinuxScopeName(value) !== null || parseWindowsJobCustodyOwnerTag(value) !== null;
}

/** Preserve argv boundaries for both process presentation and structured diagnostics. */
export function redactProcessArgv(command: readonly string[]): readonly string[] {
    let secretValue = false;
    let containerValue = false;
    return command.map(argument => {
        if (secretValue) { secretValue = false; return '[REDACTED]'; }
        if (containerValue) { containerValue = false; if (isPrivateContainer(argument)) return '[REDACTED]'; }
        const assignmentIndex = argument.indexOf('=');
        if (assignmentIndex >= 0 && /^--(?:unit|job)$/u.test(argument.slice(0, assignmentIndex))
            && isPrivateContainer(argument.slice(assignmentIndex + 1))) return `${argument.slice(0, assignmentIndex + 1)}[REDACTED]`;
        if (assignmentIndex >= 0 && (argument.slice(0, assignmentIndex) === 'HAPPIER_PROCESS_OWNER'
            || SECRET_ARGUMENT_NAME.test(argument.slice(0, assignmentIndex))
            || SECRET_ENV_ARGUMENT_NAME.test(argument.slice(0, assignmentIndex)))) {
            return `${argument.slice(0, assignmentIndex + 1)}[REDACTED]`;
        }
        secretValue = SECRET_ARGUMENT_NAME.test(argument);
        containerValue = argument === '--unit' || argument === '--job';
        return redactText(argument);
    });
}

/** Raw census argv retains argument boundaries; native command strings use the same redactor. */
export function redactProcessCommand(command: string | readonly string[]): string {
    if (typeof command === 'string') return redactText(command);
    return redactProcessArgv(command).map(argument => /\s/u.test(argument) ? JSON.stringify(argument) : argument).join(' ');
}
