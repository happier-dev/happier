import { describe, expect, it } from "vitest";

import {
    findEffectiveAuthMethodDecision,
    applyHomePolicyToAuthMethodDecision,
    isEffectiveAuthMethodActionEnabled,
    resolveEffectiveAuthMethodDecisions,
    toPublishedAuthMethods,
    type EffectiveAuthMethodInputs,
} from "@/app/auth/methods/effectiveAuthMethods";

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
        ...overrides,
    };
}

/** A deployment that used the operator opt-out to turn native password auth off entirely. */
function emailPasswordOptedOutEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return baseEnv({ HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "0", ...overrides });
}

describe("effective auth method decisions", () => {
    it.each(["inherited", "closed", "invitation_only", "self_service"] as const)(
        "requires explicit self_service for company Home SSO provisioning (%s)", (admission) => {
            const decision = applyHomePolicyToAuthMethodDecision({
                id: "company-sso",
                ui: { displayName: "Company", providerKind: "workos_sso" },
                actions: [
                    { id: "connect", mode: "either", enabled: true },
                    { id: "login", mode: "keyless", enabled: true },
                    { id: "provision", mode: "keyed", enabled: true },
                    { id: "provision", mode: "keyless", enabled: true },
                ],
                allowedProvisionModes: ["e2ee", "plain"], recommendedProvisionMode: null,
            }, admission === "inherited" ? { status: "inherited" } : {
                status: "narrowed", policy: { v: 1, admission },
            });
            expect(decision.actions.filter((action) => action.id === "provision")
                .every((action) => action.enabled === (admission === "self_service"))).toBe(true);
            expect(decision.actions.filter((action) => action.id !== "provision")
                .every((action) => action.enabled)).toBe(true);
        },
    );
    it("does not bound password login by the Key Challenge method's own policy", () => {
        const env = baseEnv({ HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1" });
        const login = (inputs: EffectiveAuthMethodInputs) => findEffectiveAuthMethodDecision(inputs, "email_password")
            ?.actions.find(({ id }) => id === "login");
        // Native E2EE password login completes through the Key Challenge
        // finalizer, but that finalizer qualifies a password-stamped challenge
        // as `email_password` and gates on this method's own decision
        // (`registerKeyChallengeAuthRoute.ts`). Withdrawing the keyed branch here
        // would let a Home create E2EE password Accounts and then refuse to sign
        // them in, so neither the deployment switch nor a Home narrowing that
        // drops `key_challenge` may narrow this action.
        expect(login({ env: { ...env, HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0" } }))
            .toMatchObject({ enabled: true, mode: "either" });
        expect(login({ env, homeAuthenticationPolicy: { status: "narrowed", policy: {
            v: 1, enabledMethodIds: ["email_password"],
        } } })).toMatchObject({ enabled: true, mode: "either" });
        expect(login({ env: { ...env, HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1", HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" } }))
            .toMatchObject({ enabled: true, mode: "either" });
        // The operator opt-out is still the one answer that removes login.
        expect(login({ env: emailPasswordOptedOutEnv() })).toMatchObject({ enabled: false, reason: "method_not_enabled" });
    });
    it("keeps deployment Account-mode narrowing on provisioning so an existing Plain Account can still sign in", () => {
        // A Home that created Plain password Accounts and later turned keyless
        // accounts off (or required E2EE) must not strand them: the deployment
        // Account-mode policy governs construction of new Accounts only.
        const e2eeOnlyDeployment = findEffectiveAuthMethodDecision({
            env: baseEnv({
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED: "1",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            }),
            emailDeliveryReady: true,
        }, "email_password");
        expect([...e2eeOnlyDeployment!.allowedProvisionModes]).toEqual(["e2ee"]);
        expect(e2eeOnlyDeployment!.actions.find((a) => a.id === "provision"))
            .toMatchObject({ enabled: true, mode: "keyed" });
        expect(e2eeOnlyDeployment!.actions.find((a) => a.id === "login"))
            .toMatchObject({ enabled: true, mode: "either" });
        expect(e2eeOnlyDeployment!.actions.find((a) => a.id === "connect"))
            .toMatchObject({ enabled: true, mode: "either" });
    });
    it("narrows only provisioning to permitted Account modes and preserves existing-Account actions", () => {
        const decision = findEffectiveAuthMethodDecision({
            env: baseEnv({
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED: "1",
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            }),
            emailDeliveryReady: true,
            homeAuthenticationPolicy: { status: "narrowed", policy: {
                v: 1, permittedAccountModes: ["e2ee"],
            } },
        }, "email_password");
        expect(decision?.allowedProvisionModes).toEqual(["e2ee"]);
        expect(decision?.actions.find(({ id }) => id === "login")).toMatchObject({ enabled: true, mode: "either" });
        expect(decision?.actions.find(({ id }) => id === "connect")).toMatchObject({ enabled: true, mode: "either" });
        expect(decision?.actions.find(({ id }) => id === "provision")).toMatchObject({ mode: "keyed" });
    });
    it("narrows publication, admission and startup together using persisted Home policy", () => {
        const inputs: EffectiveAuthMethodInputs = {
            env: baseEnv({ HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1" }),
            homeAuthenticationPolicy: { status: "narrowed", policy: {
                v: 1, enabledMethodIds: ["email_password"], admission: "invitation_only",
            } },
        };
        expect(findEffectiveAuthMethodDecision(inputs, "key_challenge")?.actions.every((a) => !a.enabled)).toBe(true);
        expect(isEffectiveAuthMethodActionEnabled(inputs, "key_challenge", "login")).toBe(false);
        // Disabling `key_challenge` does not narrow password login at all: the
        // Key Challenge finalizer qualifies a password-stamped challenge as
        // `email_password` and gates on that method, so an E2EE password
        // Account must keep its keyed branch here.
        expect(findEffectiveAuthMethodDecision(inputs, "email_password")?.actions
            .find(({ id }) => id === "login")).toMatchObject({ enabled: true, mode: "either" });
        const publication = toPublishedAuthMethods(resolveEffectiveAuthMethodDecisions(inputs));
        expect(publication.find((m) => m.id === "key_challenge")?.actions.every((a) => !a.enabled)).toBe(true);
    });

    it("fails unreadable Home policy closed and never widens deployment mode or signup ceilings", () => {
        const env = baseEnv({ HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1" });
        expect(resolveEffectiveAuthMethodDecisions({ env, homeAuthenticationPolicy: { status: "unreadable" } })
            .every((m) => m.actions.every((a) => !a.enabled))).toBe(true);
        const decision = findEffectiveAuthMethodDecision({ env, homeAuthenticationPolicy: {
            status: "narrowed", policy: { v: 1, permittedAccountModes: ["plain"], admission: "self_service" },
        } }, "email_password");
        expect(decision?.allowedProvisionModes).toEqual([]);
        expect(decision?.actions.find((a) => a.id === "provision")?.enabled).toBe(false);
        expect(decision?.actions.find((a) => a.id === "login")?.enabled).toBe(true);
    });

    it("keeps email_password known but disables every action when the operator opted the deployment out", () => {
        const decisions = resolveEffectiveAuthMethodDecisions({ env: emailPasswordOptedOutEnv() });
        expect(decisions.map((d) => d.id)).toContain("key_challenge");
        expect(findEffectiveAuthMethodDecision({ env: emailPasswordOptedOutEnv() }, "email_password")?.actions
            .every((action) => !action.enabled)).toBe(true);
    });

    it("publishes login/connect on a default Home with no deployment opt-in", () => {
        // No `HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__*` key is set: the method is
        // a shipped capability, and the Home governance policy plus mail
        // readiness are what decide it. Nothing answers `method_not_enabled`.
        const decision = findEffectiveAuthMethodDecision({ env: baseEnv() }, "email_password");
        expect(decision).not.toBeNull();
        expect(decision!.actions.find((a) => a.id === "login")?.enabled).toBe(true);
        expect(decision!.actions.find((a) => a.id === "connect")?.enabled).toBe(true);
        expect(decision!.actions.some((a) => a.reason === "method_not_enabled")).toBe(false);
    });

    it("fails self-service provisioning closed while transactional mail readiness is unknown", () => {
        const env = baseEnv();
        const unknownReadiness = findEffectiveAuthMethodDecision({ env }, "email_password");
        const provision = unknownReadiness!.actions.find((a) => a.id === "provision");
        expect(provision?.enabled).toBe(false);
        expect(provision?.reason).toBe("email_delivery_unavailable");

        const ready = findEffectiveAuthMethodDecision({ env, emailDeliveryReady: true }, "email_password");
        expect(ready!.actions.find((a) => a.id === "provision")?.enabled).toBe(true);
    });

    it("derives action modes and allowed provision modes from the canonical encryption/storage policy owner", () => {
        const bothModes = findEffectiveAuthMethodDecision(
            {
                env: baseEnv({
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
                    HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
                    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
                }),
            },
            "email_password",
        );
        expect([...bothModes!.allowedProvisionModes].sort()).toEqual(["e2ee", "plain"]);
        expect(bothModes!.actions.find((a) => a.id === "login")?.mode).toBe("either");

        const e2eeOnly = findEffectiveAuthMethodDecision(
            {
                env: baseEnv({
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
                    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
                }),
            },
            "email_password",
        );
        expect([...e2eeOnly!.allowedProvisionModes]).toEqual(["e2ee"]);
        expect(e2eeOnly!.recommendedProvisionMode).toBe("e2ee");
        expect(e2eeOnly!.actions.find((a) => a.id === "provision")?.mode).toBe("keyed");
        expect(e2eeOnly!.actions.find((a) => a.id === "login")?.mode).toBe("either");
    });

    it("answers route admission from the same decision that publication uses", () => {
        const enabled = baseEnv();
        expect(isEffectiveAuthMethodActionEnabled({ env: enabled }, "email_password", "login")).toBe(true);
        expect(isEffectiveAuthMethodActionEnabled({ env: emailPasswordOptedOutEnv() }, "email_password", "login")).toBe(false);
        // Unknown methods and unknown actions fail closed.
        expect(isEffectiveAuthMethodActionEnabled({ env: enabled }, "totally_unknown", "login")).toBe(false);
    });

    it("passes invitation admission context through deployment-provider decisions", () => {
        const env = baseEnv({
            AUTH_SIGNUP_PROVIDERS: "github",
            GITHUB_CLIENT_ID: "client",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://home.example.test/v1/oauth/github/callback",
        });
        const homeAuthenticationPolicy = { status: "narrowed" as const, policy: {
            v: 1 as const,
            admission: "invitation_only" as const,
        } };
        const provision = (admission?: { kind: "team_invitation" }) =>
            findEffectiveAuthMethodDecision({ env, homeAuthenticationPolicy, ...(admission ? { admission } : {}) }, "github")
                ?.actions.find((action) => action.id === "provision" && action.mode === "keyed");

        expect(provision()).toMatchObject({ enabled: false, reason: "provisioning_not_enabled" });
        expect(provision({ kind: "team_invitation" })).toMatchObject({ enabled: true });
    });

    it("carries the deployment provider's connect-button colour and profile-badge support in its decision", () => {
        const env = baseEnv({
            AUTH_SIGNUP_PROVIDERS: "github",
            GITHUB_CLIENT_ID: "client",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://home.example.test/v1/oauth/github/callback",
        });

        // teams-lane-03/01 §10.2: the decision the auth-entry projector reads
        // must not discard the descriptor's colour and badge support.
        expect(findEffectiveAuthMethodDecision({ env }, "github")?.ui).toMatchObject({
            displayName: "GitHub",
            connectButtonColor: "#24292F",
            supportsProfileBadge: true,
        });
    });

    it("carries a deployment identity provider's kind in its decision", () => {
        const env = baseEnv({
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([{
                id: "acme",
                type: "oidc",
                displayName: "Acme identity",
                issuer: "https://issuer.example.test",
                clientId: "client-id",
                clientAuthenticationMethod: "client_secret_post",
                clientSecret: "client-secret",
                redirectUrl: "https://home.example.test/v1/oauth/acme/callback",
            }]),
        });

        // teams-lane-03/01 §10.2: the row carries the provider's kind; built-in
        // GitHub OAuth is not a catalog identity-provider kind and states none.
        expect(findEffectiveAuthMethodDecision({ env }, "acme")?.ui).toMatchObject({
            displayName: "Acme identity",
            providerKind: "oidc",
        });
        expect(findEffectiveAuthMethodDecision({ env }, "github")?.ui?.providerKind).toBeUndefined();
    });

});
