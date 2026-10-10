import {
    readServerConfigRaw,
    HOME_AUTH_METHOD_ENABLE_KEYS,
    HOME_ANONYMOUS_SIGNUP_KEY,
    HOME_STORAGE_POLICY_KEY,
    HOME_KEYLESS_ACCOUNTS_KEY,
    type HomeAuthenticationPolicyReadV1,
    type ServerConfigEnv,
    type ServerConfigValue,
} from "@happier-dev/protocol";

import { composeHomeConfigEnv, readHomeConfigEnvOrigin } from "@/app/home/settings/homeConfigOverlay";
import { readHomeDeploymentEnv } from "@/app/home/settings/startupHomeEnv";
import { SERVER_CONFIG_REGISTRY } from "@/config/serverConfigRegistry";

/**
 * The Home authentication policy document as deployment configuration (plan
 * `2026-09-26-home-owner-console` §3.4, R4, AM-4, D-1).
 *
 * The document is the Home-side value of the sign-in and storage ceiling keys. Its owner is the
 * governance policy (it runs the viable-login check before a save), but its effect is the one
 * precedence rule every other Home setting has: a document value fills the matching env key only
 * where the deployment left that key unset, so an explicitly set key stays a lock, and each key's
 * registry `apply` decides whether it takes effect on the next request (`live`) or at the next
 * server start (`restart`, the storage policy). The unchanged `(env)` readers then decide both
 * directions: widening arrives as an env value, narrowing stays in
 * `applyHomePolicyToAuthMethodDecision`.
 */
export { HOME_AUTH_METHOD_ENABLE_KEYS, HOME_ANONYMOUS_SIGNUP_KEY, HOME_STORAGE_POLICY_KEY, HOME_KEYLESS_ACCOUNTS_KEY };

/**
 * Deployment keys a method needs before any Home decision can offer it, where this Home knows
 * them. The console names them on the unavailable row ("your deployment has no GitHub sign-in app").
 */
export const HOME_AUTH_METHOD_PREREQUISITE_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    github: Object.freeze(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]),
});

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/** The env values a stored document stands for, keyed by registry name. */
export function homeAuthenticationPolicyConfigValues(
    read: HomeAuthenticationPolicyReadV1 | undefined,
): Readonly<Record<string, ServerConfigValue>> {
    if (read?.status !== "narrowed") return {};
    const policy = read.policy;
    const values: Record<string, ServerConfigValue> = {};
    for (const methodId of policy.enabledMethodIds ?? []) {
        if (hasOwn(HOME_AUTH_METHOD_ENABLE_KEYS, methodId)) values[HOME_AUTH_METHOD_ENABLE_KEYS[methodId]!] = true;
    }
    // Plain Accounts need keyless Accounts; permitting them is the owner's statement that they may exist.
    if (policy.permittedAccountModes?.includes("plain")) values[HOME_KEYLESS_ACCOUNTS_KEY] = true;
    if (policy.anonymousSignup !== undefined) values[HOME_ANONYMOUS_SIGNUP_KEY] = policy.anonymousSignup;
    if (policy.storagePolicy !== undefined) values[HOME_STORAGE_POLICY_KEY] = policy.storagePolicy;
    return values;
}

function sameValues(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => hasOwn(b, key) && a[key] === b[key]);
}

/**
 * `env` as the Home runs under `read`: the document's live values over the deployment env.
 *
 * `env` may be the request/job overlay, which already carries the stored document; the overlay is
 * rebuilt from its deployment base so a prospective document replaces the stored one instead of
 * reading as a lock. Any other env is treated as the deployment env itself.
 */
export function applyHomeAuthenticationPolicyToEnv(
    env: ServerConfigEnv,
    read: HomeAuthenticationPolicyReadV1 | undefined,
): NodeJS.ProcessEnv {
    const values = homeAuthenticationPolicyConfigValues(read);
    const origin = readHomeConfigEnvOrigin(env);
    if (origin && sameValues(origin.policyValues, values)) return env as NodeJS.ProcessEnv;
    return composeHomeConfigEnv(origin
        ? { ...origin, policyValues: values }
        : { base: env, settingsValues: {}, policyValues: values, openedSecrets: {} }) as NodeJS.ProcessEnv;
}

/**
 * The env whose explicit values are the deployment's locks: the overlay's base, and for the
 * process environment the snapshot taken at start (before applied Home values were written into it).
 */
export function readHomeAuthenticationLockEnv(env: ServerConfigEnv): ServerConfigEnv {
    const base = readHomeConfigEnvOrigin(env)?.base ?? env;
    return base === process.env ? readHomeDeploymentEnv() : base;
}

/** The deployment key that fixes `key`, or `null` when the Home decides it. */
export function readHomeAuthenticationLock(env: ServerConfigEnv, key: string): string | null {
    const entry = hasOwn(SERVER_CONFIG_REGISTRY, key) ? SERVER_CONFIG_REGISTRY[key] : undefined;
    if (!entry) return null;
    return readServerConfigRaw(readHomeAuthenticationLockEnv(env), entry) ? key : null;
}

/**
 * The widest env this Home could run under: every method, keyless Accounts and anonymous signup
 * turned on where the deployment left them unset. The console lists a method as a choice when it
 * is viable here, and as fixed or unavailable when it is not.
 */
export function homeAuthenticationCeilingEnv(env: ServerConfigEnv): NodeJS.ProcessEnv {
    const values: Record<string, ServerConfigValue> = { [HOME_ANONYMOUS_SIGNUP_KEY]: true, [HOME_KEYLESS_ACCOUNTS_KEY]: true };
    for (const key of Object.values(HOME_AUTH_METHOD_ENABLE_KEYS)) values[key] = true;
    // Not an overlay: the decision owner must treat these values as the env it was given.
    return composeHomeConfigEnv(
        { base: readHomeConfigEnvOrigin(env)?.base ?? env, settingsValues: readHomeConfigEnvOrigin(env)?.settingsValues ?? {}, policyValues: values, openedSecrets: readHomeConfigEnvOrigin(env)?.openedSecrets ?? {} },
        { register: false },
    ) as NodeJS.ProcessEnv;
}
