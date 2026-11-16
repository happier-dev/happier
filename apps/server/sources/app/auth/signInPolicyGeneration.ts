/**
 * The Home sign-in policy version this node has applied. A sign-in policy change advances it
 * (`invalidateLoginEligibilityPositiveCache`). Whoever reads the policy reads the generation first,
 * so an eligibility result decided from an older policy is never cached and a socket admitted by
 * one is re-decided. Leaf module: the Home configuration readers tag each env they build with the
 * generation read before it, so a decision from an env read earlier keeps that earlier generation.
 */
let signInPolicyGeneration = 0;

export function readSignInPolicyGeneration(): number {
    return signInPolicyGeneration;
}

export function advanceSignInPolicyGeneration(): void {
    signInPolicyGeneration += 1;
}

const envGenerations = new WeakMap<object, number>();

/** Home configuration readers: `env` was read under `generation` (read before the read began). */
export function tagEnvSignInPolicyGeneration<E extends object>(env: E, generation: number): E {
    envGenerations.set(env, generation);
    return env;
}

/** The generation an env was read under, when a Home configuration reader built it. */
export function readEnvSignInPolicyGeneration(env: object): number | undefined {
    return envGenerations.get(env);
}
