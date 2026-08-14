/**
 * Copy for /features/usage-limits.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE PAGE. The account-pooling scoping
 * language used to live in the homepage FAQ's terms-of-service answer, where it
 * was read by everyone including the 90% of visitors who will never link a
 * second account. It moved here because this is where a reader has self-selected
 * into needing it: they are on the usage-limits page, so they are the person
 * actually considering a pool.
 *
 * It moved as a MODULE rather than as JSX because src/data/copyClaims.test.ts
 * guards it. That guard is the reason the "sail past usage limits" framing did
 * not survive its second week, and it only works if the sentences it checks are
 * importable data. Anything that softens or relocates `SCOPE` should expect the
 * suite to go red, which is the point.
 *
 * WHAT A POOL IS SCOPED TO. A pool is keyed by CREDENTIAL, not by agent.
 * `ConnectedServiceIdSchema` (packages/protocol/src/connect/connectedServiceBindings.ts:3)
 * is `openai-codex | openai | anthropic | claude-subscription | gemini | github`,
 * and the create-pool route takes a `serviceId` from exactly that enum — the UI
 * string is "Add a fallback pool for this connected service". So a pool is a
 * pool of ACCOUNTS on one provider credential, and every agent that declares
 * that credential in `connectedServices.supportedServiceIds` can be pointed at
 * it. Copy that reads "Claude Code and Codex can pool accounts" is wrong twice
 * over: it hides OpenCode and Pi, and it implies pools are an agent feature.
 *
 * Verification anchors (happier-dev/happier @ v0.2, the shipped tree):
 *   pool policy defaults   packages/protocol/src/connect/connectedServiceSchemas.ts:499-534
 *                            ConnectedServiceAuthGroupPolicyV1Schema —
 *                            `strategy: …default('least_limited')`,
 *                            `softSwitchRemainingPercent: …default(15)`,
 *                            `maxSwitchesPerTurn: …default(1)`,
 *                            `maxSwitchesPerSessionHour: …default(3)`,
 *                            `cooldownMs: …default(30_000)`,
 *                            `honorProviderResetsAt: …default(true)`
 *   autoSwitch at create   apps/server/sources/app/api/routes/connect/
 *                            connectedServicesV3/registerConnectedServiceAuthGroupRoutesV3.ts:264-268
 *   credential enum        packages/protocol/src/connect/connectedServiceBindings.ts:3
 *   which agent runs on which credential
 *                          packages/agents/src/manifest.ts `connectedServices.supportedServiceIds`
 *                            claude    → claude-subscription, anthropic          (:22)
 *                            codex     → openai-codex, openai                    (:75)
 *                            opencode  → openai-codex, openai,
 *                                        claude-subscription, anthropic          (:155)
 *                            gemini    → gemini                                  (:211)
 *                            pi        → openai-codex, openai,
 *                                        claude-subscription, anthropic          (:376)
 *                            the other nine ids declare `connectedServices: null`
 *   which agents can switch mid-session
 *                          packages/agents/src/connectedServices/runtimeFallbackCapability.ts,
 *                            evaluated against packages/agents/src/manifest.ts —
 *                            `runtimeFallbackSupportingAgentIds` is ['claude'] for
 *                            claude-subscription and anthropic, ['codex'] for
 *                            openai-codex and openai, and [] for gemini and github
 *   github is not an agent credential
 *                          no manifest entry lists it; apps/docs/content/docs/
 *                            features/connected-services.mdx:153
 *   quota snapshots        apps/docs/content/docs/features/connected-services.mdx:228-238
 *                            — openai-codex, claude-subscription, gemini
 *   no CLI for pools       apps/cli/src/cli/commands/ has `connect` (profile
 *                            sign-in: status / codex / claude / gemini, with
 *                            `--profile`) and nothing that creates or edits an
 *                            auth group; every `AuthGroup` symbol under
 *                            apps/cli/src is session-runtime plumbing in
 *                            src/backends/**. Pools are an app screen only.
 *   banner wording         apps/ui/sources/text/translations/en.ts:4689-4712
 *   pool screens           apps/ui/sources/text/translations/en.ts:2579 (the
 *                            Accounts | Pools segments on a connected service),
 *                            :2785-2800 (Create pool), :2748 ("Automatic fallback")
 */

/**
 * The scoping paragraphs. Three beats, in this order, and the order matters:
 * what the feature is for, then what it is not for, then who owns the risk.
 */
export const USAGE_LIMITS_SCOPE: ReadonlyArray<string> = [
    'An account pool is for accounts you own. The shape of the feature is one person with several of their own logins — a personal Max subscription and a work Claude seat, a Codex subscription and an OpenAI key — kept visible and switchable in one place, instead of re-authenticating a CLI every time you run out.',
    'It is not a way to put several people on one subscription. Provider terms — Anthropic’s and OpenAI’s alike — prohibit sharing a single subscription between people, and pooling does not change that: if you use it that way you are outside your provider’s terms, and no client can fix that for you.',
    'We’re not lawyers, we give no guarantee, and provider terms change. Read them. If your organisation has an agreement with a provider, check it before you connect a work account.',
];

/**
 * How switching actually behaves.
 *
 * The first sentence used to read "automatic switching is off by default",
 * which is what the zod schema says and NOT what the product does: the app
 * creates a pool with no `policy` field, and the create route then fills in
 * `autoSwitch: fallbackEnabled() && runtimeFallbackSupportedForService(serviceId)`
 * — true on a default server for any service Claude Code or Codex can switch
 * inside a running session. There is a server integration test named
 * "defaults autoSwitch to true at create when the account-fallback feature is
 * enabled". Saying otherwise on a marketing page would be a lie a user
 * discovers on their first pool.
 */
export const USAGE_LIMITS_SWITCHING: ReadonlyArray<string> = [
    'Nothing switches until you build a pool, and a pool is something you make on purpose: Settings → Connected services, open the service those accounts belong to, then Pools → Create pool, name it, and add the accounts you want in it. Until that exists, every session uses the one account you picked and stops when that account stops.',
    'Once the pool exists it starts with automatic fallback on, for the services that can change account inside a running session. There is a toggle on the pool — "Automatic fallback" — and turning it off leaves you a pool you switch by hand, which is a reasonable way to run it if you would rather decide each time.',
    'The defaults are deliberately unambitious. Happier falls back to another member, preferring whichever has the most quota left, at most once per turn and three times per session hour, with a thirty-second cooldown in between. When a provider says a limit resets at a particular time, Happier takes it at its word and does not treat that account as a candidate until then. A pool is a way to not lose twenty minutes to a re-login; it is not a rotation service, and the per-hour ceiling is there so it cannot quietly become one.',
    // The disambiguation, not the claim. "Load balancing" is what people search
    // for and it is NOT what this does — nothing moves while the active account
    // is healthy (selectConnectedServiceAuthGroupCandidate.ts:593). Saying so
    // plainly answers the query, corrects the expectation before someone buys a
    // second subscription for the wrong reason, and asserts nothing false.
    'People often call this load balancing. What Happier does is narrower, and worth knowing before you pay for a second subscription: it does not spread work across your accounts to keep them level. Nothing moves at all while the account you are on still has room. The pool is there for the moment one runs out — the product calls it automatic fallback, and that is exactly what it is.',
];

/**
 * What a pool is attached to.
 *
 * This is the paragraph the page was missing, and its absence made every other
 * sentence read as though pooling were a Claude-Code-and-Codex feature. It is
 * not. Happier stores a credential, not an agent login, and a pool groups
 * accounts on one credential. The agent list per credential is copied straight
 * from `connectedServices.supportedServiceIds` in the shipped manifest — see
 * the anchors at the top of this file — and OpenCode and Pi appear on four of
 * the five poolable credentials, which is exactly the fact the old copy hid.
 */
export const USAGE_LIMITS_POOL_SCOPE: ReadonlyArray<string> = [
    'A pool belongs to a connected service, not to an agent. A connected service is a kind of credential — a Claude subscription, a Codex subscription, an Anthropic or OpenAI key, a Gemini login — and a pool is a set of your own accounts on one of them. Which agent you run is a separate choice, made when you start a session.',
    'So the same pool serves more than one agent. Claude subscriptions and Anthropic keys are consumed by Claude Code, OpenCode and Pi; Codex subscriptions and OpenAI keys by Codex, OpenCode and Pi; Gemini logins by Gemini. Build a pool of your two Claude accounts and it is there whether you open Claude Code, OpenCode or Pi that afternoon.',
];

export type PoolDefault = {
    id: string;
    setting: string;
    value: string;
    note: string;
};

/**
 * The defaults a new pool starts with.
 *
 * A reader evaluating this feature wants to know how aggressive it is before
 * they turn it on, and "three switches per session hour" answers that better
 * than any adjective could. Every value is a zod default from the protocol
 * schema, and every one of them is editable per pool.
 */
export const POOL_DEFAULTS: ReadonlyArray<PoolDefault> = [
    {
        id: 'strategy',
        setting: 'Which account it picks',
        value: 'Most quota left',
        note: 'Read from the last usage snapshot. A fixed priority order and fully manual are the alternatives.',
    },
    {
        id: 'switchOn',
        setting: 'What triggers a switch',
        value: 'Usage limit, expired auth, changed account',
        note: 'A failed token refresh does not, because a refresh usually fails for a reason another account will not fix.',
    },
    {
        id: 'soft',
        setting: 'Preventive switch',
        value: 'Below 15% remaining',
        note: 'Only when another member has fresher usable quota. Set it to 0 and Happier waits for the real limit.',
    },
    {
        id: 'perTurn',
        setting: 'Switches per turn',
        value: '1',
        note: 'One turn cannot walk your whole pool. If the next account is also out, the session stops and says so.',
    },
    {
        id: 'perHour',
        setting: 'Switches per session hour',
        value: '3',
        note: 'A ceiling, not a target.',
    },
    {
        id: 'cooldown',
        setting: 'Cooldown between switches',
        value: '30 seconds',
        note: 'Stops one flapping provider response from producing a burst of account changes.',
    },
    {
        id: 'resets',
        setting: 'Provider reset times',
        value: 'Honoured',
        note: 'A member that a provider says is out until 4pm is not a candidate until 4pm.',
    },
];

export type ServiceSupportRow = {
    id: string;
    service: string;
    agents: string;
    autoSwitch: string;
    meter: string;
};

/**
 * Which accounts can be pooled, which agents run on each one, and where a
 * switch can actually happen inside a running session.
 *
 * The rows are CREDENTIALS, and that is deliberate — it is the shape of the
 * feature, and a table of agents would reproduce the error this page had.
 *
 * The `autoSwitch` column is the one most likely to be over-claimed. An agent
 * can be handed a pool without being able to change account mid-session: only
 * Claude Code and Codex declare the `same_connected_group` transition that a
 * live switch requires, which is why OpenCode and Pi appear in the "agents"
 * column and not in this one. Generated by hand from the output of
 * `resolveConnectedServiceRuntimeFallbackCapability`, which is the same
 * function the server calls before it will let a pool turn switching on:
 *
 *   openai-codex        holders codex, opencode, pi   runtime fallback codex
 *   openai              holders codex, opencode, pi   runtime fallback codex
 *   claude-subscription holders claude, opencode, pi  runtime fallback claude
 *   anthropic           holders claude, opencode, pi  runtime fallback claude
 *   gemini              holders gemini                runtime fallback none
 *   github              holders none                  runtime fallback none
 */
export const SERVICE_SUPPORT: ReadonlyArray<ServiceSupportRow> = [
    {
        id: 'claude-subscription',
        service: 'Claude subscription',
        agents: 'Claude Code, OpenCode, Pi',
        autoSwitch: 'Claude Code',
        meter: 'Yes',
    },
    {
        id: 'anthropic',
        service: 'Anthropic API key',
        agents: 'Claude Code, OpenCode, Pi',
        autoSwitch: 'Claude Code',
        meter: 'No',
    },
    {
        id: 'openai-codex',
        service: 'Codex subscription',
        agents: 'Codex, OpenCode, Pi',
        autoSwitch: 'Codex',
        meter: 'Yes',
    },
    {
        id: 'openai',
        service: 'OpenAI API key',
        agents: 'Codex, OpenCode, Pi',
        autoSwitch: 'Codex',
        meter: 'No',
    },
    {
        id: 'gemini',
        service: 'Gemini',
        agents: 'Gemini',
        autoSwitch: 'None',
        meter: 'Yes',
    },
];

/**
 * The two things the table cannot say in a cell.
 *
 * The first is the distinction the third column is making: OpenCode, Pi and
 * Gemini can hold and use a pool, they just cannot change account inside a
 * running turn. The second answers the question the table provokes — GitHub is
 * in the connected-services enum and is not in the table, and a reader who
 * knows that will want to know why.
 */
export const USAGE_LIMITS_SUPPORT_NOTES: ReadonlyArray<string> = [
    'OpenCode, Pi and Gemini can all be pointed at a pooled account and can move between its members, but not without the session restarting — so for those you are choosing the account before the session starts rather than during it. Every other agent Happier runs signs in through its own CLI and is not part of this at all.',
    'GitHub is a connected account too, and it is the one that is not here: no agent runs on a GitHub token. Happier uses it to publish a repository or open a pull request, so it has neither a pool nor a quota meter.',
];

/**
 * Setting it up.
 *
 * THREE ERRORS HAVE SHIPPED IN THIS PARAGRAPH, AND EACH ONE WAS THE FIX FOR
 * THE LAST. That is why all three stay written down: the failure mode here is
 * not carelessness, it is the correction.
 *
 *   1. OVERCLAIM. It once said the screens, "the CLI equivalents" and the
 *      per-pool settings were all in the docs, "which is the only place that
 *      step list lives". Both halves were false.
 *   2. OVER-CORRECTION. The fix for (1) went too far the other way and said
 *      "Pools have no command-line equivalent." Also false, and false in the
 *      same way: a reader who knows the CLI checks, and stops believing the
 *      page. `parseConnectedServicesLaunchAuth` accepts `cs:group:<id>`,
 *      `cs:profile:<id>`, `cs:<serviceId>:group:<id>` and
 *      `cs:<serviceId>:profile:<id>` (apps/cli/src/cli/
 *      connectedServicesLaunchAuth.ts:19-63), so the flag does take a pool.
 *   3. THE CORRECTION'S OWN OVERCLAIM. The fix for (2) then asserted that
 *      `happier --auth cs:group:<id>` "is in the root help, beside
 *      happier --auth cs:<id>". It is not. buildRootHelpText.ts:29 prints one
 *      line for this flag — `happier --auth cs:<id>    Start with an exact
 *      Connected Services profile or pool` — and grepping that file for
 *      `cs:group:` returns nothing. The single printed line DESCRIBES both
 *      selectors; only one of them is spelled out.
 *
 * The precise truth is a split, and now a second split inside it. There is no
 * CLI that CREATES a pool — nothing under apps/cli/src/cli/commands touches an
 * auth group, and `happier connect` is described in the command manifest as
 * "Connect AI vendor API keys" — but there IS a CLI that starts a session on
 * one, and its selector is accepted without being printed. Say all of it: a
 * correction produces a false statement exactly as reliably as the overclaim
 * it is correcting.
 */
export const USAGE_LIMITS_SETUP: ReadonlyArray<string> = [
    'Two accounts connected on the same service, one pool, and a check that the meter is reading. Building the pool is a job for the app — Settings → Connected services, pick the service, Pools — because no command creates one; happier connect signs an account in from a shell and stops there. Starting a session on a pool you have already built is the half that is in the CLI: happier --auth cs:<id> takes the id of a profile or a pool. There is a longer cs:group:<id> spelling for the case where a profile and a pool share an id and the short form cannot tell them apart.',
    'A self-hosted relay can switch this off, and can switch quota meters off separately from pooling. If you are on someone else’s server and the Pools screen is missing, that is the server’s answer rather than a bug.',
];

/** The one link this page makes into the docs, labelled as a configuration reference. */
export const USAGE_LIMITS_DOCS_URL = 'https://docs.happier.dev/features/connected-services';
