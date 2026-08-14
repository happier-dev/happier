/**
 * Copy for /enterprise.
 *
 * THE HIGHEST-STAKES PAGE ON THE SITE. Everything here is a claim about a
 * security control, made to a reader whose job is to check it. One capability
 * that is "in the schema but not in production" costs more credibility than
 * every other page on happier.dev earns.
 *
 * The rule applied while writing it: a capability appears below only if it is
 * (a) documented in the shipped tree AND (b) traceable to server source. Two
 * things the README advertises were dropped for failing that test, and the
 * reasons are recorded here so nobody re-adds them from the README:
 *
 *   - "GitHub OAuth with org/TEAM membership gating". There is no team
 *     allowlist. `AUTH_GITHUB_ALLOWED_USERS` and `AUTH_GITHUB_ALLOWED_ORGS`
 *     exist; grepping apps/server/sources/app/auth/providers/github for "team"
 *     returns nothing. The page says orgs and users.
 *   - "mTLS ... via reverse proxy OR DIRECT". auth-mtls.mdx:168 says in the
 *     shipped docs: "Direct mode is not implemented yet in the open-source
 *     server; use forwarded mode for now." The page says forwarded.
 *   - "Keyless external auth for SSO-only environments". The shipped docs
 *     describe it as available, but the v0.3 tree adds an activation-closed
 *     caution telling operators to keep keyless auto-provisioning disabled in
 *     production until account-data migrations land. A control we would tell an
 *     operator not to turn on is not a control we advertise. Left off entirely.
 *   - "file transfer size limits" as a configurable policy. The server has a
 *     fixed 100MB body limit (apps/server/sources/app/api/api.ts:80); no
 *     operator-facing size policy was found. Left off.
 *
 * Verification anchors (happier-dev/happier @ v0.2, the shipped tree):
 *   signup / login policy    apps/docs/content/docs/server/auth.mdx:238-268
 *   GitHub allowlists        apps/docs/content/docs/server/auth-github.mdx:164-213
 *   OIDC allow rules         apps/docs/content/docs/server/auth-oidc.mdx:47-81
 *   mTLS identity mapping    apps/docs/content/docs/server/auth-mtls.mdx:48-73, 104-124
 *   storage policy           apps/docs/content/docs/server/encryption.mdx:25-32
 *   feature flags            apps/docs/content/docs/features/feature-flags.mdx
 *   rate limits              apps/docs/content/docs/deployment/env.mdx:196-248
 *   diagnostics access       apps/docs/content/docs/deployment/env.mdx:302-311
 *   retention                apps/docs/content/docs/server/retention.mdx:1-60
 *   Docker + databases       apps/docs/content/docs/deployment/docker.mdx:10-60,
 *                              apps/docs/content/docs/deployment/env.mdx:67-69
 */

export type EnterpriseCapability = {
    id: string;
    title: string;
    body: string;
};

/** Who is allowed in, and how the server keeps checking. */
export const ENTERPRISE_ACCESS: ReadonlyArray<EnterpriseCapability> = [
    {
        id: 'closed',
        title: 'A relay that only your people can reach',
        body: 'Anonymous signup is on by default because most self-hosters put the relay behind Tailscale and are done. Turn it off and require an identity provider instead, and eligibility is enforced on every authenticated HTTP route and on the realtime handshake — not only at the front door. A request from someone who no longer qualifies is refused, not downgraded.',
    },
    {
        id: 'github',
        title: 'GitHub, restricted to your orgs',
        body: 'Allow specific logins, or require membership of one or more GitHub organisations, matching any or all of them. The recommended path verifies membership through a GitHub App rather than the user’s own OAuth token, so access does not survive a developer revoking consent — and does not break when they do.',
    },
    {
        id: 'oidc',
        title: 'OIDC, with rules per provider',
        body: 'Okta, Entra ID, Auth0, Keycloak, anything with a discovery document. Each provider gets its own allow rules: a login allowlist, permitted email domains, groups the user must be in any of, groups they must be in all of. If your IdP omits groups from the token and hands back an overage pointer instead, Happier treats the user as ineligible rather than as ungrouped.',
    },
    {
        id: 'mtls',
        title: 'Client certificates from your MDM',
        body: 'Terminate mTLS at your reverse proxy and forward a verified identity to Happier. Map it from the certificate’s SAN email or SAN UPN so a device rotating its certificate is still the same person, and constrain it with issuer and email-domain allowlists. Unknown certificates are rejected unless you have deliberately enabled auto-provisioning.',
    },
    {
        id: 'offboarding',
        title: 'Offboarding that actually happens',
        body: 'Membership is re-checked on an interval you set — daily by default, down to a minute — and the result is cached on the identity record. The interesting setting is what happens when your IdP is unreachable: permissive by default, or strict, where the server fails closed rather than letting a stale eligibility check stand in for a live one.',
    },
];

/** What the server does with the data once someone is in. */
export const ENTERPRISE_DATA: ReadonlyArray<EnterpriseCapability> = [
    {
        id: 'storage',
        title: 'Three storage policies, and the default is the strict one',
        body: 'End-to-end encrypted only, which rejects plaintext writes and is what a fresh server does. Optional, where an account or session decides. Or plaintext only, for organisations that manage encryption at the infrastructure layer and want server-side indexing — a real trade, stated plainly: on that setting the server can read stored content.',
    },
    {
        id: 'retention',
        title: 'Retention you configure, or none at all',
        body: 'Off by default: set nothing and the server keeps sessions forever. Turn it on and the session rule is conservative on purpose — a session tree is deleted only when it is inactive on the persisted flag, older than the cutoff on two separate timestamps, and not observed as live in memory, with the cutoff re-checked inside the delete transaction. It never needs to decrypt a transcript to decide.',
    },
    {
        id: 'flags',
        title: 'Turn features off for everyone at once',
        body: 'Voice, social, bug-report uploads, attachments, the embedded terminal, session handoff, connected services, quota meters — each is an environment variable on the server, advertised to clients at runtime. Clients adapt to what the server says is available, so a disabled capability is absent from the UI rather than present and failing.',
    },
    {
        id: 'limits',
        title: 'Rate limits and a diagnostics endpoint you control',
        body: 'A global limiter plus per-route limits, each with its own window and a key strategy you choose — by IP, or by user falling back to IP, which is what you want when a hundred developers share one VPN egress address. The server diagnostics snapshot is off until you enable it, and owner-only when you do.',
    },
    {
        id: 'deploy',
        title: 'Docker, and a database you already run',
        body: 'The published relay-server image runs as a non-root user with the web UI embedded, defaults to SQLite under a single mounted volume, and takes a documented Postgres override. MySQL works too, from a source-built image — the prebuilt one deliberately leaves that client out. Pin an immutable tag; the image does not update itself.',
    },
];

/**
 * The Anthropic paragraph.
 *
 * Stated without gloating, per the brief. It is also the single most relevant
 * fact on the page for the reader who arrived here: the person evaluating a
 * self-hosted relay for a regulated org is, very often, exactly the person whose
 * org cannot turn Remote Control on.
 */
export const ENTERPRISE_ZDR: ReadonlyArray<string> = [
    'If you are reading this page you may already have run into the wall from the other direction. Anthropic’s own Remote Control documentation is explicit: organisations with compliance requirements such as Zero Data Retention cannot enable it. In that state the toggle in the Claude Code admin console is greyed out, so it is not something an Owner can decide differently. It is also unavailable on Amazon Bedrock, Google Cloud’s Agent Platform and Microsoft Foundry, and disabled when traffic is pointed at an LLM gateway instead of api.anthropic.com.',
    'None of that is a criticism. Remote Control keeps the session transcript on Anthropic servers so it can sync across your devices, and an organisation that has contracted for zero retention has, correctly, ruled that out. It is simply a different answer to a different question, and if your org is in that position, a relay you run yourself is the shape of answer that is left.',
];

/** Where the operator goes next. Not a step list — this page does not own procedure. */
export const ENTERPRISE_DOCS_URL = 'https://docs.happier.dev/server/auth';
export const ENTERPRISE_DEPLOY_URL = 'https://docs.happier.dev/deployment/docker';
