# Embeddable Happier CRM fixture

Dev-only source fixture for plan 04 U10. It serves Fieldwork, a small CRM, at
`http://127.0.0.1:5199`: a lead table, structured analysis, per-lead Happier chat,
and a second pipeline copilot chat. The Happier frame must be on a different origin.
The host page sends `Content-Security-Policy: frame-ancestors 'none'`.

The backend uses the generated snippet's public SDK flow: `connect`,
`embed.createSession`, `embed.listSessions`, and `embed.createCredential`.
`host.tsx` uses the React snippet's `HappierSession` and credential callback inside
bounded host regions. The dev server bundles the current public embed source; it
does not use a published CDN or produce a release archive. When exercising snippet
copy in QA, compare the copied Backend/React snippets verbatim with these adapters;
only the CRM's authorization rule and source-development serving surround them.

## Prepare on the existing QA stack

The later QA lane owns the composed journey on `agent-qa-embeddable`. This fixture
does not create, activate, restart, or certify a Stack. Use the managed Happier CLI
for that stack and the current-source development plugin lifecycle.

1. Use Settings → Embeds to create “Leads dashboard”: allow the fixture origin;
   enable Send, Approve, session creation, new chats and Change model; bind the QA
   computer and Claude, one model M1, folder Leads and tag inbound. Customize the
   accent, radius and font. Copy the key and both generated snippets.
2. Keep `HAPPIER_EMBED_KEY` on the fixture server. Set `HAPPIER_SERVER_URL` to the
   QA Home and `HAPPIER_WEBAPP_URL` to its UI URL. For E2EE, the key must have the
   content material provided by Settings. Never put the key in `host.tsx`, a URL,
   source control, or browser storage.
3. Prepare the current SDK dependencies through the repository's normal build
   owner if they have not been built. Start the dev-only server from this checkout:

   ```sh
   node packages/embed/dev/server.mjs
   ```

   Use the existing development command environment for the three variables;
   the server does not load or write `.env` files. Optional
   `HAPPIER_FIXTURE_CREDENTIAL_SECONDS=120` exercises short-expiry refresh (default
   900 seconds, matching the generated snippet). Stop with the same process handle.
4. On the same machine as the fixture backend, prepare and install the public plugin:

   ```sh
   happier plugins dev install packages/embed/dev/leads-fixture
   happier plugins dev typecheck packages/embed/dev/leads-fixture
   happier plugins dev build packages/embed/dev/leads-fixture
   happier plugins install packages/embed/dev/leads-fixture --dev --json
   ```

   `plugins dev install` prepares the declared SDK and compiler dependencies;
   it does not activate the plugin. Run it once after dependency declarations
   change or the plugin's dependency tree is removed. The public authoring
   compiler must be physically inside this plugin's `node_modules`, even when
   the surrounding checkout already has the SDK and TypeScript installed.
   Happier supplies the prepublication SDK package through the managed toolchain.

   The final `plugins install ... --dev` command grants exact-source code trust.
   Any separate network-resource authority
   review remains with the present user; retain its pending change ID. The plugin
   requests POST access only to the fixture origin. If the backend must live on
   another host, change `FIXTURE_ORIGIN` in `leads-fixture/contracts.mjs` (the
   server derives its listen address/port from it), then review the actual network
   grant. Do not silently replace loopback with a public service.
5. Keep `record-analysis` at Allow and `update-stage` at Ask first in Happier's
   canonical Actions settings. The former is authored safe; the latter has remote
   write danger and confirmation metadata. The host never implements approvals.

## Business Actions and idempotence

The plan's conceptual `leads.record_analysis` and `leads.update_stage` are the public
Actions `dev.leads-fixture/actions/record-analysis` and
`dev.leads-fixture/actions/update-stage`. Public contribution IDs require hyphens,
so the underscore names are retained only as backend operation names.

Both inputs require `leadId`. Analysis also requires `score`
(0–100), `summary`, and `nextStep`; stage accepts `new`, `contacted`, `qualified`,
`won`, or `lost`. The plugin and backend consume the same closed public schemas.
Caller-supplied `invocationId` is rejected. The handler POSTs the public host-stamped
`context.invocationId` as `Idempotency-Key` and refuses a missing identity.
An approved operation uses its durable approval-request ID across replay; a fresh
Action gets a distinct host identity even with identical input. The backend applies a
logical invocation once, returns its original result on replay, and rejects
reuse of its ID for a different operation/input with `idempotency_conflict`.
The handler also sends the public host-stamped `context.session.id`; the CRM
checks that session's owner against the lead's owner before reading a replay
result or applying a change. A copilot can act across its owner's leads.

The approval owner still decides whether the stage handler runs. The identity
does not authorize another execution or retry an ambiguous, already-started effect.

The server is an in-memory, loopback-only fixture. Browser reloads retain the CRM
and replay results while the backend remains running; backend restarts reset
fixture records. Maya (`salesperson`) owns Northstar and Verdant; Sam
(`other-salesperson`) owns Alpine. The selector switches these synthetic dev
identities; it is not production authentication. The business callback endpoint
rejects browser Origin requests but is intentionally available to the local
plugin/test harness, with no production-security claim.

## Credential authorization

`canOpenSession` is the CRM's canonical owner rule. Backend-created lead sessions
are stored on the owned lead before their first input is sent through the public
Session handle, so an immediate business callback already has ownership. Both
creation and that initial send have stable SDK request IDs; an ambiguous send
failure retains the session for the next retry. New-chat credentials are recorded
against the signed-in fixture user until that child expires. A `reason:'created'` exchange first checks
this issuance record, then asks Happier to mint using `requireCreatedBy`.
Only a successful verified mint records user ownership and the copilot session ID.
An exchange retry retains the issuance mapping until the original child expires.
Ordinary renewals and page reloads use the stored user/session ownership rule.
`onSessionCreated` is a fact callback; it does not grant access.

## Later QA recipe

Open the fixture, analyze Northstar, inspect the structured score/summary/next step,
and confirm `/api/happier/sessions` lists only the user's owned chats in the embed's
folder/tag filter. Follow up with “Should we move this lead to qualified? Call
the Leads fixture update-stage Action with leadId=northstar and stage=qualified.”
Approve in the frame; refresh/reload and inspect `stageUpdates` from `/api/state`
to confirm one application. Re-submit the same approval through the approval owner
to confirm no second effect. Repeating a callback with that host key also returns
the original backend result; a fresh Action, even with identical input, is distinct.

Start the copilot by first Send, verify the stored session reopens after reload,
then switch to Sam and verify Maya's session credential is refused. The QA lane
must use its browser network interception for the lost spawn response and
interrupted attachment chunk; the fixture adds no second transport or creation
implementation. Use that same recipe for plain and E2EE Accounts, plus plan 04
§8.3's model, origins, key tampering, rapid switching, expiry, grant edit and
revocation cases. Runtime identity includes the controlled Stack, the loaded
plugin occurrence, the current source-bundled host, and the running fixture process.
The Execution Run conversation-context probe remains a QA prerequisite; this
fixture uses the approved session Action structured-result path.

## Focused checks

Coordinate with the FE lane so only its one remote validation stage runs at a time:

```sh
./apps/stack/bin/hstack-exec -- node node_modules/vitest/vitest.mjs run --config vitest.config.ts --root packages/embed/dev
./apps/stack/bin/hstack-exec -- node scripts/workspaces/runTypeScriptCli.mjs --noEmit -p packages/embed/dev/tsconfig.json
```

Plugin typecheck/build run through the managed public author loop above, routed
through `hstack-exec` when used as non-mutating validation. Live installation and
the composed journey belong to the later QA lane. No release packaging is needed.
