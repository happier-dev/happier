import { parseEnvText } from './selfHostServerEnv.js';

export const PERSONAL_HOME_SIGNUP_POLICY_ENV_KEY = 'AUTH_ANONYMOUS_SIGNUP_ENABLED';
export const PERSONAL_HOME_SIGNUP_CLOSURE_ENV = Object.freeze({
    [PERSONAL_HOME_SIGNUP_POLICY_ENV_KEY]: '0',
} as const);

export type PersonalHomeSignupPolicyState = 'enabled' | 'disabled' | 'unknown';

export class PersonalHomeSignupClosureError extends Error {
    readonly code = 'personal_home_signup_closure_unverified';

    constructor() {
        super('Personal Home signup closure could not be verified. Keep the Home loopback-only until the server policy reads disabled.');
        this.name = 'PersonalHomeSignupClosureError';
    }
}

function resolvePolicyValue(source: string | Readonly<Record<string, unknown>>): unknown {
    if (typeof source === 'string') {
        return parseEnvText(source)[PERSONAL_HOME_SIGNUP_POLICY_ENV_KEY];
    }
    return source[PERSONAL_HOME_SIGNUP_POLICY_ENV_KEY];
}

/**
 * Reads the effective policy without applying the server's permissive default.
 * Missing or malformed values are unknown so exposure callers can fail closed.
 */
export function readEffectivePersonalHomeSignupPolicy(
    source: string | Readonly<Record<string, unknown>>,
): PersonalHomeSignupPolicyState {
    const raw = String(resolvePolicyValue(source) ?? '').trim().toLowerCase();
    if (!raw) return 'unknown';
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'n' || raw === 'off') {
        return 'disabled';
    }
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y' || raw === 'on') {
        return 'enabled';
    }
    return 'unknown';
}

/**
 * Applies the managed Personal Home policy while preserving all unrelated env entries.
 * The returned text is suitable for the existing managed server.env renderer.
 */
export function applyPersonalHomeSignupClosure(existingEnvText: string): string {
    const source = String(existingEnvText ?? '');
    if (!source.trim()) {
        return `${PERSONAL_HOME_SIGNUP_POLICY_ENV_KEY}=${PERSONAL_HOME_SIGNUP_CLOSURE_ENV[PERSONAL_HOME_SIGNUP_POLICY_ENV_KEY]}\n`;
    }
    const lines = source.split('\n');
    const rendered: string[] = [];
    let policyWritten = false;
    for (const line of lines) {
        const trimmed = line.trim();
        const separator = trimmed.indexOf('=');
        const key = separator > 0 ? trimmed.slice(0, separator).trim() : '';
        if (key === PERSONAL_HOME_SIGNUP_POLICY_ENV_KEY) {
            // Keep one authoritative active assignment. Comments are intentionally
            // preserved as operator documentation, but cannot affect readback.
            if (!policyWritten) {
                rendered.push(`${PERSONAL_HOME_SIGNUP_POLICY_ENV_KEY}=${PERSONAL_HOME_SIGNUP_CLOSURE_ENV[PERSONAL_HOME_SIGNUP_POLICY_ENV_KEY]}`);
                policyWritten = true;
            }
            continue;
        }
        rendered.push(line);
    }
    if (!policyWritten) {
        rendered.push(`${PERSONAL_HOME_SIGNUP_POLICY_ENV_KEY}=${PERSONAL_HOME_SIGNUP_CLOSURE_ENV[PERSONAL_HOME_SIGNUP_POLICY_ENV_KEY]}`);
    }
    const output = rendered.join('\n');
    return output.endsWith('\n') ? output : `${output}\n`;
}

export function assertPersonalHomeSignupClosed(
    source: string | Readonly<Record<string, unknown>>,
): void {
    if (readEffectivePersonalHomeSignupPolicy(source) !== 'disabled') {
        throw new PersonalHomeSignupClosureError();
    }
}

/**
 * Re-applies closure and verifies the exact rendered/read-back value in one pure step.
 * Runtime owners should persist this returned text, restart the server, and call
 * `assertPersonalHomeSignupClosed` on the startup readback before any exposure.
 */
export function applyAndVerifyPersonalHomeSignupClosure(existingEnvText: string): string {
    const rendered = applyPersonalHomeSignupClosure(existingEnvText);
    assertPersonalHomeSignupClosed(rendered);
    return rendered;
}
