# Providers

Providers are model sources such as OpenRouter, DeepSeek, Z.AI, Ollama, or LM Studio. They are separate from **Agents**, the executable coding tools such as Claude Code, Codex, OpenCode, Gemini, and Pi.

This distinction is a product and architecture invariant:

- an **Agent** owns executable behavior, session lifecycle, authentication to its native CLI, and the protocols it can consume;
- a **Provider contribution** describes a model source supplied by a plugin;
- a **Provider connection** is an account-owned configuration of that source, including endpoint overrides and credential bindings;
- a **Profile** is an optional launch preset. Profiles do not own provider endpoints, provider credentials, or provider model catalogs.

See [Agents catalog](./agents-catalog.md) for executable-agent ownership.

In 0.3 development source, the retained Provider runtime binding carries the
Agent's selected helper-model roles alongside its prepared adapter binding key.
Managed gateway creation, retained Session reopening and remote gateway placement
reconstruct the Agent binding through the shared daemon materialization owner.
Claude's default helper selection is an empty role map and remains distinct from
an absent selection: preparation pins its helpers to the selected Session model.
A preparation mismatch reports `claude_provider_binding_preparation_invalid`
through the existing sanitized failure cause.

In 0.3 development source, Provider plugins own vendor catalog decoding through
their declared `catalogParsers` and `commandParsers`. A contributed parser takes
precedence for its declared id; the host retains generic OpenAI and Anthropic
wire codecs for custom connections. Model-name interpretation and explicit
`reportsModelLoadState` facts belong to the Provider declaration and its parser.

### Connected Account connection tests (0.3 development)

`connectedServices.accounts.testConnection` is the shared explicit test for a
saved qualified account. UI and CLI use the Action executor; the established
Connected Account owner invokes the service runtime's optional `testConnection`
callback with read-only credential custody. A probe reads account, usage or
model metadata without inference, token refresh or credential mutation. Local
credential presence alone does not establish a successful remote test.

The result distinguishes `ok`, `needsReauth`, `networkUnavailable` and
`unsupported`, with secret-free reasons. A service or credential mode without a
characterized no-usage probe returns `unsupported`. ProviderConnection catalog
tests and Channel transport tests retain their distinct resource owners.

Connected Account identity probes classify failures in the service runtime.
An ambiguous HTTP 403, rate limit, server error or network failure reports
unavailability; it does not establish that the credential needs reconnection.
HTTP 401 and explicit credential refusals retain their refusal behavior. Status
and refresh consume that same service-owned classification.

Testing saved credentials uses the same placement owner with a connection-test
operation: a native-import requirement applies to acquiring a login, while an
explicit browser reachability restriction still routes the test to a Machine.
Muse subscriptions with an inference key use the existing authenticated models
GET. MSP usage/read returns cached observations; usage/refresh acquires a key,
so neither is substituted for that explicit no-usage test. Previously delivered
access-only Muse snapshots have no characterized read-only account-token probe;
their remote connection test returns unsupported. New Muse Team shares use the
brokered route only.

### Passive managed gateway families (0.3 development)

The Muse-owned model capability projection publishes structured JSON output support for
`meta/muse-spark-1.3-contributor`. This model was verified through CLIProxyAPI
v8.0.61 using a schema-constrained bounded Run, alongside Meta's
[structured-output contract](https://dev.meta.ai/docs/structured-output).
Both the native catalog and the gateway's SDK catalog generator consume that
one Muse-owned projection: reasoning support derives from offered reasoning options,
and tool round-trip support remains unknown. Source-specific membership, limits
and options still come from native model/list or the pinned gateway SDK.
The prepared Provider descriptor carries these facts to structured-analysis admission. Other Muse models remain
unknown unless their own descriptor establishes support.

The gateway chooser Action preserves matching passive declarations in
`unavailableFamilies`, including their contribution, purpose, qualified service
identity and declared `unavailableReason`. These rows explain unavailability;
they never become selectable or executable purposes. An unknown family without
a matching passive declaration retains the ordinary unavailable result.
The xAI row shares Grok's exported `xai` service identity. Workspace plugin
manifests and CLI declaration assets are published by the canonical bundled
plugin publisher from those same declarations.

### Cursor and Copilot native account sources (0.3 development)

The Cursor plugin owns user/service API keys, subscription browser sign-in and
import of the selected Machine's Cursor Agent login. Browser sign-in uses Cursor's
PKCE deep link and polling through the connected-account coordinator; it also
runs in the Account authentication artifact without a daemon. Native import
requires a connected Machine and reads the CLI's platform credential store.
Subscription credentials refresh through staged account settlement. Native launch
delivers API keys via `CURSOR_API_KEY`, or subscription access via
`CURSOR_AUTH_TOKEN` with `AGENT_CLI_CREDENTIAL_STORE=memory` to preserve the
Machine's original login. These subscription paths are development behavior;
vendor acceptance and subscription entitlement still require live QA. Pi/OpenCode
need a Cursor Connect adapter before they can use this source as a Provider.
There is no Cursor CLIProxyAPI family. The GitHub
plugin owns Copilot device/manual authentication and the existing GitHub token
record; Copilot consumes that record through its native purpose and
`COPILOT_GITHUB_TOKEN`. GitHub's public OAuth client comes from the existing
mode-scoped configuration owner; an absent client makes device login unavailable.
No entitlement probe participates in admission. Token-kind compatibility is
decided by GitHub's materializer, while native acceptance determines usability.
SCM identity and Copilot refusal remain separate outcomes. Copilot's ChatGPT and
Provider choices retain their own explicit routes. Neither source adds a gateway
family, secret store, native credential-file writer or independent quota scheduler.

In 0.3 development, machine CLIs declare authentication on their existing
`systemTools` contribution and use the shared `machines.agents.signIn.*` Actions.
GitHub CLI (`gh`) and 1Password CLI (`op`) declare their native status/login
commands there. Native sign-in opens the existing machine terminal; its command
environment excludes the tool's declared token/session overrides. GitHub native
login retains `GH_HOST` and lets `gh` choose its configured host; native status
uses `gh auth status` across its known hosts. Connected sign-in uses the existing
Connected Account coordinator.

GitHub CLI's `github.cli` purpose accepts the selected personal or directly
delivered Team GitHub account as process-scoped `GH_TOKEN`. Its Git credential
helper is scoped to github.com, resets that host's inherited helper chain, and
preserves other inherited Git configuration. No GitHub token or Git credential
file is written. Brokered Team delivery returns
`github_cli_team_brokered_unavailable`; native login is not a fallback for that
selection. With no bound account, native machine authentication remains in use.

Model and catalog probes admit only the selected Agent's declared Account
purposes. A saved GitHub or other machine CLI Account does not supply credentials
to that probe or block it when unavailable. Actual Session and setup processes
retain their explicitly selected CLI Account purposes and delivery refusals.

Cursor subscription usage reads the DashboardService current-period usage RPC
with the stored OAuth access token through the existing daemon quota coordinator.
API-key mode remains unavailable. This RPC is undocumented and may change without
notice; failures use the existing typed quota-fetch errors.

### Kimi connected accounts (0.3 development)

The unreleased Kimi service owns regional device sign-in, manual Code/platform
keys and explicit import of the selected Machine's Node Kimi login. Import reads
the resolved `KIMI_CODE_HOME` config and its exact selected OAuth credential
reference; it neither scans profiles nor falls back to the retired Python home.
The daemon refresh callback retains refresh custody. Only explicit invalid-grant
evidence requires reconnect; policy refusals and inconclusive refresh outcomes
retain their provenance without declaring the grant invalid.

`KIMI_CONNECTED_ACCOUNT_LAUNCH` feeds the existing native-home engine for Session
and finite execution. Its private config references the selected current access
token through `HAPPIER_KIMI_ACCESS_TOKEN`, omits OAuth references and preserves
shared session state. The selected credential's model response supplies the
native catalog; an unavailable selected default returns
`model_selection_required`. Resume checks use the declared session-file catalog.
Static access expires normally, so a running child can need reconnect/relaunch.
Actual installed-Node subscription routing remains a release-validation check;
the fake-process composition does not prove vendor acceptance.

Native consumers can request Code-key material and its regional Chat/Responses
or Anthropic base URL from this same service materializer. An OAuth grant or
Moonshot platform key cannot satisfy that Code-key request. The native Kimi
access-token delivery remains separate, and neither route receives refresh
credentials or starts another login.

Code OAuth and native-import consumers can also request `KIMI_CODE_BASE_URL`
alongside `HAPPIER_KIMI_ACCESS_TOKEN`. The stored account's `apiBase` selects
the endpoint; the configured region supplies it when no stored base exists.
`KIMI_API_KEY` remains restricted to Code API keys.

Demanded identity and usage retain upstream observations, including every
supplied window/reset and separate extra-usage money. Missing allowance stays
unavailable. Request auth produces selected headers, actual expiry and scalar
base/domain/device facts for the gateway adapter; it adds no executor or refresh
scheduler. Manual keys retain token kind and have no OAuth expiry or refresh.

The connected-account quota reader also reads Moonshot platform-key balances
through the stored regional API base at `/users/me/balance`. It reports the
available balance once (USD globally, CNY in China), with no inferred cap or
reset, using the existing daemon quota coordinator and typed fetch failures.

### Oh My Pi native account delivery (0.3 development)

Oh My Pi's connected-account purpose rows feed one preparation path for model
listing, Sessions and finite Runs. They consume Kimi Code key/OAuth material,
separate xAI subscription and API-key outputs, the Muse subscription bundle or
Meta key, Gemini key or file-backed Vertex service-account material, and
compatible GitHub Copilot tokens. Existing Claude/OpenAI routes and explicit
Provider bindings remain available. Mode alternatives share one service purpose.

The host prepares the private native home; the existing Oh My Pi serializer
writes environment references into `models.yml` so selected material takes
precedence over stored login. Refresh credentials stay with the service owner.
A new Session with a selected account requires an explicit model and otherwise
returns `model_selection_required`. Source composition tests use a fake ACP
child; installed vendor acceptance remains release-validation evidence.
Antigravity, Devin and Cursor delivery remain pending their native-mode proofs.

### Connected Account sign-in placement (0.3 development)

Portable authentication shares one plugin exchange and one authentication-attempt
owner across the app, daemon and CLI. The UI authentication host chooses placement
at attempt start. Expo and Tauri use their native HTTP host locally. A web browser
uses its existing local OAuth path unless the mode explicitly declares
`browserReachability: 'unreachable'`. Only that declaration uses the existing
selected online Machine owned by the person and its authentication admission. The Machine must
advertise `connectedAccountAuthentication` V1 in its existing operation-capability
record; its installed authentication runtime owns that advertisement. Package
versions do not establish this support. Unsupported picker rows show the existing
Machine update indication. If only unsupported Machines are online, setup asks
the person to update Happier there or use the phone or desktop app before Continue.
The shared sign-in support decision also consumes the inventory's published
custodian scope: this sign-in picker offers only the person's own Machines,
omitting its “Shared with you” group, including Use and Manage grants. A retained
selection of another person's Machine explains that only its owner can sign in
on it. The shared Machine selector is unchanged by default for
other uses, and Home remains the authentication admission owner. When
Machines supporting this sign-in are online but none is selected, setup points to the existing Machine
picker before Continue. With no usable Machine online, setup explains the
requirement and offers the phone or desktop app. Home does not
proxy vendor tokens. Paste, callback and recovery remain addressed to the original
attempt's Machine, retaining that owner's state and PKCE; transport failures
surface through the existing typed results without automatic retries.

Among portable OAuth modes, only Claude OAuth declares `unreachable`: independent credential-free preflights
on 2026-11-05 returned HTTP 403 and HTTP 400 without Access-Control-Allow-Origin
for the required JSON POST. Codex device OAuth's HTTP 530 is inconclusive;
Cloudflare's rejected unregistered preflight does not establish the behavior of
its per-client registered origins or CORS-safelisted POST. Antigravity and Codex
authorization-code OAuth allowed the tested origin in preflight. All four modes
retain browser execution without a declaration; an unknown result introduces no
new placement restriction. Positive preflight is not proof of a successful
credential exchange. The evidence and limitations are in the
`connect-uncertain-1105` audit lane under the amended “Portable sign-in placement”
ruling. Established-credential refresh placement is unchanged and separate from
this sign-in/reauth decision.

Plugin failure diagnostics survive the shared attempt owner's non-reconcilable
outcome response. Claude's known HTTP refusals and credential identity mismatches
are conclusive results; only a lost exchange response remains outcome unknown.

Retained Sessions resume with their admitted Connected Account binding from
owner metadata. A cross-Agent transition clears the departing Agent's binding
and resolves the target through `resolveSessionSpawnConnectedServicesDefaultsPayload`,
the same Account-purpose default owner used by fresh creation. An existing
Connected Account is not selected merely because it exists. Without a selected
target account, Provider or Team route, native sign-in is required on the Machine.
An `agent_signed_out` resume retains the shared launch diagnostic and request
identity through `session.open` and a committed `session.agentTransition` result.
The composer offers the existing Machine Agent sign-in recovery; the Action
diagnostic also explains selecting a Connected Account or configuring its default.
Neither refusal changes the committed target or discards pending input.

### Native subscription consumers (0.3 development)

Agent declarations own which Connected Account purposes appear in the shared
UI and Actions. Their declared credential kinds also determine account
availability through the shared inventory projection. Only a known kind outside
the declared set excludes an account; an unknown kind retains its health status
and can be selected without a fabricated reconnect requirement.
Authentication and refresh results may report an actual `credentialKind` fact;
the shared settlement and refresh writers persist it as credential metadata
`kind`, and the inventory producer projects that fact. The canonical legacy
authentication-mode classifier remains a fallback for recognized prior records.
Other kindless records remain unknown and selectable until a real refresh or
reconnect supplies the fact. Pickers never infer kinds from a service or mode.

Kilo uses its native OpenAI auth-loader hook with Happier's
qualified request-auth client: each Responses request obtains an access token,
and Happier retains refresh ownership. Native ACP resume remains available;
pre-switch reachability cannot be attested from Kilo's current SQLite store.

Oh My Pi's Claude purpose accepts OAuth, native-import and setup-token accounts
through `ANTHROPIC_OAUTH_TOKEN`. Its native ACP and model commands are `omp acp`
and `omp models --json`. DeepSec's finite Claude reviews use the same access-only
materialization contract, mapped to the native Claude SDK environment; an
explicit Codex or mixed harness is refused for a Claude binding. Both audit
stages share the admitted launch material. Neither integration receives refresh
tokens. These static credentials are rematerialized on a new or restarted run;
they do not renew inside an already-running native process.

In 0.3 development, Oh My Pi's purpose rows in
`packages/plugins/ohmypi/src/agent/auth/services/accountPurposes.ts` own native
account delivery. The same preparation serves model listing, Sessions and finite
Runs. Service plugins produce the credentials; OMP consumes their outputs without
copying their codecs or taking refresh ownership. Subscription and paid-key
purposes remain distinct, including xAI's separate native drivers and Muse's
subscription bundle versus Meta inference key.

The host prepares the selected native home. OMP's existing native serializer
writes credential environment references into `models.yml`, so stored native
login cannot override the selected account. Named native profile overrides are
removed for that launch. The existing home overlay preserves native YAML settings
and extensions while keeping auth databases, local environment files and selected
model configuration private. Native-default launches retain their original home.
A fresh selected-account launch requires an explicit model or returns the typed
`model_selection_required` failure. Native candidate catalogs remain unverified
until the canonical account catalog owner establishes account usability.

Antigravity, Devin and Cursor require their receiver-specific credential and
transport proofs before OMP purposes are activated. Vercel deployment credentials
remain ineligible for inference; an AI Gateway connected-account producer is
still required.

FX's Codex route has no built-in default model. A ChatGPT Connected Account
requires a resolved, nonblank model, including an inherited finite-run model.
Without one, its shared Session, terminal, finite-run and preflight preparation returns the typed `model_selection_required` startup
failure reason before acquiring credentials or launching FX. Native-unbound
launches keep their native model preferences.

FX uses the host-prepared native home and shared session state. Its released
0.0.14 parser requires an auth file containing account identity, expiry and a
nonempty refresh field, so the codec writes the access token with an unusable
refresh sentinel. Only Happier can refresh the account. FX requires restart and
rematerialization after expiry; writing a new file does not prove live adoption.
ACP, detached and terminal launches use the same preparation owner. In 0.3 development,
connected resume recognizes both the v0.0.14 session layout and the sessions-v2
layout used by FX revision `481104fdbc24`. V2 continuity retains the selected
session's log, lock and directory, including referenced blobs, through the existing
native state importer. Both `.fx/sessions` and `.fx/session-files` are materialized
as real directories: FX 0.0.16 rejects a symlinked companion directory during
ACP load, even when the v2 journal is present. The shared materializer creates
missing native state directories privately and sets real-directory destination
roots to `0700` on POSIX when importing them, including on rematerialization;
it does not recursively change existing native homes.

In 0.3 development, FX Provider bindings also use a private
`HOME/.fx/settings.json` to select an `openai-chat-completions` endpoint and model.
Bearer credentials use a child-only environment key; credential-free endpoints
remain credential-free. Native settings and shared session state follow
`FX_STATE_SHARING`, and custom routing headers are unsupported. In 0.3 development,
Session-bound Provider launches retain a real native HOME across Stop and resume.
Provider configuration is removed on launch cleanup; the native journal and blobs
remain in that Session's home. Replacement launches retain those writes and own
their configuration cleanup. Connected Account rematerialization likewise retains
writes made inside its real native state directories. The characterized native
contract is upstream source `481104f`; loaded native verification remains required.
The exact Vercel contribution, template and URL retain FX's native
Vercel gateway route.

Before a Provider-bound FX spawn, native status must confirm authentication,
credential source and the selected model. A refusal retains
`fx_provider_credential_source_mismatch` and carries a fixed verification-predicate
code in the existing `failureCause` diagnostic; native output and credential
values are excluded. Status failures distinguish a nonzero exit (with its numeric
exit code), truncated output and an invalid status response. Exec launch refusals
and cancellation retain their original cause instead of becoming authentication
verification failures.

Provider config parents remain private (0700 on POSIX), including when state
sharing created the directory before config projection. FX ignores an unsafe
profile directory and can report `UnknownConfiguredProvider`.

Grok Provider-bound ACP authentication selects the advertised `xai.api_key`
method from the admitted binding. It does not depend on seeing the key in the
request environment: the host supplies the credential in the finalized native
launch environment. Native Connected Account authentication keeps its selected
subscription or API-key method. A native CLI that does not advertise the selected
method refuses with `grok_auth_method_unavailable`; it never switches billing
modes.

Devin retains its vendor-managed login. Its documented
[authentication](https://docs.devin.ai/cli/enterprise/devin-auth) uses a Devin
account and vendor credential file; the current public contract supplies no
Claude or ChatGPT bearer injection seam. DeepSec's native Codex login is also
retained: managed ChatGPT home acquisition is not exposed to that delegated
execution runtime. These paths do not advertise unsupported Connected Accounts.
Account-backed turns, renewal and resume remain live validation work; native
source inspection and dummy probes do not establish billing or entitlement.

### Vercel AI Gateway (0.3 development)

The development Provider plugin in `packages/plugins/vercel-ai-gateway` declares
Anthropic Messages at `/claude-code`, Responses at `/codex/v1` (shared by Codex
and OpenCode), and Chat Completions at `/coding-agent/v1`. It uses the ordinary
API-key connection/Saved Secret flow and remains hidden in the model picker by
default under the shared aggregator policy. The dependency owner has registered
the package and importer together; generated bundled declarations still await
the publication owner's integration pass.

Its public `/v1/models` parser is plugin-supplied through `catalogParsers`, not a
host Provider-id branch. Only language models enter the chat catalog; context
windows and explicitly advertised reasoning-effort values become canonical model
descriptors. Missing control metadata remains unknown, and budget/toggle controls
do not invent effort tiers. The SDK exposes Protocol's existing effort vocabulary
and builder for bundled and external parser authors alike. Vercel's catalog has
no structured default; the builder applies Happier's shared selection policy.

The [published development guide](../apps/docs/content/docs/agents/vercel-ai-gateway.mdx)
covers setup and limitations. Real keyed Claude Code, Codex and OpenCode turns,
including Codex model discovery and effort application, remain release checks
requiring a Vercel tenant. OIDC refresh and Sign in with Vercel are outside this
integration. The connection detail's Usage section renders credit and
lifetime-spend observations through the shared usage meters described below.
Tenant-backed and light/dark/phone acceptance remain separate validation work.

### Cloudflare AI Gateway (0.3 development)

The development integration uses the ordinary descriptor-backed connection,
Saved Secret, Agent compatibility and Team source owners. It has no Cloudflare
runtime, router, Connected Account or usage meter. The initial catalog is manual;
local binding readiness is not a remote authentication result and unsupported
probe/refresh requests make no vendor call. Runtime and tenant evidence remain
separate from declaration and documentation presence.

The fixed Messages endpoint requires a connection address under
`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` and an
unprefixed Anthropic model id. Under the approved pass-through contract, Claude
uses the user's real Anthropic API key in `x-api-key` and a separately bound
Cloudflare token in `cf-aig-authorization: Bearer …`; it sends no provider
Authorization header. The primary `apiKey` slot is the gateway token and the
Messages transport declares its additional `anthropicApiKey` Saved Secret.
Gateway-only, placeholder, stored-key and Unified Billing Claude modes are not
offered pending the named real-tenant release check. Cloudflare's
[Anthropic contract](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/)
documents the distinct provider and gateway headers; native feasibility does not
establish tenant acceptance.

The contribution also declares native OpenAI Responses at
`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai`, using only the
gateway token and an unchanged, unprefixed OpenAI model id. Installed Codex
0.162.1 on Linux completed isolated streaming/tool continuation with this
configuration, including native model listing without a remote catalog GET and
explicit reasoning effort. This establishes native feasibility, not Cloudflare
entitlement or model quality; the pairing remains experimental. It uses the
existing Codex adapter with no OpenAI key or ambient native-auth fallback.
OpenCode's Responses declaration/materializer requires an Authorization bearer
key and refuses this gateway-only contract through the shared matcher, before
native launch. Other Agents still
need their declared credential/protocol intersection.

Account Chat is declared at
`https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1`, with an explicit
`cf-aig-gateway-id` public header and Authorization bearer token. Its model id
keeps the `author/model` or `@cf/author/model` spelling. OpenCode 1.19.0/Linux
completed an isolated streaming Read/tool-result continuation using
`openai/gpt-4.1`; its native title request preserved the same policy too. This
proves that native configuration, not vendor entitlement or Workers AI model
tool capability. Other Agent/model combinations remain unmeasured, and the
manual catalog and unknown capability facts keep consent experimental. The
[account REST contract](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
bills third-party inference through Unified Billing; it does not promise the
native endpoints' stored-BYOK behavior. These
families have distinct endpoint/auth/model contracts, so an ordinary address
override cannot switch between them. FX cannot preserve these custom routing
headers, and Gemini's protocol requirement remains. Copilot's current native controls cannot preserve
the required custom routing/privacy/billing headers; its Responses candidate
is not offered.

The request defaults are `cf-aig-collect-log:false`, `cf-aig-skip-cache:true` and
`cf-aig-no-wholesale:true`. These are deliberate public policy, never secret
transport. They suppress stored logs, bypass response caching and retain the
third-party prepaid-billing restriction respectively; upstream prompt caching,
Cloudflare exports and upstream retention are separate contracts. See Cloudflare's
[logging](https://developers.cloudflare.com/ai-gateway/observability/logging/),
[cache](https://developers.cloudflare.com/ai-gateway/features/caching/) and
[billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
contracts. An account-wide
AI Gateway Run token can reach every gateway and their stored keys in that
Cloudflare account, as documented by
[Cloudflare](https://developers.cloudflare.com/ai-gateway/configuration/authentication/).
Account Chat separately requires Workers AI Read; do not widen a token or
substitute a deployment credential. No Cloudflare balance or actual-charge API
is established by this integration.

### Connection usage and credits (0.3 development)

Optional `usageSources` on the canonical Provider contribution declare an endpoint
template, origin-relative GET path and plugin-local parser. Plugins register
`usageParsers` through the same activation/registration owner as catalog parsers;
the parser returns the existing Q1 meter shape, not a second balance model.
The runtime registry admits the declared parser once per finite probe or usage
read. That operation keeps its captured implementation through HTTP or command
completion; plugin replacement or withdrawal affects the next acquisition.
`providers.usage.refresh` reaches the selected Machine's admitted Provider HTTP
client and returns existing Provider Account Usage snapshots per source. No
background polling, Session ledger or Account-settings observation writer is added.
The shared Action classifies this as a safe read on every surface, without default
approval. Explicit approval preferences still apply to a person's Refresh action.

A source can declare an optional separate `billingCredential`, including a Saved
Secret slot and permitted transport. Account and Machine binding writers validate
that slot against the declaration. It never replaces the inference credential.
An unbound billing slot yields `not_configured` without a request or account-credit
meter; the host never falls back to the inference key. Each source captures its
credential and declaration authority at admission. Its finite read keeps those
facts through completion; later edits affect the next acquisition, while Account
identity and local cancellation still apply. Snapshots use provisional source-local
identity, not an inferred shared billing Account or a fabricated Connected Account revision.

OpenRouter's ordinary key supplies day/week/month/lifetime spend and its optional
key allowance through `/api/v1/key`, labelled **this key**. Its separately bound
management key supplies account credits through `/api/v1/credits`. Vercel uses
its ordinary key for `/v1/credits`, producing remaining USD credits and lifetime
spend from that one response. Unknown caps stay null and reported negative
balances are preserved; neither becomes a fabricated percentage or zero.

DeepSeek contributes `/user/balance` through the same admitted GET and
plugin-parser path. Each `balance_infos` entry produces a separate balance
meter with its reported `CNY` or `USD` currency; granted and topped-up balances
are already included in `total_balance` and are not added again. The existing
meter's optional `currency` presentation field takes precedence when formatting;
older `unit: 'usd'` meters without it still mean USD. CNY uses the existing
neutral `unknown` unit so an older reader cannot mistake it for dollars. No
conversion or cross-currency total is produced.

`ProviderConnectionDetailScreen` mounts `ProviderConnectionUsageSection` for
connections with declared usage sources. The section groups money rows by
**This key** and **Account**, shows the observation date and Refresh, and binds
separate billing credentials through the existing Saved Secret controls. Its
resource dispatches through the real Action client and rejects stale
Account/Home/Machine/connection lifetimes. First presented demand acquires once;
overlapping settings and expanded model-source detail consumers share that
request at the existing account-usage resource owner. The key includes the
current Home, Account, Machine and the usage source, endpoint, parser and selected
credential facts consumed by acquisition. Connection renames, presentation-only
declaration edits, revision-only changes and unrelated credential slots preserve
the shared observation, including across focus changes and consumer remounts.
Hidden demand starts nothing, and the last remaining demand owns cancellation.
Ordinary refresh/failure retains dated last-known-good facts; credential or
authority retirement clears them. Automatic acquisition uses the executor's
non-interactive presentation constraint: when policy requires approval, it stops
without creating a prompt. Explicit Refresh retains the normal approval policy.

A committed usage push with captured `providerConnectionId` and `machineId`
invalidates only that connection's current authorized observation. It refreshes
while demanded; otherwise the next presentation acquires. The socket's captured
Home/Account fences the hint. Legacy/native usage without the exact source
continues to invalidate usage queries without inferring a connection from
current Session metadata. There is no timer, TTL, retry loop or background poll.
In the 0.3 development picker, the source browse pane shows one balance or allowance,
its observation date, Refresh, shared approval status and a link to the connection.
It uses the same usage resource as connection settings, without a billing read
per model or for collapsed sources.
Ordinary Agent Session cost remains owned by the existing Session usage-accounting
path, not this connection summary.

The Provider's optional `requestCost.endpointTemplateIds` and registered
`requestCostParser` extend that same contribution/activation owner for observed
terminal charges. OpenRouter declares its Chat Completions endpoint: the existing
external broker reader passes terminal JSON or final SSE usage to the plugin's
decoder, which reads `usage.cost` and ignores `cost_details.upstream_inference_cost`.
The admitted terminal DTO carries optional `reportedCostUsd` to the existing Team
usage writer with `costSource: 'provider_reported'`, USD and no stored estimate.
Its immutable request admission retains actor/resource/group attribution and
idempotency. Ordinary Session Agent observations remain their accounting owner;
the external observer does not book their requests a second time. Existing
price estimation and cost-mode projections remain authoritative for estimates
and selection between cost facts.

Reported per-request charges are supported only for OpenRouter Chat Completions
traffic through the external Team credential broker, not ordinary Agent Sessions.
Missing or aborted terminal usage stays unavailable; an explicit zero
charge remains reported. No Gateway compatibility-route `usage.cost` contract
was established in the current official Chat Completions, coding-Agent and
[generation-lookup documentation](https://vercel.com/docs/ai-gateway/observability-and-spend/usage).
The documented asynchronous generation lookup is a different operation and is
not polled here. Vercel AI Gateway requests and native Claude/Codex/OpenCode
requests have no per-request reported charge through this integration. OpenCode's
native `info.cost` remains an estimate; native API-equivalent cost is not charged
Gateway spend. Neither
this decoder nor account-balance reads expand Team cost-limit coverage.

## User experience

Users manage model sources under **Settings → Providers**. A provider connection may be a built-in plugin contribution or a custom OpenAI-/Anthropic-compatible connection.

The normal flow is:

1. Open **Settings → Providers**.
2. Enable a built-in provider or add a custom provider connection.
3. Bind an API key through Saved Secrets when the provider requires one.
4. Test the connection on the machine that will run the session.
5. Select one of the provider's models from the grouped model picker for a compatible Agent.

Provider setup is intentionally separate from session launch. Once configured, users choose a model rather than repeatedly choosing or re-entering a provider.

In 0.3 development, a contributed connection’s **Manage plugin** menu action opens the contributing plugin’s existing Store detail page. Its Update/review owns the current-to-proposed version and access changes; opening the link never starts an update. Providers remain plugin contributions, not a separate registry kind or revision-comparison surface. Custom connections and opaque contribution identities have no plugin destination.

In 0.3 development, saving an API-key connection with a selected Machine runs
the existing Provider probe once. The save remains committed when verification
fails, and the Action returns the probe's typed refusal on the connection.
An answered probe supplies the Machine's published health summary. Without a
Machine, or when the network cannot verify the key, the connection remains
Not verified. Enablement grants access to the configured source; it does not
attest credential health. Contributed and custom connections share one verification owner across UI,
CLI, plugin SDK and Machine RPC adapters; no additional credential validator
or retry timer participates.

In 0.3 development, Saved Secret readiness is decided by the materializer for
the admitted Account snapshot. Connection descriptions, model picker projections,
probes and Session launches consume that materializer; they do not infer readiness
from a matching Settings object in the daemon. An unavailable catalog retains its
typed retry recovery. A missing binding retains the add-secret recovery, and one
connection's credential failure remains local to its inventory row.

Team defaults and Session model discovery consume the same launch-readiness
owner. Its typed refusal preserves Home's resource repair, unavailability and
policy causes even when the resource projection omits choices and models.

In 0.3 development, `ProviderSettingsIndex` keeps the root as a home over
`ProviderConnectionsSettingsScreen`, rather than redirecting to a connection.
Its rail's All entry returns to the same root; explicit connection and
`newProviderRoute` authoring routes retain their existing owners. The home
consumes the same Account declarations, connections and selected-Machine facts,
including feature and foreign-Home admission. Account connection choices remain
usable without a Machine; local discovery/start and testing retain their exact
target requirements.

In 0.3 development source, header, invitation and Custom endpoint Add entries
open the same shared capability picker. Selecting a contribution or Custom
continues through the existing authoring route; keys, probes and model setup
remain there rather than running during picker browsing. Found/local choices
share the collection's existing exact-Machine enable/start continuation.

The development Add picker groups that selected Machine's found candidates and
local installations before the declared model providers. Its detail data comes
from `providers/catalog/providerDeclarationDetail.ts`, projected from admitted
Provider and Agent declarations: API-key requirements, declared catalog strategy
and static models, source identity and provenance, and positive fits from the
shared Protocol compatibility resolver. A fit can be experimental and names the
declared model used to establish it; it does not attest installation, entitlement
or runtime readiness. Probe-only catalogs may not establish a fit until models
are known. Missing authentication facts and plugin package versions are omitted;
the declaration schema revision is not a plugin version. Browsing performs no
credential materialization or model probe. The detail section composition and
light/dark/phone acceptance remain with the Store UI integration.

Only the rail's presented filter/query controller answers column Actions while
the wide home is beside it. A Settings-search reveal uses the existing page
variant so the requested control remains reachable. Whole-page denied/empty
states retain their pane claim; a populated home preserves its column. This is
a development-source routing contract, not completed visual or release evidence.

Local providers are machine-aware. A detected Ollama or LM Studio service appears for the machine on which it is running; using its models requires that target machine to be authorized and available. Account-only browsing can show declared static and manually entered models without asserting that a local service is running. A local/private endpoint must be enabled per machine before Happier resolves its secret or sends it network traffic.

The CLI mirrors the same ownership:

- `happier agents ...` manages executable Agents and their runtimes;
- `happier providers ...` manages model-provider connections, probing, and catalogs.

## Identity model

### Editor inline suggestions (0.3 development)

Inline and next-edit Provider refusals retain the existing `ProviderErrorV1`
under the language-intelligence `provider_error` response. The editor retains
the Provider code and Saved Secret repair reason instead of relabelling a stale
binding as an unavailable model or a missing credential as a signed-out state.

The editor's `ai.inlineSuggest` query uses the existing Machine language-intelligence
RPC family and executes in `apps/cli/src/providers/inlineSuggestions.ts`, independently
of language servers and coding Agents. Account policy `filesEditorAiSuggestionsV1`
owns opt-in, the exact connection/model, excluded paths and disabled languages.
The Machine checks that policy before Provider preparation, credentials and dispatch,
then checks current policy and source authority again before returning a result.
The request supplies only the active buffer's prefix/suffix, path, language, caret
and version; it cannot supply an upstream URL, header or key. It is a typing aid,
not a `code.*` Action, transcript event or automatic file write.

Provider `inlineCompletion` declarations name an admitted endpoint, origin-relative
path, wire encoding and mode: native FIM, raw FIM template or explicit chat fallback.
The exact model descriptor selects an operation and supplies tokenizer/context facts.
Chat compatibility and a model name alone do not establish support. Native Ollama
uses [`/api/generate` with `suffix`](https://docs.ollama.com/api/generate); the declared
Qwen2.5 Coder 1.5B base checkpoint supplies its three-marker FIM template and
[byte-level BPE tokenizer](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B/blob/main/tokenizer.json).
DeepSeek FIM uses a distinct declared
[`/beta/completions` endpoint](https://api-docs.deepseek.com/api/create-completion/)
and the ordinary runtime credential transport and grants. The operation's path and
encoding participate in connection security fingerprints, so changing them withdraws
the old grant. No host Provider-id branch rewrites a chat endpoint into a beta route.

`budgetInlineCompletionContext` is the shared model-owned context allocator.
For a declared byte-level tokenizer, UTF-8 byte length is a conservative token
upper bound; nearest-caret windows retain complete Unicode characters and fit
context minus prompt overhead and output allowance. The connection's explicit
per-model `maxTokens` setting supplies that allowance when the model declares
none, or overrides a declared allowance within its output/context limits. In 0.3 development, the existing
`providers.connections.update` Action accepts a `modelSettings` patch keyed by
exact model id, for example `{ "qwen2.5-coder:1.5b-base": { "maxTokens": 128 } }`.
This is an explicit preference, not a suggested default. The revision-checked
Account writer merges supplied fields, preserves other models and omitted
preferences, and removes a model's overrides when its patch is `null`. Clearing
only `maxTokens` with a null field preserves temperature and restores any catalog allowance.
Missing context, tokenizer evidence or usable output settings leaves the model
unavailable. DeepSeek's [documented FIM output boundary](https://api-docs.deepseek.com/guides/fim_completion/)
is 4096 tokens; the DeepSeek Pro contribution declares that usable allowance,
so a fresh connection needs no manual output setting. No undocumented allowance
is inferred for the Ollama base checkpoint. The picker admission owner
`getFileEditorAiSuggestionModelEligibility` returns an explicit exclusion reason
and connection/model identity, allowing the UI to link missing-allowance models
to their existing Provider Models editor. The editor's
`useProviderModelGenerationSettings` hook writes through
`useProviderConnectionMutation`, not a separate settings writer or model catalog.
The existing Settings → Providers connection Models page composes that hook in
its Generation settings / Output allowance editor; missing-allowance picker
rows link to the same editor rather than disappearing silently. Rendered/live
journey validation remains part of the 0.3 integration boundary.
Both Account-only and Machine catalog rows carry the same
descriptor with these connection settings applied, without creating a synthetic
Agent or a second model catalog. The picker and Machine inference retain the
same context/output admission checks.

External endpoints reuse canonical connection resolution, fresh DNS evidence,
Machine/Account grants, SavedSecret materialization and pinned sockets. Managed
connections borrow a current explicit Start claim through the existing service
custody owner; inference cannot establish or revive a stopped runtime or issue a
separate background warmup. The upstream server may load a model while serving
the requested completion. A cancelled query cancels its
HTTP lifetime; it does not promise that an upstream Provider will refund work.
Responses preserve insertion bytes and actual reported token usage. An absent cost
stays unknown; no pricing estimate is presented as an actual charge. Upstream error
bodies, prompts, credentials and generated text are not logged by this path.

The development `ai.nextEdit` query extends this same admission/materialization
path. A model's `nextEdit` fact selects a declared `next-edit-codec` operation;
the first supported codec is `rewrite-window-v1`. It encodes chronological
active-file changes and an explicit whole-file target as original/current/updated
sections, through the selected raw completion endpoint. It does not infer support
from a model name or fall back to chat or FIM. The connection's existing per-model
output allowance applies to this operation too. The complete encoded prompt must
fit its declared context after output allowance; history can be shortened at that
boundary, while target text cannot be silently narrowed.

The editor preference selects ghost text with `modelId` and next edit with
nullable `nextEditModelId`, on the same connection. A null next-edit choice can
use `modelId` only when that exact descriptor declares `nextEdit`; an explicit
choice is never substituted. Catalog eligibility and Machine admission check
the requested operation, not either editor capability interchangeably.
The Machine checks that operation's selected id, the separate next-edit opt-in and the shared exclusions before
credentials and dispatch. Only a natural completed response can become a rewrite;
a length stop is refused. Predicted ranges remain data for the editor's guarded
preview/apply flow and never reach a Machine file writer. This is unreleased 0.3
source, with rendered and real-model acceptance owned by the editor UI boundary.

### Provider contributions

`ProviderContributionV1` is plugin-owned, declarative, and immutable at runtime. It contains provider facts:

- stable contribution id and display metadata;
- endpoint templates and their wire protocols;
- public, non-secret headers;
- credential requirements and permitted transports;
- static and/or probed model catalog declarations;
- optional usage sources and their separate billing-credential requirements;
- compatibility capabilities and explicit overrides;
- safe local-process detection descriptors for local providers;
- optional legacy-profile migration descriptors.

The canonical schema is `packages/protocol/src/providers/contributions/v1.ts`. First-party contributions live in `packages/plugins/<providerId>/src/provider/contribution.ts` and are projected through the same plugin contribution registry used by third-party plugins. Built-in providers must not bypass this path.

### Provider connections

`ProviderConnectionV1` is user-owned account configuration. A contribution can have multiple connections—for example, personal and work OpenRouter accounts or two Azure deployments. A connection contains:

- a stable `providerConnectionId`;
- a contribution reference or a fully typed custom-provider template;
- a display name and default/named role;
- account-wide or per-machine endpoint overrides;
- optional model-id-keyed generation settings (`temperature` and `maxTokens`);
- a monotonic revision and timestamps.

Credential bindings, enablement, machine grants, visibility choices, and manual models belong alongside connections, not inside the immutable contribution. Raw credentials remain SavedSecret resources. The canonical schemas live under `packages/protocol/src/providers/connections/**` and `packages/protocol/src/providers/settings/**`.

In 0.3 development, Account connection descriptions distinguish a pending Machine
declaration read (`sourceStatus: 'loading'`) from a settled missing source
(`unavailable`). The Machine declaration reader supplies that lifecycle fact;
presentation adds no delay or fallback declaration authority. Account gateway
descriptions use the shared managed-purpose binding resolver to retain
`managed_purpose_bindings_missing` before a Machine is selected. Provider failure
normalization consumes the shared Action failure carrier and keeps its typed
cause and optional request ID. A daemon cause without a Provider recovery code
remains in `failureCause`, including across a subsequent Action wrapper; raw
exception prose is excluded. Stale Account and Machine grant repairs expose
their respective scope through the Provider error presenter.
Connected Account catalog failures retain their exact qualified Account or Pool
in `ProviderErrorV1.connectedAccountTarget`; saved-connection failures retain
`connectionId`. The existing `review_connection` recovery opens that source's
settings through its route owner, never through a synthetic model-group id.
Connected Account settings currently use the active Home; cross-Home routing
is a separate existing limitation.
Launch and turn wrappers use the same Action cause projector, including causes
carried by `PluginError.data`; Provider errors retain those facts alongside their
recovery code. Broker refusals keep the existing closed reason and optional
sanitized cause. At the Session boundary, the runtime cause reader translates
Provider causes using the phase already supplied by the launch or turn owner.
The optional `actionCause` retains the full original Action diagnostic, including
its phase and uncoded error class.
Native Session causes remain in `SessionRuntimeFailureCauseV1`; neither carrier
includes arbitrary exception context.


Failed Machine endpoint observations in 0.3 development retain the optional typed
`failureCause` through runtime-state persistence and connection descriptions. The
connection presenter uses that observation for both reopening a detail and the
result of Test; the Providers rail consumes the same check through the shared
Machine-check snapshot. Endpoint access describes the configured route, not proof
of reachability. Older observations without a cause remain readable and use the
Provider error-code fallback. This additive development shape requires matching
strict-schema UI and daemon peers; it does not change the runtime-state version.

In 0.3 development, an explicit Account connection model refresh awaits the
existing manual-refresh probe and projects its new observation. Static and
manual model rows remain available alongside observed rows. A failed refresh
returns its typed endpoint cause even when older rows remain available for an
ordinary catalog read. A placed gateway uses the same admitted probe and model
reader on its hub.

In 0.3 development, draft Test admits a missing SavedSecret reference even when
the template requires a key. The Machine draft-probe owner returns the existing
`provider_secret_missing` / `add_secret` result before DNS or Provider dispatch.
The request fields and result variants are unchanged; an older strict daemon may
still reject this incomplete draft, so this guidance requires matching peers.

The 0.3 development storage contract groups connections, grants, bindings,
manual models, visibility/confirmation choices and unresolved migration conflicts
in one private Account catalog owned by `connections/connectionRowsV1.ts`.
`defaultsByAgentTargetKey` is deliberately excluded: the genuine preference is
`providerDefaultModelSelectionsByAgentTargetKeyV1`, with its typed shape owned by
`selection/v1.ts`. A missing connection does not erase selected intent or imply
native fallback. Catalog revision and Account Settings revision are separate
authority facts. Retained `providerSettingsV1` is an import source, not a second
current persistence contract. The canonical importer initializes and rereads the
destination catalog before retiring the retained source and normalizing Settings
history; incomplete cleanup remains explicit. See [private catalog encryption](encryption.md#private-agent-provider-and-connected-account-catalogs-03-development).

In 0.3 development, Account-scoped connection CRUD, Account endpoint and SavedSecret
bindings, manual models, visibility and confirmation persistence use the shared
`connections/accountProviderActionV1.ts` semantic owner. UI and CLI adapters capture
the Account catalog and write through its revision-checked CAS boundary; these
operations do not require a selected machine or fall back to machine-RPC writes.
Machine-scoped grants and bindings, detection, DNS/network checks, probing, loading
and execution still require their machine authority. A successful Account write
does not prove runtime access or endpoint health.

Provider settings read the Account projection independently before requesting
selected-machine facts. A typed machine failure stays in the machine section;
the Account connection and its editor remain available. The rail, header and
Models summary show the Account static/manual catalog's shown and total counts,
independently of machine runtime model counts.
The shared Account catalog projection owns that merge and visibility policy.
In 0.3 development, Account read Actions await the existing catalog initialization
and retained-source transfer even when no catalog observer is mounted. A fresh
Account therefore stays loading until its admitted empty catalog can be described.
The Protocol error classifier preserves machine-offline, timeout and transport
causes with their typed retry recovery. Only malformed successful read responses
become `provider_rpc_response_invalid`; unknown failures, typed refusals and
mutation outcomes retain their own recovery semantics.
An unavailable Account catalog retains `provider_catalog_unavailable` with Retry,
independently of Agent or model-endpoint availability. Authoring route seeds follow
the selected machine identity while its execution target resolves; resolution
alone does not discard the draft, and actual target or Account changes still retire
machine-derived candidate defaults.
After a connection mutation, the canonical Action classification also determines
refresh scope: Account edits refresh active projections on that Home across
machine targets; machine edits refresh only the exact machine. Hidden projections
resume demand when revealed, and foreign Homes are not refreshed by that write.
In 0.3 development, enable and disable operands both require an explicit
`account`, `machine` or `connection` scope. Connection-wide disable clears all
grants; re-enabling the connection explicitly admits Account access rather than
silently choosing a scope. The shared Provider Action placement classification
distinguishes Account catalog operations, Account default settings, and machine
execution; the Account catalog adapter does not own default settings writes.
Approval review uses the existing retained-destination navigation owner, keeping the originating
draft and result custody mounted instead of treating review as a discard.
Provider approval fields come from the shared Action spec and its safe input
projection: supplied names, endpoints, protocol/auth/catalog changes, slots
and placement are visible, including explicit resets. SavedSecret references
and public-header values are excluded. Where inputs contain only an identity
and proposed values, this is a proposed-change summary, not an old/new catalog
diff or an inferred display name.
In development source, a model confirmation's connection reference retains its
Agent target. Team approval readers use that target to demand the application-qualified
entitled catalog and match the existing opaque confirmation source, displaying
`Resource name · Team name` without reading the custodian's private connection.

Development approval floors distinguish a display-only connection rename from
consequential configuration. `providers.connections.update` is safe only for
validated display fields; credential, endpoint, slot, placement, helper-model,
enable/grant and delete operations retain danger and approval by default.
`session.model.set`, including a gateway route switch, stays safe.

The development friendly `happier providers` commands send reads, authoring
previews, mutations, probes and model loads through the same canonical Action
executor as generated Action leaves. Default listing and Account editing do
not request a machine describe. Standalone authoring reads admitted declarations;
it does not acquire the daemon-applied executable plugin runtime. Candidate
review and unresolved local endpoint choices still require machine observation
through the shared contribution-creation placement rule.
Reference-only writes retain its deferred approval result rather than reporting
an unapplied effect as success. Prompted SavedSecret material stays private to
the exact CLI Action and cancellation signal while the existing approval owner
waits; rejection, cancellation or retired origin cannot promote the Secret or
catalog change. Approved promotion uses the incumbent atomic writer. A genuinely
machine-scoped preparation retains its captured local machine and selected
destination; Account preparation adds no machine-placement requirement. Public
API-token relay transport refuses private preparation it cannot consume, rather
than dropping that custody or forwarding the prompted material.

Account placement describes the operation's data owner, independently of the
daemon that executes it. In 0.3 development, an Agent can target any daemon of
its Account for an Account Provider operation; that daemon uses the captured
Account catalog through `connections/accountActions.ts`, without requiring
machine-specific Provider state. UI and current-process CLI Account adapters
also use the captured private catalog. External API-token callers select a
Machine target through the existing Action relay. The server does not decrypt
E2EE Provider catalogs, and there is no machine-less external Account transport.
Older friendly diagnostic snapshots may allocate
a local machine id and read machine facts; that is not an Account placement rule
or evidence of an online daemon.

An Account-only description of an admitted vendor gateway reports process status
and peer reachability as `not_checked`. These facts are separate from endpoint
probe health; a saved placement or an online computer does not prove a running
gateway or that another computer can reach it. In 0.3 development, a
Machine-targeted description reads Running/Idle from the exact gateway
process-custody owner; unavailable observation remains `not_checked`.

The development connection update Action accepts a validated replacement
template only for an existing custom connection, with its captured connection
revision. It keeps SavedSecret bindings and manual models, retains endpoint
overrides whose template ids still exist, and advances the connection revision
through the same catalog CAS writer. Security changes withdraw affected Account
and machine grants; a name-only template edit retains them. A built-in
connection cannot be rewritten as custom through this operation, and a stale
revision refuses without committing the draft.

Agent Models can browse compatible static and manual Provider models without a
machine. `catalog/accountModelProjectionV1.ts` merges the stored Account catalog
with admitted Provider declarations and the selected Agent's actual manifest
`providerRequirements`. Without a Machine, UI declarations come from the existing
bundled-plugin generator; the CLI uses its admitted manifest registry. In 0.3
development source, Machine-targeted UI readers use that exact Machine's admitted
registry projection for installed Agent requirements and Provider declarations.
Team application discovery feeds these declarations into the same broker application
projector used by the CLI. The picker applies the shared model-capability check
to Account and Team rows, including an installed Agent's tool-roundtrip requirements.
An absent Agent declaration or requirements remain explicitly unknown and admit no
source-backed model rows; another Machine or a matching local Agent name cannot
fill that gap. Missing
Agent requirements refuse the projection rather than assuming compatibility.
These rows are `account_unverified`, with unknown load state, unchecked health,
no probe observation and no runtime confirmation. Their declaration fingerprint
is not executable-adapter evidence and cannot prompt runtime confirmation.

Connected Account source catalogs in 0.3 development use the declared exact-account
observation for model membership. A declared observer that cannot supply a catalog
returns `provider_catalog_unavailable`; gateway compatibility declarations cannot
supply account membership. Sources without an observation declaration retain their
static models as `account_unverified` diagnostics. Managed-purpose launch reads the
same catalog owner through the Account-scoped model projection port, so launch and
the picker admit the same models. A selected source model missing from its current
catalog returns `provider_model_not_found`, including during confirmation. The CLI's
`modelManagement/sourceCatalog.ts#projectCurrentProviderSourceModelCatalogs` owns
runnable source-catalog membership for Provider connections and Connected Account
or pool targets. It excludes unverified, stale, hidden and incompatible rows.
Current exact-account observations and ordinary Provider `verified_static` or
`manual` rows remain eligible under the same visibility and compatibility rules.
The confidence rule is shared through Protocol's `rpc/providers.ts`. Native
preflight pickers retain diagnostic rows but apply that rule to the selected
Connected Account's scoped observation before offering choices. Static and
provenance-less cached lists stay diagnostic until a dynamic observation answers;
unbound native lists and explicit current selections retain their existing behavior.

In 0.3 development, retained 0.2 Voice OpenAI-compatible Chat settings import
into the connection's `modelSettings`, not per-prompt Voice configuration. The
spawn resolver passes only the selected model's settings to an adapter that
declares support; otherwise it returns `provider_incompatible_with_agent` rather
than silently dropping them. OpenCode writes `maxTokens` as the native model's
`limit.output` and temperature into its `build`/`plan` Agent configurations,
enabling the model's temperature capability. `limit.context: 0` preserves
OpenCode's existing unknown-context default for these custom models; it is not
an invented context allowance. These are native configuration fields, not model
`options.temperature` or unsupported V2 per-prompt overrides. See the
[OpenCode Agent configuration](https://opencode.ai/docs/agents/#temperature)
and [native schema](https://opencode.ai/config.json).

Distinct imported Chat and commit models retain Chat temperature and the
predecessor commit temperature of 0.2, respectively. When their model ids are
identical, the one model settings entry retains the user's Chat temperature;
the native per-model binding cannot also express a different commit-only
temperature. OpenCode's native output-token ceiling still applies to
`limit.output`. This does not claim arbitrary custom native Agents inherit
the `build`/`plan` temperature setting.
Non-positive predecessor token values remain stored, but OpenCode materialization
refuses them explicitly: its native zero means “use the default”, not a zero-token
request. Unset values leave native defaults unchanged.

### Source discovery policy (0.3 development)

`modelPickerVisibilityByConnectionId` is an optional sparse map in that private
catalog. Only explicit choices are stored. The Protocol policy in
`catalog/modelPickerVisibility.ts` defaults frontier, cloud, local and custom
sources on, and aggregators off. This is presentation policy, not authorization:
it changes neither connection revision, credentials, grants nor an applied route.
Deletion clears the override; duplication carries an explicit choice without grants.

The shared Protocol picker projection in `catalog/pickerProjectionV1.ts`, consumed
by the CLI and Account projection, distinguishes ordinary discovery from explicit source browsing,
management and route consumers. An off source retains exact current, default and
favorite model refs; that exception never reveals its unrelated models or bypasses
the narrower per-model hide policy. Team/broker consumers do not inherit discovery
filtering. Ordinary picker projections also return `hiddenSources` for off
sources with withheld rows or retained exception rows. `modelCount` counts only
withheld rows and can be zero when every row is retained; source-off is the
visibility owner's fact, not an inference from that count. The UI names them
under the model grid and browses one in place through
the same projection with `sourceConnectionId`; browsing never writes a selection.
Rows carry their source as data; the picker shows "· via <source>" only where a
heading cannot (a name present under more than one source, or a Provider/Team row
in Favorites), so identical names are never merged.

Machine model projection carries the containing operation's cancellation and
any supplied deadline through DNS, managed-purpose lookup and cold catalog demand.
A `current_only` read does not launch or refresh a probe. The containing operation
and transport retain cancellation and setup lifetime ownership. Each source resolves
independently; a failed source is identified in `refreshFailures` while successful
sources keep their rows. Refresh reuses the admitted connection facts and reads
new runtime observations without repeating purpose or parser admission. Provider
Actions let this owner settle its result instead of imposing a competing RPC
acknowledgement cutoff; transport setup and caller cancellation keep their owners.

Agent Models management reads exact Account favorite refs and Agent defaults.
Its default-model control uses `providers.defaults.set`, not another Settings
writer or a running-Session transition. Agent effort/options keep their existing
configuration owner and do not add fields to the model reference.

In development source, native, Account Provider and Team model choices use the shared
picker's selected-control owner. A source-backed row supplies its own `modelOptions`;
an equal native model id does not supply or override those controls. An Agent's
optional `reasoningEffortValues` declaration narrows those source tiers to values
its native transport can apply. The shared reasoning projection preserves an
applicable source default, otherwise selecting the first retained tier; the
source catalog remains unchanged. Claude declares its native effort vocabulary,
so gateway-only tiers such as `minimal` remain available to Agents that accept
them and are omitted for Claude. Team discovery
qualifies each read using the same admitted Agent/Provider application projection as
the CLI broker path. CLIProxyAPI's pinned catalog carries explicit reasoning levels
from its SDK registry for both Account and Team projections; budget-only models do
not acquire guessed level choices. These descriptors describe source controls, not
Account entitlement or verified execution compatibility.
Managed catalog refresh attaches those family declarations to observed rows by
qualified upstream purpose and exact model id before persisting the observation.
The gateway's OpenAI model-list wire format does not supply effort options;
declarations enrich observed membership without adding unobserved models.

The development picker applies the canonical required-model-capability decision to
Account, Gateway and Team rows. Models explicitly lacking a capability the selected
Agent requires are excluded; unknown support retains experimental treatment.
CLIProxyAPI's generated catalog marks its pinned SDK image builtins as lacking tool
round trips. The pinned SDK supplies these through image constructors rather than
a modality field in `models.json`.

`providers.models.source_visibility.set` is an Account Action with no machine input.
In 0.3 development, the UI and CLI use their captured Account catalog read/CAS writer;
frontends without that writer refuse the operation before transport. A source
switch also needs the stored connection and its declared kind, never a guessed
default from runtime model counts. No machine-RPC write fallback exists.
An uncertain catalog write requires current-state review rather than automatic
replay; a catalog CAS conflict retains the existing connection-changed recovery.
The shared `resolveSessionRoutePresentation` selector accepts the exact draft or
runtime-applied selection, separately presents pending intent, preserves Team V2
identity and leaves missing applied facts unknown. `presentSessionRouteChip` is the
one owner of the composer chip's words ("Runs through <source>", or "Next via
<armed source>"); without applied or armed evidence it yields nothing and the
incumbent label stays. A route or model picked while the session runs is armed for
the next message exactly like an Agent switch (D15): the session's pending model
selection is the arm, `resolveArmedSubmitPresentation` names it on the send control
("Continue via <source>"), and `resolveSessionComposerSendDestination` returns
`armedRouteContinuation`. The transition owner retains live model picks as intent
without applying them, including their metadata echoes. Ordinary queued input
reads that arm from the transition owner when it has no explicit message-level
model selection. An arm also keeps ordinary mid-turn input in the queue until
the next prompt rather than steering the active turn through the previous model.
Send asks that same owner to apply the selection; only a restart-required result enters the existing
provider-binding restart, then sends through the ordinary path. A replacement
runner alone does not arm an unchanged model selection: the disposition owner
compares intent with coherent applied history while the replacement's metadata
catches up. That history does not authorize active-model or context claims;
those still require the exact current runner's proof. A
same-Agent change carries nothing over as text (`session.agentTransition` rejects a
same-Agent target); it resumes the same session. Mid-turn the send is refused like an
Agent switch, and `session.model.unarm` restores the applied route without sending. A saved custom
connection reopens in the custom editor it was added with and saves through the
`update` Action's `template` replacement; the editor is offered only when the form
can express the stored template exactly. Child Run headers read R2's `resolvedSelection`
("Inherit session · <route> · <model>"). Composed live validation is still pending.

Persisted selections, favorites, drafts, session metadata, fork/resume state, and model-switch requests must use `SessionModelSelectionV1`. A provider model is identified by the exact tuple:

```text
{ agentTargetKey, providerConnectionId, modelId }
```

Native models use the same shape with `providerConnectionId: null`. Never infer a connection from a model id, concatenate provider/model ids into a wire id, or silently fall back to a native model when a connection is stale or unavailable.

In 0.3 development, the Session model-transition coordinator distinguishes an
accepted next-prompt configuration from verified execution. Its configured route
can admit the prompt needed to observe the new model without publishing an exact
Running selection. Startup intent likewise supplies no runtime-application proof.
The existing model publisher follows runtime readback, and a pending Provider
route cannot acquire proof merely because an old process reports the same model
id: confirmation must also preserve the admitted source and materialization basis.
Without an observed current model, the publisher leaves current-model metadata
absent rather than choosing the first catalog entry or a default placeholder.
Prompt acceptance establishes input custody only; it no longer writes a competing
applied-model projection. The UI reads the observed current model and uses the
existing exact source, binding and runner proof to distinguish Running from
Last reported. `sessionAppliedModelV1` remains a read-only compatibility carrier
for retained 0.2 Session data when a modern model catalog is absent.
A child Session can inherit an authorized observed model while a different model
is configured for a future prompt. That read revalidates the observed source and
materialization basis before taking its final current-publisher permit; an unknown
model or withdrawn authority cannot supply an inherited selection.

OpenCode's server-native runtime publishes observed assistant model identity
through that existing host models service on Provider routes too. Its controller
reads exact-session native assistant evidence from the existing live/history
paths (V1 providerID/modelID; released V2 model.id/providerID), not prompt dispatch
or successful configuration. Current remains unknown until evidence arrives.
Only an exact match of both the private Provider id and upstream model id maps
back to the public bound model; other observed models retain their actual
identity. Re-reading unchanged history produces no new model publication and
Provider-bound routes do not enumerate the native Provider catalog for proof.

In 0.3 development, Usage contributions retain the applied Provider contribution
key as `providerId` and its connection identity as `providerConnectionId`, separately
from `agentId`. The Session publisher takes these facts from the validated runtime
binding only when its model matches the observation. Work consumes this accounting
projection; it does not infer a Provider from an Agent logo or model name. Historical
observations without that witness, native captures and unattributed cumulative
remainders return null identities. Custom connections can have a connection identity
without a contributed Provider key. This projection carries no endpoint or credential.

When a caller names a model id but omits the connection, the Session itself completes the tuple: an active Session from the Provider binding actually applied to its running runner, an inactive Session from its persisted canonical intent. That completion has three outcomes, not two. Absent state means native. Valid state means the connection it names. State that is **present but unreadable** means unknown, and the operation is refused with `model_selection_session_provider_state_unreadable` before any transition RPC, metadata CAS, or prompt admission — a corrupted binding or intent is never reported as an explicit native selection.

In development source, ordinary message Actions and Workflow Session sends share
`resolveSessionMessageModel` for native Automatic/reset input. It resolves that
reset before ambient Provider completion and emits no per-message structured
model reference. An explicitly named Provider's literal `default` model remains
a concrete Provider selection.

## Attached child selection (0.3 development)

Attached Happier execution runs use one host-owned selection decision at launch
admission, before Provider and Connected Service materialization. An omitted
model/source choice inherits the parent Session's actually-applied selection;
pending model changes and Account defaults do not replace it. Explicit native,
Provider, Team, Workflow and role choices retain precedence. An explicit native
reset is distinct from omission.

Attached omissions, structured model references and explicit native resets use
the existing Provider-safe ensure/start method with no retained run id. The host
applies inheritance as part of ordinary launch admission, without a separate
inheritance capability flag. The one-way 0.3 upgrade updates all components
together; older Session processes and mixed 0.2/0.3 operation are unsupported.

Native Connected Service inheritance retains the selected account or pool
identity, including a pool rather than its currently active member. It never
copies credentials, activation handles or capabilities. The child rematerializes
that choice under current admission. A different Agent must admit the inherited
source/model through its compatibility adapter; unavailable applied state or an
incompatible choice returns a typed refusal requiring a choice, without changing
models or billing sources.

Workflow admission freezes the origin Session's Connected selection when a leaf
resolves to that same Agent, whether through a Role, a literal engine or an
input-bound engine. Session and detached Run leaves consume that frozen choice;
the Session creator no longer substitutes Account defaults for a literal engine's
omission. Explicit bindings and explicit native/reset selections win. A leaf
using another Agent, or a Workflow without an origin Session, retains its own
explicit choice or that Agent's Account defaults.

Session-caller start admission freezes omitted Launch Profile and Connected
choices from the authenticated baseline for the same Agent on the same Machine.
The rule covers Session spawn, attached execution Runs, Review, planning,
delegation, Voice, Approval reviewer Roles and Workflow leaves carrying a Session
baseline. Role model stamping and an explicit native Provider model reference
(`providerConnectionId:null`) do not by themselves clear Connected authentication.
An explicit Connected selection, native reset, Provider/Team source or child
Account-default choice retains precedence. Fan-out resolves each child's choices
after selecting its Agent; it never applies one child's inherited binding to
another Agent. Inherited account/pool identities are re-admitted against current
credential authority at start; failure cannot silently select native or an
Account default. Run `launchProfileId` carries the Launch Profile separately from
the plugin execution `profileId`.

Root starts and different-Agent Session starts retain Account-default
resolution. Session status exposes `connectedServices` from the authorized
owner selection as a validated, content-free binding object; an unavailable or
malformed owner selection is omitted, never reported as native. Pool choices
carry the pool id without its active member. This read supplies a reusable
selection, not credentials, a grant or proof of current authentication readiness.

The refusal's `details.childChoice` names the child Agent, the parent model
reference when known, and explicit-default/model options. Choosing
`childSelection: 'agentDefault'` through `execution.run.start` resolves the
child Agent's Account default at host admission, independently of the parent.
This differs from `modelSelection: null`, which explicitly requests native
settings. A new attempt is permitted only with `noRunCreated` evidence; a missing
or ambiguous start receipt is not a chooser retry. The launcher mounts
`ExecutionRunChildChoiceCard` through `useExecutionRunChildChoice` for conversation
and bounded Run refusals, offering the child Agent's default, an exact model, or
cancel. This is implemented development source; target-specific handling of
multiple refused Review Agents and composed live acceptance remain unverified.

In 0.3 development, a retained Team model selection keeps its Team source through
prompt dispatch, turn failure, runtime model readback and startup attach. A carried
V1 model projection or a newer process-default timestamp cannot replace that
source. An ambient brokered model-only change with `next_prompt` preserves the
Team intent and reports `intent_updated`. The next ordinary prompt reopens the
same accepted resource and revision for the requested exact model through the
existing runtime replacement path. Child inheritance then reads that runtime
generation's applied model. Immediate, explicit source and vendor-native changes
retain `restart_required`. Explicit changes to native authentication still replace
the intent and clear its accepted Team binding. Resume with a Team intent
but no matching admitted binding refuses with
`team_credential_provider_binding_unavailable`; native launches without a selected
route retain the native sign-in check. A Session whose Team intent and binding
were already removed needs its Team route selected again through the product.

The running composer's explicit un-arm control uses `session.model.unarm` through
`useSessionModelUnarm`. The Session transition coordinator restores its actually
applied model/source through its existing intent writer; callers supply no model
guess. This is development source, with composed live validation still pending.

Detached and scheduled runs keep their own explicit choices or Account defaults.
Resuming a run keeps its retained selection even after the parent or defaults
change; fork keeps its separate explicit inheritance path. In 0.3 development,
Voice uses the Home Team credential model catalog and shared Session picker
sections and account rows for its selected Agent and Machine. Its existing Agent
settings retain exact chat and commit selections, including the Team resource,
revision and delivery mode. A Voice carrier following a Session reads the same
active-route disposition and preserves the Team binding intent. Voice chat and
commit runtimes consume the existing Team Provider launch admission and binding
opener, including isolated commits and retained-run recovery. Team credentials
therefore retain the Provider owner's brokered or direct delivery contract. In the
same development source, `settings.set` at `voiceConversations.chatModelId` or
`voiceConversations.commitModelId` accepts `{source, model}` through the picker’s
canonical role-model binding. `model` is `null` for automatic, a raw native model
id, a Provider-bound reference, or a Team credential selection. Chat sources are
`session`/`custom`; commit sources are `chat`/`session`/`custom`. Scalar model ids
remain accepted for existing callers. Agent changes replay the canonical Agent
selection against current settings, clearing the previous Agent’s model routing
while preserving unrelated concurrent edits.
Automatic child inheritance retains its existing refusal of direct Team custody;
the caller must make an explicit supported credential choice.
Agent-native child definitions retain their Agent's own model rules.

In 0.3 development, a Voice Start refusal retains the typed Provider error through
the runtime, host presentation and Voice Action read. Copy and recovery come from
the Provider error presenter and dispatcher. Review compatibility opens the
Provider detail: select the experimental Agent, then the intended model in the
shared Session model picker and explicitly confirm its existing Action. Return to
Voice and start again. New Session and Voice use the same private Account catalog
confirmation, scoped to the Provider source, Agent, optional model and compatibility
fingerprint; neither a Session flag nor a Voice setting grants consent. Agents use
`providers.models.experimental.confirm` with that same projected confirmation,
then retry their Voice Start. Materialization, incompatibility and credential
transport refusals retain their own Provider remedies.

The execution-run host projects `resolvedSelection` from its admitted launch
record for child summaries. Start, activity, finish and host-loss daemon markers
retain that same projection. Run rows and daemon fallbacks use it with the Run's
exact Home; a predecessor marker without it may use a matching transcript
summary, never an unrelated Session or Account default. That projection contains only source, exact
model references and account/pool binding identities; it is presentation data,
not a second persisted route or credential owner. Drafts read the applied-model
projection for an inherited-choice preview, never the pending selection as proof.
This is unreleased development behavior; composed runtime validation remains
part of the Providers integration journey.

## Protocol and capability matchmaking

DeepSec review Runs in 0.3 development use the same Provider compatibility,
authorization and per-Run materialization owner as other Agent launches. Its
adapter supports credentialed OpenAI Responses through the native Codex harness,
not Chat Completions or Anthropic. URLs must end in `/v1` without a query or
fragment; arbitrary public headers and no-auth connections are refused. The
key is passed only to the child process. An explicit conflicting review harness
returns `deepsec_provider_harness_mismatch`, rather than changing the requested
harness. Unbound review Runs keep their existing gateway path. This does not
add general DeepSec Sessions or Session resume support.

The generic Anthropic-compatible catalog parser and Claude's static model catalog
share the Protocol-owned model-name and effort-option projection at
`packages/protocol/src/providers/catalog/anthropic.ts`. Custom compatible
connections therefore retain catalog parsing independently of Claude plugin
availability.

Providers declare the protocols their endpoints speak. Agents declare accepted protocols and a provider-binding adapter in their plugin-owned runtime. The host computes compatibility; it does not contain provider-by-agent special cases.

The additional 0.3 development adapters use that same owner: Gemini CLI accepts
Gemini wire endpoints, Kilo accepts its declared native drivers,
Copilot CLI accepts Chat Completions and Anthropic, Droid consumes its native
custom-model settings, and Pi and Oh My Pi accept credentialed OpenAI Responses.
Pi and Oh My Pi register only the selected model in a private native home;
undeclared model metadata uses the native owner's defaults. Oh My Pi refuses an
empty public-header value because its native configuration would omit it.
A Chat-only gateway
cannot drive Gemini CLI. Protocol mismatch remains the typed
`no_compatible_protocol` refusal; capability and credential requirements apply
independently. A custom connection may declare a contributed protocol such as
`gemini` through the existing open-protocol template contract.

The standard custom-connection form still offers its existing OpenAI/Anthropic
presets. Gemini endpoints currently require a Provider contribution declaring
`gemini`, or an advanced `providers.connections.create_custom` Action using a
manual `CustomProviderTemplateV1` with that protocol and raw `x-goog-api-key`
transport. Adding the Agent adapter does not make an OpenAI preset a Gemini
endpoint or add a Gemini model-list parser.

Bindings are materialized for the selected Session or Execution Run, with
credentials in child-only environment values and only references in private
native config. They never update shared Agent authentication or model config.
Unsupported native credential/header forms are refused rather than silently
dropping routing requirements. These development adapters use restart semantics;
real Agent CLI and Provider-key acceptance is a release check. Native model
configuration support alone does not establish a safe generic binding for Qwen,
Kimi, CodeBuddy, Grok, FX or an arbitrary Custom ACP definition. See the
[Agent catalog](agents-catalog.md#additional-provider-bindings-03-development)
and the published Agent pages for each native constraint.

The 0.3 development Grok plugin contributes a separate xAI Connected Account
service with device login, a paid API key, and explicit import of one resolved
native auth file. Subscription and paid API selections retain different upstream
bases; a subscription failure does not select a paid key. The service owns the
mode and base facts supplied to request-auth consumers. Native delivery projects
an access-only scoped record into the host-owned selected home, removes competing
auth overrides from copied configuration, and leaves the original native home
unchanged. The daemon retains refresh custody. Actual Grok CLI login, turn and
resume acceptance remains a release check against the characterized native
version. Weekly credit percentages and monthly/on-demand billing amounts remain
separate observations; an undeclared amount denomination stays unknown.

The 0.3 development ChatGPT Connected Account routes are separate from generic
Provider connections. Copilot CLI, Droid and CodeBuddy declare an optional
qualified `happier.agent.codex/openai-codex` purpose. Their normal Session and
Execution Run factories acquire only bearer access and account-id headers from
the existing Connected Account owner. Select an explicit ChatGPT model; arbitrary
model IDs use the Agent's ordinary freeform model selector. The upstream remains
the authority on entitlement, and the host retains its existing known model
eligibility blockers for account groups. These routes do not discover a new
per-account model catalog.
Selected-account inventories for Copilot, CodeBuddy, Droid, Kilo and FX remain
unverified; generated overlays and native lists do not establish account membership. The shared Session publication owner withholds their
model choices and ACP model-option choices while retaining the active model and
explicit native model controls.
Copilot and FX Provider-bound native choices also remain unverified; the selected
Provider model still controls the launched process.
Copilot, CodeBuddy, Droid and Kilo reuse their launch preparation for selected-account preflight.
Without a concrete model, preparation refuses before native startup; choose a
model and retry the launch. Copilot, CodeBuddy, Droid and Kilo retain `model_selection_required`
as the typed startup failure reason through Session status and launch recovery.
Resolved saved helper pins and inherited Session models retain their concrete
model selection; their provenance does not make them a native default.
Changing a process-selected model can report `restart_required`. The shared
Session model coordinator retains that selection for the next ordinary prompt,
reopens through the existing native factory and applies the selected model before
dispatch. It combines a simultaneous permission or restart-setting change into
the same replacement. Unsupported native resume or preparation remains a visible
failure; the prompt is not dispatched through the previous model.
Kilo uses its existing OpenAI model namespace policy for both initial and later
model choices.

The Claude, Codex, Kilo, Droid, Copilot, FX and CodeBuddy plugins consume Kimi
Code keys through their existing native serializers. Kilo, Droid, Copilot, FX and
CodeBuddy also consume paid xAI keys. Codex, Kilo, Droid, Copilot, FX, CodeBuddy
and Qwen use the existing OpenAI-key service. Claude keeps its existing
Anthropic-key route, while Kilo, Droid,
Copilot and Qwen declare their own Anthropic-key purposes. Kilo and Qwen use the
Gemini-key producer, and Qwen also consumes its service-account file and project
facts for Vertex. Producer-exported service identities keep these declarations
attached to the existing account owners. Gateway Provider connections remain a
separate optional choice.

CodeBuddy 2.181.0 does not provide a proven native Anthropic Messages serializer:
its Anthropic environment and custom protocol settings still emit Chat payloads.
Its native Anthropic account purpose therefore remains undeclared. Kimi's external
Anthropic/OpenAI routes require authoritative model context metadata before native
configuration can be written. Qwen's first Connected Account route requires an
explicit model. Its static fallback contains only the native `default` sentinel,
not a vendor model inventory. Model discovery runs the native preparation hook;
the declared freeform selector accepts an explicit model ID for the selected key.
The default sentinel cannot start this route;
account preparation returns `model_selection_required` before acquiring
credentials. Native selection validation retains a non-retryable `client_start`
cause through the spawn result: `model_selection_invalid` for rejected model
selections and `session_configuration_invalid` for mode or option overrides.
Its exact native history-path proof remains unavailable, so
connected-account resume verification returns an explicit unsupported result.
Native inventories and generated single-model overlays do not establish account
entitlement. Frozen native model overlays use the same shared next-prompt
replacement path; their plugins do not own a separate restart controller.

Pi, OpenCode and Codex's qualified-purpose rows own Connected Account delivery in
0.3 development source. A purpose may declare `managedProviderEndpoint` with an
exact Provider implementation identity and upstream purpose. Its optional
`modelIdPrefix` maps an Agent native namespace to the exact Provider catalog id.
CLI callers may also supply a bare catalog model id; shared admission resolves
it against the selected Connected Account. Neither form grants models absent
from that catalog. Shared Provider
launch admission carries the selected Account or resolved Pool member into the
existing managed endpoint acquisition and Agent Provider adapter for Sessions
and finite Runs. It does not create a saved Provider connection. Their shared
Muse purpose uses CLIProxyAPI's `meta-upstream` route; CLIProxyAPI alone supplies
the Muse client identity. The adopted source is omitted from native credential
materialization and follows the existing managed endpoint custody lifecycle.
Managed-purpose launch requires an explicit model selection when the selected
source does not supply a native startup model. A missing selection returns
`model_selection_required` with the existing `choose_model` recovery; an explicit
selection absent from the source catalog remains `provider_model_not_found`.
Admission does not choose an arbitrary catalog model.
Continuation inspection keeps a target without a model selection available so
the person can open its model picker. The launch owner reports the typed
required-model refusal if the person continues without choosing one.

In unreleased 0.3 development, the shared Session model picker and
`agents.models.list` send selected Account or Pool bindings through
`providers.models.projection` using `connectedServices`. The existing Account
model observer supplies membership; the Provider catalog owner intersects it
with the Agent adapter's declared protocols. Managed-purpose refs use the Agent
declaration's namespace. Native custom refs apply the purpose's optional
`nativeModelIdPrefix` (for example OpenCode's provider namespace); consumers
without a namespace retain raw source model ids.
Descriptors and compatibility confirmation scopes retain the source model id.
No saved gateway connection or second observer is required. Static source models
do not establish custom upstream membership. An account kind without an observed
catalog retains its typed native refusal; a verified empty catalog stays empty.
A missing required model returns outer `model_selection_required` from native
preflight and `agents.models.list`, rather than a successful message-only observation.
Agents without a selected source retain their existing model discovery path.

In 0.3 development, managed Provider and plugin Fetch transports project headers
for the decoded response body. Standard compressed responses omit their wire
`Content-Encoding` and compressed `Content-Length` before forwarding to native
Agents; identity and unsupported encodings retain their metadata. Direct managed
Connected Account sources and saved gateway connections share this transport.

The stored native model intent retains its Agent namespace. The shared native
runtime projection configures the admitted binding's canonical model id and
maps that exact model's readback to the original intent; other observed models
remain runtime drift. Startup metadata and carried prompts retain the admitted
Connected Account source and its currentness proof. Selecting a different model
requires a fresh launch admission rather than falling back to native credentials.

Other native purposes consume producer-exported service identities and service
materializations. Kimi Code key delivery preserves the selected region, and
Vertex delivery preserves opaque service-account JSON in a private file with its
project and location. GitHub grants occupy the native Copilot OAuth slot so the
native driver owns the inference-token exchange and seat refusal. An explicitly
selected gateway Provider connection remains a separate choice.

OpenCode's native model inventory likewise does not establish ChatGPT account
entitlement. In 0.3 development, its native route decoder and shared catalog
owner withhold unproven ChatGPT rows and return the existing typed unavailable
preflight result; other usable Provider rows remain available. A running Session
retains its explicit model when only unproven inventory exists, and explicit
model selection still reaches the upstream authority. The current runtime model
snapshot has no typed catalog-reason presentation field; its existing diagnostic
warning carries that limitation without expanding the SDK contract.
An observed native inventory refusal replaces stale cached rows even when the
native account changes within the same probe scope; an unavailable transport
retains the previous usable observation through the existing failed-refresh path.
For a selected native Connected Account, OpenCode requires a concrete native
model belonging to a selected account's declared provider before acquiring
credentials. Selected-account materialization also enables the selected native
providers in the child OpenCode config, so an inherited `enabled_providers` filter
(such as an Ollama-only Machine config) cannot hide an authenticated account.
The same declaration-derived rule covers API keys, request-auth accounts and
Vertex service accounts. Resolved helper and Session model selections remain usable when
inherited. A missing native model could select another provider's saved default,
so preparation returns the typed `model_selection_required` startup reason
instead. The existing nested failure cause distinguishes
`opencode_connected_account_model_required` during account qualification from
`native_model_not_selectable` when the native catalog rejects an explicit model;
both retain the `model_selection_required` startup reason and carry no credential
or model value. Selected-account and Provider-bound Session inventories remain
`account_unverified`; the shared catalog owner withholds their choices while
preserving the active model and explicit model controls. For preflight model
listing, a withheld ChatGPT route does not mark usable models from other native
providers, including Muse, as a failed refresh. A ChatGPT-only inventory retains
its unavailable result. Unbound native launches retain OpenCode's own default
selection.

Copilot writes a private temporary providers file, Droid writes private temporary
custom-model settings referencing a child-only access-token environment value,
and CodeBuddy supplies its native process configuration through environment
values plus private temporary settings that override saved account headers.
CodeBuddy's native product cache is disabled for this route because it would
otherwise persist the access token from the merged model configuration.
None receives a refresh token or adds a refresher, request proxy, or
shared authentication file. Renewed access takes effect on a new process.
Resume reachability is reported by each Agent's continuity hook; an unproven
native home produces an unavailable result rather than claiming continuity.
Real subscription acceptance and loaded-runtime account switching remain live
validation obligations; a dummy endpoint proves serialization, not entitlement.

Claude subscription accounts are contributed by Claude Code, OpenCode, Pi,
Oh My Pi and DeepSec. A custom Anthropic endpoint alone does not establish
another subscription route. Copilot's inspected preamble customization merges
the subscription identity into its native block; Droid's system override replaces
its native instructions. Neither exposes the request-body interception used by
OpenCode to preserve both blocks. Kimi's inspected prefix misses delegated
requests, and Qwen's direct Anthropic driver selects API-key authentication.
CodeBuddy 2.181.0 dispatches custom models through OpenAI Chat or Responses;
its catalogued `anthropic-messages` value does not select a Messages serializer,
and `useCustomProtocol` changes only the URL. These routes remain undeclared.

Kimi's ChatGPT route also remains undeclared:
its custom Responses model requires an authoritative context size, while the
current host launch input supplies only a selected model ID. Qwen's inspected
Responses driver appends `/v1/responses`, which does not reach the ChatGPT Codex
endpoint from its required base URL. Unsupported routes are not represented as
Connected Account choices.

Protocol intersection is necessary but not sufficient. Compatibility also accounts for the minimum behaviors an Agent needs:

- streaming;
- tool-call round trips;
- stateful Responses continuation where required;
- reasoning controls.

The compatibility result is `verified`, `experimental`, or `incompatible`:

- **verified** bindings may be used normally;
- **experimental** personal bindings require an explicit per-Agent confirmation; Team bindings use an informational badge without confirmation;
- **incompatible** bindings are not selectable.

Provider plugins may declare narrow compatibility overrides for known endpoint quirks. Generic host code must not branch on provider ids.

Compatibility and Connected Account suppression use the qualified contributed identity, not a
provider-local scalar id. Legacy built-in scalar declarations are normalized once at Protocol ingress;
they cannot suppress or authorize another plugin's same-named binding.

In 0.3 development, when Provider suppression removes every selected native
Connected Account binding, launch preparation carries explicit none rather than
an empty native-auth intent. An originally empty selection retains its existing
Account-defaulting semantics; unsuppressed bindings and suppression diagnostics
are preserved.

Codex integrations use the OpenAI Responses protocol unless a separately tested adapter is introduced. Emitted Codex `model_providers` fields are allowlisted for the verified Codex version; unsupported or newly documented fields are never emitted accidentally.

## Credentials and endpoint safety

In 0.3 development, `providers/connections/effectiveEndpointV1.ts` is the
canonical owner for endpoint address and public-policy inheritance. Template,
Account and Machine headers merge in that order. A required endpoint override
has no placeholder address; the read projection retains the endpoint with a
nullable address and a setup reason. `addressConstraint` fixes HTTPS origin and
ordered literal/coordinate path segments, `requiredPublicHeaders` makes missing
routing facts unready, and `modelIdPattern` filters wire ids in the existing
compatibility matcher before protocol ranking. The model constraint also travels
in Team recipient source facts. None of these selects credentials or rewrites
model ids.

The `providers.connections.endpoint.set` Action independently patches address and
header facts. Omitted retains; `baseUrl:null` resets only the address;
`publicHeaders:null` or an empty replacement resets only that layer's headers.
A map replaces the selected layer, so removing an entry inherits the lower
layer. Empty override rows are removed. Description carries effective/default
headers, Account/Machine maps and per-header sources for authoritative review
and inherited reset. Endpoint edits retain the ordinary connection revision
check; template defaults and presentation hints do not create an additional
approval digest or stale-edit condition. Duplicate/custom-copy preserves effective policy and its
constraints. Routing, model and effective-policy facts enter the existing
security fingerprints; localized `publicHeaderHints` are presentation only.

Authentication uses the canonical credential destinations, including arbitrary
validated custom HTTP-header names. A transport's `additionalCredentials` names
independently bound Saved Secret slots needed by that transport. Selected-slot
readiness and late materialization must include them; an absent slot never falls
back to a native login or another protocol's credential. Agent
`credentialSupport.requiredApiKeyTransports` declares alternative native API-key
destinations: at least one must match the selected protocol's primary or
additional destination. This keeps a gateway-header-only connection incompatible
with a native Agent that also requires provider authentication. Public header maps
reject secret-bearing names, case-insensitive credential collisions and controls.
`credential.authorityDescription` explains scope without carrying secret material.

GitHub forge credentials are Connected Service credentials, not model Provider
connections. In 0.3 development, GitHub consumers may use the executing machine's
GitHub CLI login through the existing native materialization path; an explicit
Connected Account selection still takes precedence. This does not add a
command-produced credential transport to custom model Providers. See
[machine-native GitHub credentials](plugin-platform.md#machine-native-github-credentials-03-development).

Version 1 supports unauthenticated and API-key credentials. Raw secrets remain in Saved Secrets and are resolved by the daemon only after all non-secret checks pass. Plugins receive credential descriptors/materialization inputs, not unrestricted access to the secret store.

In 0.3 development, `configFile` materialization can request `nativeHome: true`.
The host captures the same leased Agent registration's
`connectedAccountLaunch.stateSharingDescriptor`, applies its existing native-state
copy/link rules, and projects the private root into the child environment. A file's
`merge: 'jsonObject'` applies a shallow top-level overlay during the canonical copy
transform, leaving the source native file unchanged. The existing binding cleanup
and retained-run ownership govern that private root. This matching SDK, Protocol
and CLI contract requires the development participants to reload together.

An unauthenticated Provider remains credential-free through managed-runtime authorization and Agent
materialization: the host carries an explicit no-credential result and never synthesizes a bearer.
A Provider-managed runtime may use a declared `systemTool` only through the existing tool authority:
the operation, immutable Provider declaration, same-plugin tool declaration, executable, and allowed
environment must all match before the daemon resolves or launches it.

The spawn/probe order is security-sensitive:

1. resolve feature gates, the exact connection, and the target machine; reject tombstoned or missing definitions;
2. realize endpoint templates/overrides and derive locality and the endpoint/binding-security facts; configured public Account-enabled endpoints do not require daemon DNS merely to launch an Agent;
3. verify Agent/protocol/capability compatibility and select the credential transport/materialization kind;
4. admit the exact account/machine grant and capture the authorization ticket, selected model and settings once;
5. resolve the Saved Secret as late as possible, with the Home authorizing a shared-secret read against the captured Account scope;
6. materialize the credential into the scoped child environment/config;
7. commit the prepared binding and spawn or probe using the admitted capture, Account scope pin and local cancellation, without repeating catalog/revision/ticket admission.

The endpoint/security fingerprints must exist before an endpoint-bound grant can be validated. No path may authorize by connection id alone and derive the endpoint afterwards.

Daemon and foreground Session admission complete the Provider authorization decision — feature gate, Agent/target compatibility, malformed settings, a changed binding, the cold catalog rejection, and the `agent.resolvePrerequisites` hook — before the requested workspace is created, runner bootstrap material is written, or the Agent Session is opened. A prerequisite hook therefore receives the requested workspace path as a value and must not assume that directory already exists on disk.

In 0.3 development, a managed Session binding is materialized after canonical Session acknowledgement, through the runner's existing managed-binding producer and custody. That producer allows the host to enter Session initialization without an early materialization handoff. For a fresh daemon child, the producer also supplies the admitted binding metadata; existing metadata must still match the selected connection. The returned handoff must match the selected connection, model and materialization before the host publishes the active target. A binding without a late-admission producer retains its early handoff requirement. Later Profile or MCP environment preparation preserves an already-admitted early binding; it does not require that handoff to be produced a second time. Foreground late-environment admission keeps its own producer, and native open never substitutes native authentication when managed preparation fails.

Provider data must never mutate the daemon's global `process.env`. Agent adapters materialize provider settings into the existing scoped child-spawn environment/configuration choke point.

Custom-provider forms do not support arbitrary query-parameter credentials or inline bearer tokens. Rich cloud authentication such as AWS Bedrock signing, Google Vertex credentials, Azure Entra, and command-produced tokens requires explicit typed transports and is outside the V1 custom-provider contract.

Endpoint validation rejects credentials in URLs, unsafe metadata destinations, ambiguous encodings, unsafe redirects, and oversized responses. Redirects are revalidated hop by hop, and credentials are not forwarded across an origin change. DNS is resolved on the daemon for probes, but the spawned Agent may resolve independently; endpoint-bound machine grants remain the authorization boundary for local/private endpoints.

In 0.3 development, semantic configuration admission does not dial a configured
endpoint: an Agent may use its own resolver or proxy. Configured HTTPS endpoints
admitted with Account consent, including legacy opaque Account grants, do not
require daemon DNS to launch. New destination-only grants retain their deliberate
Account or Machine scope without DNS. Legacy opaque Machine grants retain the
DNS evidence required by their existing comparison. Actual daemon fetches still assess DNS,
destination scope and redirects before disclosing a credential. Connection or
declaration changes affect the next admission, not an already admitted finite
personal operation.

A catalog probe carries its containing operation's cancellation and any supplied deadline through pre-dispatch resolution, request establishment and the complete response body across redirects. A managed probe uses its service's supervised request handle. Provider code adds no separate wall, idle, or response-size policy.
In 0.3 development, agents and UI hosts can call `providers.binding.status` with
`{machineId, sessionId}`. The authenticated owner-only Session reader supplies the
persisted launch binding and canonical model intent to the existing daemon
pairing owner. A `changed` result includes `providerBindingSecurityChangeConfirmationV1`
with that Session's exact previous fingerprint and the pairing owner's next
fingerprint, ready for explicit `session.runtime.refresh` with
`mode: 'force_current_cli'`. Reading the proposal does not authorize a restart.
The explicit `selection`/`launchBinding` input used by the Session UI remains
available through the same pairing owner; daemon RPC admission is unchanged.
In 0.3 development, binding-status reads likewise carry the RPC caller's cancellation through Home/catalog reads, registry activation, DNS, Gateway purpose resolution and runtime catalog observation. A supplied deadline returns the existing retryable `provider_catalog_unavailable`; the Session banner offers Retry rather than asserting model incompatibility. Local cancellation retains its existing abandoned/abort result instead of being attributed to an unavailable Provider endpoint or an Agent failure. The existing daemon RPC completion log identifies the stage where a saved probe or binding-status read expires or is cancelled (`failedPhase`, `causeCode`, `phaseDurationsMs`, `phaseTimingsMs`), without logging request or credential contents.

In 0.3 development, the Session's binding-status reader rechecks a newly observed
completed turn only while binding attention is present, so a recovered Gateway
turn can retire an earlier banner without manual Retry. Healthy turns do not
repeat the binding-status RPC. Changes to the selected connection, grants,
secret bindings, model, confirmation or admitted declarations arrive through
the existing catalog/projection push owners and trigger the same reader;
unrelated catalog changes do not. Selection and applied-binding changes and
explicit Retry also retain their reads. Existing attention remains while a read
is pending and clears only when the daemon's binding result permits it;
successful output alone does not override authorization or a continuing failure.

Before the handler runs, shared RPC admission verifies the caller's current Home/Machine access. This phase uses the forwarded request lifetime, including its deadline, relayed cancellation and target disconnect; cancelling a joining reader waiting on shared Account identity does not cancel the other readers. A Home verification refusal retains its typed error code, and both refusal and cancellation produce the existing `[RPC] Request completed` record with `failedPhase: authorize_request`. A missing completion alone does not establish that the daemon never received the request. These diagnostics and cancellation semantics apply to every RPC using the shared admission owner, including binding status.

In 0.3 development, native broker ingress retains the complete request bytes for policy parsing. The
managed-service carrier owns its complete-message size boundary and reports
`plugin_managed_service_request_too_large` with the resource, limit and actual
size. The broker preserves that refusal as HTTP 413 with `request_too_large`.
Relay frame limits govern individual chunks, not the complete inference body.

In 0.3 development, connection descriptions and mutations, Profile migration
admission follow their containing operation's lifetime.
No separate endpoint-probe budget expires a slow Home or registry read in those
operations. Binding-status reads and a local command catalog fallback consume
the containing operation's cancellation and any supplied deadline, without a
Provider-specific response-size limit. Transport settlement during cancellation cannot publish a
successful withdrawal as a completed operation.

The development local-installation advisory consumes the containing description's
cancellation signal, without a separate waiter timeout. A description reports
`localInstallationsStatus: incomplete` if that interest ends before the checks
settle or the advisory is unavailable. Every new inventory reads current OS
evidence; there is no persisted presence cache or advisory TTL, and a failed OS
lookup is incomplete evidence rather than absence.
On cancellation, completed rows remain available, and an uncancellable system-tool
lookup retains its single-flight custody until its real result settles. An omitted status from
an older description supplies no completeness observation.

Provider-source descriptors use the existing managed-service request-header
carrier. That carrier retains its header-value and aggregate envelope limits
and refuses overflow with `plugin_managed_service_request_too_large`, naming the
resource, actual size and limit. A valid source declaration may exceed the carrier;
neither its schema nor the final-hop wrapper adds another descriptor-size limit.

Connected Account currentness conflicts and group-generation convergence also
follow the owning operation's cancellation. Settled credential leases expire or
retire with their exact credential authority. Pending usage writes and durable
failure reports remain queued through temporary disconnection; resident key
counts, elapsed queue age and per-drain batch counts do not discard them.
The existing whole-operation retry, replay, refresh and maintenance policies
retain their typed exhausted, paused or unavailable outcomes.

In 0.3 development source, native group-auth materialization compares the selected
Account, group selection generation and credential revision at its artifact fence.
An inventory invalidation alone does not supersede that tuple. Missing groups,
unavailable group or credential reads, and actual generation or credential
supersession retain distinct closed reason codes through the daemon-to-runner
refusal and the Run failure record. Requester retirement or revocation retains its
own refusal; a group mismatch does not become requester unavailability. A refusal
does not add a retry or grant permission to publish with stale credentials.

In 0.3 development source, Session and detached Run launches share the daemon's
Home/Account-scoped usage store and qualified pre-launch group coordinator.
The pool selector retains raw meter model ids and applies model-scoped limits
only to that requested model; account-wide meters still apply to every model.
Credential-health and model-entitlement exclusions remain independently enforced.
The ordinary daemon switch pipeline combines models used by live Sessions bound
to the exact pool with the model named by a classified failure before selecting a member. A generic
successful quota probe preserves learned model-entitlement exclusions. When
policy auto-disables an ineligible member, the daemon first selects a usable
replacement, then disables the failed member; without a replacement it retains
the active member and its exclusion evidence. Manual member disabling retains
the server's priority fallback.
In that pipeline, a proactive `soft_threshold` switch requires fresh, non-exhausted
quota above the configured threshold on the replacement while the current member
remains usable. When admission excludes the current member, a replacement with
fresh positive quota can restore admission even below that threshold. The quota
precheck and switch pipeline use the same selector. Outside an incomplete probe,
failure-driven usage-limit recovery still allows unknown quota evidence.
In 0.3 development source, a Voice turn consumes the daemon's existing
usage-limit recovery waiting fact and retry date. The Voice stream emits a
short spoken waiting notice and its normal terminal result, allowing listening
to resume while the native Run keeps its admitted recovery. The host carries
that fact through the existing recovery control request; Voice does not retry
or cancel the Run and does not decide provider readiness.
Completed switch decisions use the daemon's default file log,
with profile ids, generations, reason and quota decision trace.
Generation observation and early divergence use those same live-model, classified
model and reason inputs, and log their completion through the same owner.
Superseded reports retain failure evidence on the original profile. They enter
the existing durable recovery scheduler; current-group continuation still passes
its dispatch admission checks. A distinct report can rearm a settled attempt,
while replaying the identical settled report does not run it again.
Provider-directed quota-probe backoff is per-member evidence: selection excludes
only the deferred member and can use a proven alternative. If no alternative is
usable, recovery waits until the earliest relevant provider boundary. After an
incomplete probe, the selector admits only members with fresh positive quota;
an unproven sticky member cannot displace a proven replacement. When no member
has that proof, classified, pre-turn and current-generation recovery use the
existing retryable quota-proof wait. Spawn admission returns the typed
quota-probe-incomplete refusal for that unresolved admission.
Requester retirement does not discard shared Account usage observations.
Daemon Session preparation (including inactive Session control), foreground
admission and detached launches all pass their requested model to that launch
owner; an unborn Session is not resolved through the tracked-Session turn adapter.
A completed pre-launch probe's hard `no_eligible_member` result is authoritative
even when the probe began as an advisory soft-threshold check. Stale quota
observations use the existing freshness/probe owner before admission. In 0.3
development, an exhausted observation captured before its allowance reset is
probed at the next evaluation at or after reset, even while its age is fresh.
An observation captured at or after reset remains authoritative, including zero
remaining quota; no reconnect or repeating probe is required. An incomplete
advisory probe does not manufacture confirmed exhaustion.
Candidate credential preflight uses that candidate's own freshness and health.
An authentication failure on the previous active member triggers rotation without
forcing a healthy replacement to refresh its credential.
When the switch owner refuses all members, spawn preserves its per-member
exclusion reasons and retry boundaries on the typed error. The sanitized error
message includes member ids and reason codes so a bare `no_eligible_member`
does not imply that unknown quota became confirmed exhaustion.
The read-only pool selection and launch coordinator merge accepted Home quota rows
through the usage store's recency owner before using the same candidate selector.
This passive read performs no credential refresh or provider quota probe; missing
observations remain unknown, and confirmed quota exclusions carry their reset time.
Fresh Session and execution-run launches (including Voice agents) allow the
healthy current active member through this same selector. Several Sessions may
share that member without changing the Pool generation. A launch's earlier quota
or authentication observation does not make its later admission a switch-away;
current credential health, quota and model blockers still apply. Classified
failure switches retain the `current_active` exclusion for the member they leave.

In 0.3 development source, Connected Account/Pool Team model catalogs use the
declared source-envelope broker application. OpenAI's API-key application is a
different implementation from the CLIProxyAPI connected-account broker. An
incompatible requested application retains `provider_incompatible_with_agent`
through source discovery and the Team catalog's `incompatible` readiness reason.
This projection does not change grants or use quota exhaustion to hide models.

In 0.3 development source, host launch reads require the canonical purpose-binding
owner to classify an absent or retired subject, unauthorized purpose or service
scope, unavailable target, or unselected binding. These refusals retain their
reason in file diagnostics; none authorizes a durable-default or native-credential
fallback. Ordinary plugin binding reads retain their nullable contract.

In 0.3 development source, Connected Account coordinators enumerate their declared
services with one request to the existing qualified-account list route. An explicit
service set is filtered in the canonical body-free database read, then partitioned
into the existing per-service observed inventories. A scoped demand still reads
only its service, and requester runtimes retain their Account/Home qualification.
These metadata inventories do not replace fresh credential, configuration or
effect-currentness checks. Payload-free caller labels use the existing HTTP
request-purpose header and completion logger.

In development source, transient Account catalog reads and an exhausted catalog
admission or managed-establishment budget return retryable
`provider_catalog_unavailable`. These failures precede an endpoint response and
do not establish an endpoint outage or invalid saved configuration.

## Account scope and machine grants

Public provider connections can be enabled account-wide. Loopback and private-network endpoints are machine-scoped by default because `localhost` and RFC1918 addresses identify different services on different machines.

Locality is derived by the endpoint-safety owner, not selected by the user. A machine grant binds:

- `providerConnectionId`;
- `machineId`;
- a normalized endpoint fingerprint;
- grant metadata/revision.

In 0.3 development, new grants and explicit re-consent write tagged
destination-only fingerprints: endpoint identity, credential disclosure and
Machine locality. Probe, usage and model-catalog declarations, and DNS answers,
do not change that consent identity. Actual endpoint or credential changes still
require consent; a Machine grant cannot authorize another Machine. Legacy
opaque fingerprints retain their original declaration comparison; legacy Machine
grants also retain their DNS-dependent endpoint comparison. Legacy HTTPS Account
grants follow the configured-launch no-DNS behavior above. A stale legacy grant uses the existing
re-consent flow to write the new shape; there is no migration, automatic upgrade
or dual writer. These are grant semantics, not permission to fetch an unsafe
destination: actual network requests retain destination and redirect validation.

In 0.3 development, enabling a public endpoint with Machine scope refuses with
`provider_account_scope_required` and directs the person to enable the connection
for the Account. This scope rule is independent of credentials: an unauthenticated
local endpoint can receive a Machine grant, and a public connection can be configured
before its required key is bound. Missing or unavailable keys still refuse use at
credential admission. A Saved Secret capture failure during an Account catalog
write retains `provider_secret_unavailable` through the Action result and UI,
without writing the catalog or presenting a plugin failure.

Changing a local endpoint invalidates the previous grant. The daemon must refuse before secret resolution with an actionable error when the grant is absent or stale. A connection definition may sync across devices; authorization to use a local endpoint does not silently transfer to another machine.

In 0.3 development, revoking a machine removes that machine's grants, endpoint overrides, and machine secret bindings from the private Provider catalog. Revocation can remove the last reachable machine, so the client captures the Home/Account before revoking it and performs cleanup through the catalog's revision-checked writer, without requiring that machine's daemon or rewriting Account Settings. Plain and E2EE Accounts use their own admitted catalog envelope. An incomplete catalog, stale revision, or unknown receipt leaves cleanup pending; retry reads the current catalog rather than blindly replaying the mutation. The recovering display projection never authorizes a rewrite, and cleanup does not erase default-model intent from its separate preference.

Health, detected processes, discovered model catalogs, and model load state are machine-local runtime observations. They are not synced as account truth.

## Local discovery and process ownership

Local discovery extends the daemon's canonical local-services inventory. A provider contribution may supply a bounded declarative detector using executable basenames and argv tokens. Plugins do not receive raw process inventories, arbitrary callbacks, or regex execution over every process.

In 0.3 development, the inventory reads process facts and listener provenance from
the [one census and ownership owner](cli-architecture.md#census-and-ownership).
Socket discovery remains with local-services; a detector match is not an independent
ownership decision or permission to terminate the matching process.

A process match creates only a **candidate**. Availability requires a provider-owned GET probe, such as Ollama `/api/tags` or LM Studio `/v1/models`/native model endpoints. Generic `HEAD /` success is not evidence that the expected provider is present.

Runtime observations are scoped to the machine and exact provider connection, and are additionally bound to endpoint-template/catalog identity plus the relevant authorization fingerprints. Model-load state binds to the exact `catalogObservationId`. A PID-bearing inventory id is provenance only, so a process restart cannot become connection identity or authorize stale catalog state.

Happier distinguishes:

- **adopted processes**, started by the user or another app, which Happier may observe but never stop or restart;
- **owned processes**, started through the Provider managed-runtime service, which may be supervised according to that owner’s lifecycle contract.

Installed-but-stopped detection and managed start are separate capabilities. Provider managed start is authorized by the Provider feature and connection policy; it does not depend on the Local Services UI gate or daemon inventory snapshot. Discovery alone never grants process ownership.

### Managed subscription-backed gateways

In unreleased 0.3 development, a Gateway is the existing managed Provider
connection. Connected-services listing data and Providers refer to the same
connection id and detail route; there is no separate Gateway catalog. Pools
remain single-vendor. Gateway vendor slots use the connection's existing
`purposeBindingDefaults` and revision-checked update Action. Disabling a pool's
gateway use clears its slot only while that exact pool still owns it; replacing
a slot preserves other vendors. An empty saved configuration is allowed, but
does not authorize an unbound runtime.

In 0.3 development, Machine descriptions and probe admission report an unbound
gateway as `provider_connection_invalid` with the closed
`reason: managed_purpose_bindings_missing`, non-retryable `review_connection`
recovery, and no endpoint request. The Protocol Provider error owner defines
this optional configuration-only reason; the CLI registry owns its projection
for description, access and probe/spawn admission. A missing or deleted
connection still reports `provider_connection_not_found`. This is an unreleased
error-envelope extension, not a new error family, grant or persisted format;
older errors without a reason remain readable.

In 0.3 development source, model rows can carry `gatewaySlots`, the qualified
purpose and configured pool/account target for each slot that serves that model.
The managed CPX model endpoint projects its consumer-admitted purposes from the
pinned SDK registry's exact model support. The existing catalog probe and merge
retain those facts; connection assembly joins them to the resolved configured
bindings before the strict model projection publishes them. A shared model can
carry several slots. Missing facts remain unclassified, including manual rows;
model names and downstream protocols never supply vendor identity. These are
grouping facts, not account entitlement or credential-selection authority.

In unreleased 0.3 development, a managed connected-account purpose may declare
`catalogObservation` with an exact qualified `provider` or `agent` contribution
reference. A Provider source uses the shared account-aware catalog observation
owner and the purpose's declared request-auth use; a native Agent source uses
that Agent's existing model capability. A native observation may declare
`modelIdPrefix` when its Agent selectors include a namespace absent from the
Provider API. The source observation decoder retains that namespace's rows and
removes the exact prefix once, before catalog publication and Agent binding.
For example, Muse's `meta/muse-spark-1.3-contributor` becomes the gateway model
`muse-spark-1.3-contributor`; Team and direct delivery consume the same source
descriptor. Browsing a service needs no Agent when it declares a Provider source. Provider-source current-only reads use metadata and cached
observations without credential acquisition. A successful observed empty catalog
stays empty; only an absent dynamic observation uses the purpose's static models.

Saved Gateway model reads consume the Gateway probe's persisted catalog.
Their `catalogObserved` records that aggregate observation. `sourceCatalogs`
groups its rows by the observed qualified purposes and configured bindings.
Native Connected Account browsing retains its own observation owner and exact
Account requester context.

Before the first Gateway observation, bound families' declared model descriptors
supply catalog and compatibility facts through the shared source-facts owner.
For probe-only declarations, a successful observation then owns membership,
including an observed empty list. A fully declared managed model satisfies the
shared compatibility owner's missing-integration-evidence case. Explicit
unsupported capabilities and declared experimental overrides retain their
existing admission outcomes.

Pool gateway choices and vendor-slot writes use the captured Account catalog
without selecting a machine. Each gateway needs its own admitted declaration;
an unavailable unrelated managed source does not hide an admitted gateway.
Declaration-census completeness is diagnostic, not an all-sources admission gate.
Saved gateway identity comes from admitted declarations: bundled facts remain
available without a Machine, and exact Machine projections supply installed
contributions where that target is selected. Runtime status is a separate fact.
Missing machine runtime evidence leaves status unchecked; it does
not turn the saved gateway into an external Provider.

In 0.3 development, Connected services opens an unsaved gateway draft without a
machine: the Gateways group offers "Add gateway", and a pool's "Use in other
agents" entry seeds that pool's vendor slot when no gateway exists. Opening or
discarding the draft does not write the Account catalog. **Create** submits the
existing `create_contribution` Action for the selected admitted contribution,
including the draft's vendor slots and placement, through the Account catalog
writer and existing approval policy. No gateway-specific Action or approval owner
is added. While any saved managed connection's declaration is unknown, neither
entry offers a new gateway.

A saved vendor slot can retain an unavailable account or pool. Its chooser keeps
that exact selection visible with the unavailable reason; a missing target gets
the invalid repair state. Choose an available target or clear the slot. Saving
the configuration does not establish runtime readiness or authorize fallback to
another credential.

The connection stores optional `gatewayPlacement`: omitted or
`{ kind: 'sessionMachine' }` means the Session machine, while
`{ kind: 'machine', machineId }` names an explicit hub. Saved placement does not
prove hub readiness or local/private model inference. Shared gateway execution
and hub transport are integrated by the daemon managed-services owner; this
configuration contract alone is not evidence that that live journey ran.

In development source, explicit probes and saved model lists on an enabled peer
use the selected hub through the existing Account-scoped Machine RPC transport.
The peer admits its current grant before dispatch and revalidates that admission
before returning the hub's response. The hub retains physical probe execution,
its own grant checks and catalog ownership; the peer does not start a local
Gateway or copy the hub's runtime catalog into its own cache.

Session startup uses the authenticated native broker carrier rather than the
probe's Machine RPC path. Opening its peer-local listener does not prove that
the subsequent stream reached the hub application. In 0.3 development, signed
Account-connection stream admission binds the Home, Account and exact peer/target
identities. Private catalog/purpose reads and shared Gateway acquisition run in
the subsequent HTTP application request, outside native's stream-control deadline,
matching Team source acquisition. The hub admits each endpoint-metadata or
inference request once through Home before source effects. A fresh source open
captures its exact endpoint and credential transport; later requests retain
their own Home admission and acquire the current credential in that source's
pinned slot. Rename and declaration churn do not retire that capture. A source
refusal returns typed HTTP failure. Closing the stream cancels acquisition and releases its joined access;
explicit retirement still ends only the exact signed consumer claim.
In 0.3 development, retirement first withdraws the recipient's published
listener; failure to withdraw still blocks runner stop. One private release
attempt continues under the existing native runtime's custody without delaying
runner stop or borrowing the ended consumer's cancellation signal. Native
endpoint shutdown closes its retained control transport; no Provider-local
release deadline or retry loop is imposed.
Its `[provider-broker-release]` record ends with `released` after HTTP 204,
`target_gone` when the authenticated endpoint differs from the signed target,
or `abandoned` with a closed reason when the remote attempt fails. Each outcome
settles that binding, so retained Session/daemon cleanup never redials it.
An unacknowledged cleanup is not proof of remote retirement: Home still checks
each effect. In 0.3 development, broker source acquisition captures the admitted
resource, account selection and catalog before managed startup. The resulting
operation carries that admission through later requests; neither dispatch nor
an Account-change notification re-evaluates those source facts. In particular,
a publication after startup cannot invalidate the capture that admitted it.
Home's request owner checks whether the admitted job remains active. Personal
Gateway requests consume the same Home activity lookup at each new request;
an inactive answer refuses dispatch without aborting a response already open.
Local cancellation releases the caller's join, while explicit release retires the exact
operation without an additional authorization read. A new acquisition admits
the then-current source and refuses unavailable source reads through the typed
application failure writer. Retained-currentness checks for other consumers
remain scoped to their relevant sources and Connected Services. Saved Secret and Provider
material changes reach direct delivery once through its snapshot subscription;
Team authority, service and recovery facts use the existing Account-change subscription.
Direct-material delivery and withdrawal publish `account/team-credential-material`
through the same Team audience owner. Recipient currentness and demanded credential
list/detail/catalog views consume this fact, including the custodian's other clients.
It does not change source authority and therefore starts no source census. Its
separate coalescing identity preserves any pending `account/teams` authority fact.
These checks add no idle timer or release retry loop.

In 0.3 development, Home's new-Turn credential-binding refusal retains its code
and reason through socket and HTTP publication. The CLI publication owner exposes
that refusal as a typed runtime failure cause. Pending-input settlement ends on
the refusal instead of retrying an impossible publication prerequisite. A withdrawn
Team grant produces `team_access_removed` in Pending and
`session_input_unauthorized` from a waiting Send. Publication alone does not prove
whether a native/direct Agent already acted, so Pending retains conservative
effect-uncertainty recovery. A committed user row proves transcript custody;
waiting Send still observes Pending until delivery settles. The refused original
stays visible and is never automatically retried, while fresh input after regrant
can advance past it. This adds no authorization read or retry policy.

Home checks an admitted Run through its existing daemon attestation on the next
request. It has no Run-end publication to the broker custodian: Home does not
record which custodian a Run used. Stream closure releases its join without
re-evaluating source authority. An unreleased in-memory claim can remain until
an explicit retirement or broker restart; it cannot authorize a later request
for an ended job.
Broker restart loses its in-memory claims; native runtime shutdown retains
responsibility for failed private control closers.
Team catalog admission and the first fresh Home grant finish before the native
connection is acquired. The carrier
consumes that verified grant once, rechecking its expiry after dial; subsequent
streams renew the transport proof for the same admitted job under the containing
operation's lifetime. Renewal checks job activity and carries the admitted
resource, source and application; it does not re-evaluate their currentness.
Endpoint discovery then sends the first stream without another Home read in
between: native's pre-application custody window
owns connections that have not sent any application stream. The Account and Team
adapters publish the captured binding without a post-discovery Home or catalog
read. The target checks that the admitted job remains active on each subsequent
HTTP request. Direct delivery similarly finishes from its admitted
material after disclosure; a new open requires fresh admission. Account/Home
identity, exact destination and local cancellation remain enforced.
In 0.3 development, selected-resource revalidation passes the exact resource id
through the existing Home entitlement read and shared CLI catalog transport;
Team authorization, application compatibility and withdrawal checks still run.
Direct-material reconciliation uses that transport's authenticated-custodian
selection instead of enumerating member Teams. Its candidate-window owner is
shared with the existing exact-source administration read, whose public response
remains stripped of private source and Team details.
In development source,
`providerBrokerEndpointDiscovery.ts` owns endpoint acquisition and failure
classification for both Account connections and Team credentials. The
endpoint refusal reader consumes the broker application's canonical closed-code
schema, including the source Provider's codes. Personal connection errors retain
those Provider codes, and Team launches retain the same cause. External Resource
Test diagnostics retain the exact code in `failureDetail`; the external API's
public error vocabulary remains separate. Matching development daemon and server
readers must be reloaded to consume this diagnostic projection.
Its file-only
`[ProviderBroker] Endpoint discovery refused` record retains a closed
`discoveryCause`, `httpStatus` only when HTTP responded, `discoveryElapsedMs`,
and the per-stream grant's `refreshOutcome` with `refreshElapsedMs` when requested.
The refresh outcome distinguishes an unanswered refresh from an accepted,
refused or failed refresh. Its elapsed time is the completed refresh duration,
or the time still pending when discovery fails.
A refused Home grant refresh, including the first refresh before dial, is retained as
`broker_refresh_refused` before older native transport can turn it into a closed
socket or an HTTP refusal without a broker-code header. Team launch refusals
keep Home's typed admission code across both forms; only untyped transport
failures become `provider_endpoint_unavailable`. Account failures also retain these closed cause/status facts in the
existing `[ProviderBroker] Account connection open refused` and runner dispatch
refusal records. The hub's `[ProviderBroker] Machine stream admission refused`
record distinguishes transport identity, binding, signature, unavailable
resolver/target, target failure and cancellation. Diagnostics contain fixed
classes rather than error messages, URLs, headers, bodies or signed authority.
A missing HTTP
status alone cannot distinguish a rejected stream from a transport failure.
In 0.3 development source, actual Team Session HTTP refusals also reach the
host's existing Session failure evidence. The native HTTP carrier pairs each
request with its response, including reused connections, and reports only the
broker's closed reason and usage-limit headers. The host captures the current
turn when the request starts; a delayed response cannot become another turn's
denial. Local fresh-authority refusals use the same header projection as target
HTTP refusals, passed through the trusted callback's optional `responseHeaders`.
Native validates header syntax and owns status and framing; it does not interpret
the Provider error body. Accepted Home refreshes do not erase an application refusal. Request
and response bodies stay native, and a vendor HTTP 403 without a recognized
broker reason remains unclassified. This path requires the matching rebuilt
Node native addon and daemon source; source changes alone do not update a
running addon. It adds no admission decision, automatic retry or polling.
Account-connection open and fresh-access refusals also retain Home's existing
closed admission reason as `admissionReasonCode` in those file records. The
daemon carries that reason in the existing runner failure cause; the runner's
broker application returns it as its typed refusal code. The outer Provider
error remains `provider_endpoint_unavailable`. An unknown or absent cause still
returns `broker_unavailable`; raw exceptions and signed authority are never
forwarded. This reports Home's decision without changing admission or extending
consumer authority across a transport failure.
On an untyped discovery transport failure, the host reads native tunnel status
once before retirement and adds `closingSide` and `closingStage` to the existing
discovery record. Native status distinguishes local HTTP-head/capability bounds,
stream decision timeout/closure, target admission refusal and pre-application
custody. An older addon or an unclassified transport outcome remains unknown;
the diagnostic never infers a closer from elapsed time. There is no idle status
poll, new log stream, retry or change to the owning control/HTTP budgets.
Compare discovery time with the containing daemon-service request duration;
that request also includes catalog, grant acquisition and binding revalidation.
Its total duration is not a native stream timeout measurement.

The development managed-runtime declaration can opt into
`sharing: 'connectionMachine'`. The daemon's existing managed-services owner
then owns one subscription gateway per admitted Home, Account, connection and
execution machine. Sessions, catalog probes and an explicit Start retain
separate consumer claims; they do not transfer the process to a Session runner.
Each consumer receives opaque access bound to its exact Connected Account
request-auth capability and qualified purposes. A physical management bearer
cannot authorize inference. Releasing one consumer withdraws only its access;
the final consumer and its in-flight requests must settle before idle stop.

In 0.3 development, finite managed startup admits policy once at the public
runtime lifecycle owner before `runtime.start`; policy is not replayed after
service startup or endpoint projection. Explicit Start, Session-demand startup
and catalog startup share this owner. Runtime identity, local cancellation,
resource cleanup and secret-acquisition boundaries remain enforced. Retained
access and later requests keep their own admission boundaries.
Account-connection broker open prepares the actual Machine custodian and
endpoint identities for presence discovery, then authorizes in the final
transaction that signs admission. A foreign initiator's custodian remains
distinct from the requesting Account and its private hub. In development,
Execution Run consumers reuse that signed admission for later carrier streams
until the existing grant expiry; acquiring its replacement is a new admission.
Home verifies the signed Run proof and current Account credential on subsequent
admit calls without repeating Run-authority RPCs or Machine/presence discovery.
New streams retain the carrier's expiry and authenticated endpoint checks;
admitted streams keep their existing cancellation and release lifecycle.
Session consumers retain their own open and admission boundaries.

Connected Account/Pool Team sources have no Provider Connection gateway binding.
In development source, they use the same consumer-access document and process
supervisor under their exact admitted broker operation, not a fabricated
connection or connection-wide sharing scope. Operation retirement withdraws
that access and settles its process without affecting another operation.
Managed source-acquisition refusals record the closed broker reason and,
when available, the existing Provider error code in the daemon file log;
Connected Account/Pool source opens also retain the failed prerequisite
(selection, resource currentness, purpose binding or managed custody) through
the existing application-refusal diagnostic. The optional closed
`sourceOpenFailureReason` also survives the broker-open Protocol reader before
Iroh stream admission, so the shared HTTP/carrier refusal formatter retains the
same sanitized prerequisite. Refusals without this diagnostic remain valid.
Coordinator start failures retain
their closed phase code and a content-free startup cause: error class, known
code, and available child exit code or signal. These diagnostics never record
the caught message, source credentials, stderr or response body, and the public
Test readiness shape is unchanged.

In development source, private Team endpoint discovery preserves a recognized broker refusal code
through the existing Team runtime issue and Session launch-error path. An HTTP
refusal without a recognized reason reports `broker_unavailable`; it does not
infer an audience or credential problem. Account connection consumers retain
their existing outer Provider error.

In development source, a gateway's request-auth lookup follows the containing
native request's deadline and cancellation. It adds no shorter transport-phase
deadline around Home admission or OAuth materialization. Failure reports retain
their existing recovery and quota-report lifetimes.

In development source, a refused request-auth lookup reaches the pinned gateway
SDK as an HTTP refusal rather than an untyped transport error. Its existing
private broker-reason header survives vendor error formatting, and the Happier
application writes the canonical Provider-compatible refusal body. Unavailable
request-auth returns `broker_unavailable` (503); unauthorized, forbidden or
retired request-auth returns `source_unavailable` (403), with no upstream request
or gateway replay. The detailed credential cause stays in the daemon file log.

The side-effect-free connection description reads Running/Idle from this same
process-custody owner, using the current exact Home, Account, connection and
execution machine. The detail page addresses the saved hub, not a different
machine chosen for inspection. Missing authority, unavailable placement or
uncertain process state remains `not_checked`; endpoint health and an online
machine do not establish peer reachability. The current owner reports peer
reachability as `not_checked`, separately from its process status. Reading these
facts neither starts a gateway nor acquires a consumer claim.
Description reobserves the Account catalog without marking an admitted row as
changed. A confirmed catalog change still withdraws authority through the
Account observer; an unavailable read returns a catalog error.

In 0.3 development, Session spawn revalidation waits for an already-running
Account Provider catalog refresh to publish its readable result. It joins that
read's existing completion signal under the launch's cancellation lifetime,
then validates the current connection and grants. It does not start another
catalog read or treat a loading catalog as a missing connection. A failed
refresh still refuses the launch, and optional history maintenance does not
hold readable catalog admission.

The runner keeps its own loopback access endpoint across daemon replacement.
Each new request re-admits the captured binding before obtaining fresh access;
transport failure does not replay inference or substitute another source.
The native Agent can independently retry a broken response stream within its
existing turn. Codex reports that decision with `willRetry: true`; its codec
supersedes unfinished assistant text without resubmitting the host input or
removing earlier completed messages. In 0.3 development source, the host's
stream finalizer reconciles both the durable checkpoint and terminal live
snapshot under the original item identity, including an empty correction.
Loaded outage replay after a CLI host reload remains required; physical
Gateway restart alone does not verify transcript recovery.
An access refusal withdraws that consumer projection while the Session retains
its Provider invocation; later access must freshly authorize before rejoining.
An unavailable exact executable source remains unavailable: retained declaration
attestation alone does not load an older plugin runtime. The chosen-hub path
uses the existing machine carrier and broker with a personal Account-connection
source, not a fabricated Team resource. Its distinct protocol epoch signs the
Home, Account, initiator, target, consumer and application, while the target
daemon admits the current private catalog and purpose bindings. Unsupported
negotiation or hub failure cannot fall back to local execution. These are
development-source contracts; composed live validation remains pending.
The requester may execute its Session on another Account's currently granted
Machine. Both source arms read that initiator's endpoint and presence under its
actual Machine custodian while retaining the requester as the signed Account;
the personal hub must still belong to the requester. Exact Session/AccessKey
admission (or Machine Use admission for a sessionless Run) remains current at
open, refresh and request admission, including after presence discovery.
In 0.3 development, personal and Team opens and refreshes sign inside their
final authorizing transaction; personal request admission also finishes there.
Before the deciding reads, that transaction takes the existing sorted Account
admission cohort with serializing intent: the requester, the initiator Machine's
custodian, and the Team arm's existing resource and Session audience. Custody
and authority are rechecked under those held locks at ReadCommitted. This orders
signing against grant withdrawal and custodian Machine revocation, replacement
and physical Account erasure without expanding those writers' publication
audiences. A signature may be delivered after withdrawal if it was already
created while admitted, but signing cannot follow completed withdrawal.
Both personal and Team opens apply one shared topology rule to the resolved
Machines and endpoints. Coinciding identities return `resource_unavailable`
before signing (and before Team model projection); strict signing schemas remain
unchanged. Team Pool selection applies that same rule before source-eligibility
checks, so an inadmissible initiator member does not hide another eligible peer.

For Machine-placed Provider Actions in 0.3 development, Machine admission resolves
the same native RPC route as the Provider executor. A public Action name is not a
second RPC policy. Raw operations that use the daemon's private Account catalog,
credentials or legacy profiles remain custodian-only, including model listing,
probing, binding status, loading, model-settings mutation, and raw Team-source
request-policy support, resource-test candidate and broker eligibility reads.
Raw connected-service quota-credit consumption also remains custodian-only: it
uses the custodian's recovery state and returns its private quota snapshot. Requester
Account-owned catalog writes keep their separate Account authority.
Foreign Machine Use admits only the existing Team-model worker compatibility
projection; it does not admit generic or competing-source projection of the
custodian catalog. That Team slice neither reads custodian settings nor borrows
custodian compatibility consent; the requesting Account supplies its own consent.
Personal picker, current-selection, source-browse and refresh requests from the
UI use the existing Account Action carrier when the selected worker belongs to
another Account. The shared Provider Action adapter proves the exact Machine
and seals the requester's Account custody to its installation key; an absent key
refuses before raw projection dispatch. The worker's existing Account projection
owner reads the admitted requester catalog rather than the custodian's private
catalog. Same-Account workers and Team worker-compatibility reads retain their
existing paths. This is a 0.3 development contract, not a claim of loaded
cross-Account picker verification.
For a personal gateway placed on a hub, the admitted requester read scope follows
the existing source-read transport. The hub supplies source membership and
currentness without requiring the worker's Agent to be installed there. The
selected worker owns Agent compatibility and launch authorization through its
existing model assembly; ordinary picker output retains one group per connection
and the source's slot presentation. Source load controls and retained
current/default/favorite rows remain available through the canonical projections;
freeform current-selection recovery follows the selected worker's capability,
not the hub's Agent installation.
Ordinary requester projection remains current-only and does not implicitly start
a managed runtime. Explicit Refresh uses the existing forced catalog refresh,
including when an observation is already fresh. Its probe and managed-runtime
owners consume the admitted requester's credential, purpose and operation
authority; missing authority or retired custody refuses without falling back to
the worker custodian's Account.
The CLI preserves a typed Home target refusal instead of reporting unavailable
authentication.

The consumer's published loopback base path comes from the admitted hub runtime
endpoint, through the same signed application's private metadata operation. It
does not infer `/v1` from the protocol or disclose the hub origin or credentials.
CLIProxyAPI therefore retains `/` for Anthropic and `/v1` for Responses/Chat;
unavailable or invalid metadata retires the unpublished consumer access.
Team consumers use the same endpoint metadata projection and reader. The signed
application and current Home metadata authorization admit the selected model's
runtime materialization before its endpoint path is published; this demand does
not forward inference, expose upstream credentials or create a UsageEvent.
Ordinary inference still passes through the request-policy and Home admission
owners, including the canonical Anthropic `/v1/messages` route.

Run source preparation uses the admitted controller occurrence and its issued
Account reader, not the process-global Account snapshot. The existing catalog
owner projects that exact Account and purpose context with `current_only`, using
the same scheduler and store; static declarations do not require a fabricated
probe. A missing owned reader or withdrawn source refuses rather than consulting
another Account. Launch preparation does not trigger a cold upstream catalog
refresh before admission: an unavailable dynamic observation requires a normal
picker/probe and retry. Direct materialization rechecks its source before final
commit as well as its existing authorization ticket.

In 0.3 development source, Session-owned Run admission and personal-Provider
materialization reach that owner over the existing authenticated runner-to-daemon
service, borrowing the Run's retained executable registry rather than acquiring
a daemon registry inside the runner. The snapshot retains preparation cleanup;
the runner receives only the scoped launch environment, binding and exact
diagnostic-redaction values. Incompatible and unverified inherited routes retain
their existing child-choice result. This is a source contract, not loaded-runtime
certification.

Issued credentials for the same Account can have a different cache scope from
the daemon's token. The trusted credential/context producer supplies the Account
identity; the source compares that identity and reads the issued scope exactly.
A cache path or token digest is not proof of Account identity. The signed target
source continues to read its own credential-bound Account catalog.

In 0.3 development source, managed connections store additional model selections
in `roleModels`, keyed by the selected Agent adapter's declared `modelRoles`.
The portable Agent Provider requirements project those same plugin-owned roles
to editors. Launch admission resolves and checks only the selected adapter's
roles alongside its main model, before acquiring credential material.
Claude declares `fast`, `default`, and `strongest` and maps them into the
Session's scoped Haiku/Sonnet/Opus model-pin environment; omitted pins use the
actual selected Session model. Explicit full-id native Agent definitions retain
Claude's own precedence. External/custom connections reject these managed
configuration fields. Edits affect future materialization, not a silent rebinding
of running Sessions. See [Claude configuration precedence](agents-catalog.md).

Managed subscription-backed routing is experimental and explicit. Upstream policy or enforcement can change and may make the route stop working. Happier surfaces an upstream policy or authentication rejection as an ordinary failure and does not conceal it, manufacture entitlement, or silently fall back to another credential.

This product-risk posture is not a legal-compliance determination. It does not authorize request cloaking, prompt replacement for client impersonation, identity confusion, tracking-identity disguise, or other enforcement-evasion behavior. Managed gateways remain fail closed, and their security, privacy, credential-handling, platform, and correctness gates still apply.

### Stored credential details and removal (development only)

In unreleased 0.3, Credentials account details use the same Account-owned stored
profile as the list, including client-decrypted E2EE metadata. Missing live plugin
discovery leaves live information unavailable; it does not hide stored identity or
Remove account. Removal needs no online Machine: the shared revoke Action uses the
existing authenticated Account credential DELETE with the displayed revision and
the existing pool-reference cleanup and managed-resource review. An explicitly
selected Machine retains provider-side revocation. The removal confirmation says
that the account is removed from Happier and that fully revoking provider access
also requires signing out at the provider. The descriptor does not declare remote
revocation support, so this notice accompanies every removal. Successful local
removal does not show a remote-sign-out alert.

Pool membership does not disable Remove account. The controller decides from the
loaded memberships before invoking the Action: one confirmation names the pool
when there is exactly one, or names the account when there are no pools. Accepting
invokes revoke once, with pool-reference cleanup for a pooled account. A later
group-reference conflict is an inline error with refresh/retry recovery, without
another prompt. Cancellation and declined Action approval retain the account and
its memberships silently. Managed-resource removal retains its separate review.
The member menu and Manage members share one membership commit handler, which
confirms removals once before invoking the existing membership Actions. The
separate Remove from pool action on account details remains available.

### Team credential resources (development only)

Current 0.3 development source contains the protocol, server routes, and UI foundations for
sharing an existing Connected Account, Connected Service Pool, or Provider Connection as a
Team credential resource. This is not a released capability. It is bounded by
`teams.credentialResources`, which depends on `teams` and is enabled by default with
`HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED=0` as the operator opt-out; the
independently exposed Internet API additionally requires
`teams.credentialResources.externalApi`, on the same default-on shape. Those bits are Home
capability boundaries, not rollout stages, and an enabled bit proves nothing about the
end-to-end broker, direct-delivery, selection, usage, recovery, and revocation journeys.

The source Account keeps credential custody. A Team resource stores a typed reference to the
current source plus audience and use policy; it does not copy a Provider definition or create a
second credential store.

Finite declared Actions in unreleased 0.3 use Home's Team operation admission
owner for the selected delivery mode. For brokered V3 Actions, Home signs the
requester, declared purpose, source and input digest and records one admission
in the existing RepeatKey store until the signed grant expires. The first
custodian carrier request atomically consumes that mark; another carrier using
the same grant receives `operation_not_current`. This consumption does not
recheck Team membership: an admitted Action may finish after withdrawal, while
a fresh open must pass current entitlement. Brokered custody stays on the
custodian Machine. Loaded provisioning and SCM journeys remain separately
validated development behavior, not a released support claim.

The recipient catalog includes the source owner’s public display label for recovery
instructions. It does not include their Account id, source binding, grants or broker
placement. The same canonical Account label projection supplies administration lists
and exact detail reads. An unreachable broker has one role-specific instruction:
the custodian can start it or change its location; recipients are directed to the
named source owner. Custodian detail and Edit use the same Home-qualified Machine
inventory label, including its name disambiguation.

This is an unreleased 0.3 contract addition: reload the development server and UI
together because recipient catalog readers remain strict. Older payloads without
`sourceOwnerDisplayName` still decode with a null label and use the existing generic
owner handoff. There is no 0.2 Team credential-resource predecessor contract.

The vendor-native source prerequisite in 0.3 development extends that same
Provider source-catalog operation with an explicit private native request. Only
the source custodian's controller can return the exact model's authorization
ticket, HTTPS endpoint and header transport; broad Team catalogs retain only an
opaque ticket reference. It reads current resource disclosure policy
without opening key material or requiring a Happier
broker. Before an installation renders headers, the canonical Saved Secret
operation refreshes the selected record against Home, then rechecks the ticket
and resource before and after materialization. Withdrawal or rotation refuses
the old selection. The transient header/redaction lease has awaited cleanup;
catalog reads never render credentials. This prerequisite alone does not certify
the managed install, guest launch or complete vendor-native journey.

In 0.3 development, the qualified account profile's optional `statusReason`
projects the existing credential health `lastRefreshFailureKind` when its status
is `needs_reauth`. The server list owner supplies the same field to account lists
and the Account profile; consumers do not classify provider errors themselves.
The field reuses the Protocol refresh-failure enum. Current reauthentication
producers emit `invalid_grant`, `invalid_client`, `provider_401`, `provider_403`
and `missing_refresh_token`; unclassified token-endpoint rejections emit `unknown`.
Absence means no observed cause, including legacy
authentication modes requiring reconnection. A connected account does not expose
a retained historical failure as `statusReason`. These categories do not establish whether a token
expired, was revoked, or was signed out elsewhere. Pool exclusions and individual
authentication-attempt errors remain separate facts, not account sign-out causes.

The same owner-only metadata projection includes stored health observations
`lastRefreshFailureAt`, `lastRefreshSuccessAt` and `providerHttpStatus` only when
present. It does not expose credential content or raw provider error text and
does not backfill missing observations. Spawn reconnect diagnostics keep their
existing code and may include `diagnostics.reconnectCause`: `credential_missing`,
`listed_needs_reauth` or `stored_health_rejected`. The last value identifies the
exact stored-health refusal; an otherwise unclassified provider rejection does
not acquire that cause.

In 0.3 development, Team native export support is a refreshable public projection
of the current connected-account authentication declaration and the account's
observed credential kind. The custodian daemon refreshes it through the existing
fenced credential-health writer at registry startup/reload and natural credential
acquisition. Home source lists and disclosure checks consume that stored
projection. An account connected before an export declaration appeared does not
need to reconnect. Declaration withdrawal clears export support; this metadata
publication preserves credential content and its revision and does not refresh
or disclose OAuth tokens. The UI portable runtime does not publish a competing
projection from its descriptor copy.

Qualified refresh settlement records the attempt time and the observed success
or failure time through the existing health writer. Codex token-endpoint
failures also carry their numeric HTTP status into that writer. Status-only
observations do not establish a refresh, and a refresh that returns unchanged
credentials does not establish a successful token rotation. Historical missing
fields remain unknown. Plugin-reported expiry still drives daemon scheduling;
the list's nullable expiry is the stored public row observation, not a read of
private credential values.

After a qualified refresh returns a replacement, caller cancellation no longer
interrupts replacement preparation, the existing credential CAS, or successful
health settlement. This preserves a rotated single-use refresh token even when
the initiating caller leaves. Cancellation before the exchange remains active;
Runtime currentness admits the exchange; registry retirement after a successful
exchange does not veto its replacement. Account-mode authority, credential and
configuration CAS, and refresh-lease checks still apply during settlement.

Codex and Claude token-endpoint 4xx failures (except 429) use cli-common's
`classifyConnectedAccountTokenEndpointFailure`, projected through the Plugin SDK.
Only the OAuth body's `error` code participates: `invalid_grant` and
`invalid_client` take precedence, then HTTP 401/403, otherwise `unknown`.
Plugins carry the existing kind in `diagnostic.details.credentialRefreshFailureKind`;
the daemon's credential-health writer persists it as `lastRefreshFailureKind`.
Response bodies, error descriptions and token fields are not retained in that
diagnostic. Existing records without a cause stay unchanged until a later
refresh failure; no backfill is attempted.

In unreleased 0.3 source, Codex uses the same owner's structured
`parseConnectedAccountTokenEndpointFailure` result to retain an explicitly
allowlisted OAuth code in `diagnostic.details.providerErrorCode`. Health stores
that code in its existing `providerErrorCode` field, falling back to the plugin
diagnostic code when no safe provider code is available. The normalized failure
kind and authentication outcome stay unchanged. The parser's fixed allowlist
excludes descriptions, unknown codes and response bodies. Credential-health
write logs identify the qualified account and credential/configuration revisions;
refresh-lease logs identify the machine, daemon owner and returned acquisition
result. These observations do not prove the cause of a provider invalidation.

In development source, a selected Connected Account in `needs_reauth`, including
the actual active member of a Connected Service Pool, retains
`connected_service_credential_reconnect_required` through source catalogs,
readiness, broker admission and Session failure projection. The source still
exists: this is an authentication repair, not a missing model or unreachable
broker. Shared-credential surfaces ask the source owner to reconnect it; where
the viewer already receives a custodian display name, that name accompanies the
handoff. In 0.3 development, a confirmed health transition into `needs_reauth`
also asks the existing Pool switch coordinator to rotate to a healthy eligible
member. The Pool's automatic-switch policy, auth-expiry opt-out and Manual
strategy remain authoritative; auth-expiry switching is enabled by default within
that policy. The coordinator commits the same lease/CAS/generation transition
used by usage-limit rotation. A member stays excluded until its health recovers.
Passive reads reflect the committed active member and never choose an alternative
themselves. If rotation cannot select a healthy member, they retain the typed
reconnect reason. Ordinary rotation preserves Team resource/model selections;
the next read observes the new member. Genuine upstream `model_not_found`
responses remain model failures. This source contract is not loaded-runtime or
release certification.

For brokered Connected Account and Pool sources in development, the daemon's model
projector uses the exact selected source Account's native model observation. The
source plugin's unique Agent declaring that Connected Account service supplies
the existing native-listing path; the Session's worker Agent need not be installed
on the broker. A missing or ambiguous source mapping retains the CLIProxyAPI
contribution's pinned declarations as explicitly unverified, without merging them
into an observed list. This read requires a current selection from the Connected Account purpose-binding owner;
the custodian's personal Provider-connections catalog need not be loaded for
this source-only read. An explicit Account context uses its own purpose resolver
and currentness proof. Ordinary personal Provider projections still require
their admitted catalog. Browsing and explicit Refresh reuse the native observation
owner's demand, cancellation and source isolation; they never start a Gateway,
deliver material to a recipient, or switch the selected Pool member. Native
executable listing retains that Agent's existing executable requirements. Admission
reads use the same owner's current-only observation without dispatching a fresh
model-list request. A saved Gateway does not replace this source catalog. Ordinary
saved Gateway model reads retain their probe path.
Source-any readiness uses the same unbound source selection;
it does not enumerate broker-local Agents. Saved Provider sources retain their
own connection/security/grant and observed-catalog admission.

External Provider requests, public model listing, resource Test and request-policy
support read that same source catalog without an executing Agent. Their application
identifies the source implementation, endpoint and protocol; registering another
Agent on the broker does not change the available routes or models. A canonical
model id stays listed when protocol presentations use different display names.
Aliases that identify different canonical models remain ambiguous. Session and Run
launches still carry their actual Agent target and apply its compatibility rules.

In 0.3 development, the managed wrapper embeds CLIProxyAPI v8.0.61. Its
Go module owns the SDK selection; catalog generation derives both the TypeScript
compatibility rows and the wrapper SDK identity from that selection. The private
wrapper contract remains v3. Connected Services remains the credential acquisition
and refresh owner: SDK entries contain registration sentinels, skip Claude profile
lookup, and treat upstream 401s as request-scoped failures so a later daemon lease
is usable. The SDK key-value store is disabled; no SDK credential store is enabled.
The catalog is compatibility evidence, not Account entitlement.

For native Codex Responses clients, the development managed codec presents MCP
namespace children, including deferred tool-search catalogs, as ordinary
`mcp__<server>__<tool>` functions on the Codex-wire upstream route. It translates continuation calls and explicit tool selection to
the same names, then restores the offered `namespace` and child `name` on returned
calls before Codex decodes them. This keeps compatible models from interpreting
a namespace as a dotted function name. Other namespaces retain their protocol
shape; the dispatcher gains no alias. The codec is installed after SDK plugin
initialization and before the managed listener starts.

In 0.3 development, explicitly selected Codex upstreams disable the native
ChatGPT Account apps server (`features.apps=false`). The Codex provider-config
owner applies this to both per-thread app-server config and native/ACP launch
overrides, including gateway families, selected API keys and local providers.
The native OpenAI Account path keeps its own app configuration. Session-selected
MCP servers and Happier Actions keep their existing exposure policy. Codex
0.162.1 defers MCP tools only when the model metadata supports tool search;
unknown custom models use eager schemas, and its removed tool-search feature
flags cannot enable deferral.

In 0.3 development, the managed Meta transport presents a subscription-quota
429 as OpenAI-compatible `insufficient_quota`. It recognizes Meta's structured
rate-limit error with a reset and its subscription-quota marker, retains the
reset and `Retry-After`, and leaves transient throttling unchanged. This lets
Codex settle exhausted quota instead of sleeping until the reset. The gateway
does not add retries or shorten the upstream reset.

The managed-family owner is the plugin's
`src/provider/managedContract.ts`. Its executable rows generate Go executor descriptors,
registration seeds and static catalogs in the same pass; Provider contributions
and launch snapshots consume the matching TypeScript projection. Run
`pnpm --dir packages/plugins/cliproxyapi run catalog:generate` after changing a
row or the SDK pin. The generated families are ChatGPT/Codex,
Claude, Muse/Meta, Gemini API keys, Antigravity, Kimi and xAI. Meta uses an existing
inference key with its API-version header at the final HTTPS transport boundary;
the child never mints a key. Kimi registers the bound account's device and domain,
xAI its API mode and base URL, and Antigravity its project and a far-future sentinel
expiry. Those non-secret scalar facts come from the service's materialization
result and update through the existing registration path when the binding changes.
Real credential headers are supplied only at the final transport hop; registration
contains no refresh token. Antigravity uses the pinned generated static catalog;
its sentinel-only live discovery probes remain enabled and can return no models.
A pool mixing accounts with different facts can send mismatched facts and receive
a visible vendor rejection; choose an account with matching facts to recover.
Devin remains a typed unavailable presentation row because its embedded request
credential needs upstream SDK support. It supplies no executable purpose or
request-auth slot.
The development Muse service owns device sign-in, explicit selected-Machine
native import and manual key credentials in the existing qualified account
lifecycle. Device sign-in mints once at connection. Each native Session requests
one nonblocking subscription-usage refresh on its existing MSP host only when
its launch has no Meta API key; native Muse may mint a key for that refresh.
Status acquires nothing. When the existing quota owner asks for stale usage
while someone is viewing, or a person requests Refresh, native quota uses a short
OAuth-only host with the same credential materializer and an isolated home.
Measured Muse 1.4.15 cost is about 2.3–2.8 seconds and one fresh key mint, plus
local native initialization files; the host and temporary home are disposed.
Selected native launches
retain the private OAuth credential file and deliver `META_API_KEY` when that
Account has a key, replacing any conflicting inherited key. Catalog listing and
Sessions consume this same launch declaration, preserving native contributor
model IDs. Muse's key lane cannot refresh subscription usage (-32081), so
Sessions skip that request. Account allowance comes through the OAuth-only quota
host even when Sessions use a key. OAuth-only Sessions retain their refresh.
Native -32080 supplies retryAfterMs to the existing quota next-allowed boundary;
-32081/-32082 retain typed unavailable causes. Missing usage shows Unavailable.
Native refresh failures retain their safe retry/mint classification without an
automatic retry, additional timer, cache or store. Other model-source consumers retain
their declared environment/header outputs.
The existing native-home owner prepares the private XDG overlay and removes it
through local account cleanup. Initial normalized mint usage is transient until
successful settlement delivers it to the existing usage writer; subsequent
native refresh and notification samples use the same parser and writer. Missing
observations stay unknown; `no_usage_observed` reads project to the existing
not-loaded quota state. Contributor variants are model ids chosen
through the existing picker, with no account observation or setting. This
integration is unreleased; see [Muse accounts](../apps/docs/content/docs/accounts/connected-services.mdx#muse-accounts-in-03-development)
for user-facing behavior and the single terms notice.
Each executable row declares its private allowed origins and credential-header stripping
names. The public request-auth materialization retains one declared `origin`.
The final transport checks each outbound host against that origin list and
replaces sentinel headers with the daemon's request-local material.

Gemini uses the SDK's API-key executor with `x-goog-api-key` at
`https://generativelanguage.googleapis.com`, including upstream token counting.
Chat Completions, Responses and Messages share that family row; the child reads
no native Gemini credentials and performs no OAuth acquisition. Service-account,
Vertex and native Interactions remain outside this managed family.

The pinned CLIProxyAPI serving registry is also a route constraint. Managed
custody passes the admitted projection's exact ids, purpose and source revision
through its private consumer document. The wrapper registers those ids using
the pinned SDK's public per-client registration mechanism; it neither fetches
another list nor aliases or rewrites model ids. Consumer admission/currentness
and settlement own those registrations, so simultaneous sources cannot borrow
one another's models. The coupled private wrapper health contract is v3; startup
refuses an older wrapper whose strict consumer reader cannot admit observations.
Changed or stale projections withdraw admission. A
successful empty observation admits no models. With no observation, the existing
static serving registry remains an explicitly unverified fallback, not evidence
of Account entitlement. This is development implementation, not release certification.

The Team model DTO carries the source catalog's optional `confidence` and
`sources` facts separately from route readiness. Static Connected Account rows
remain `account_unverified`; picker descriptions, accessible names and Team
catalog summaries show the existing “Not checked” label. An available route
does not establish that this Account serves the model, and an Experimental
badge does not change that observation. Older source projections may
omit these presentation facts; omission supplies no verification evidence.
Direct declaration browsing retains its route marker even before a material
reference exists, so it cannot share a brokered observation through RPC
deduplication. Connected Account declarations on that pre-execution route stay
unverified and browsing does not initiate material delivery.

After Direct delivery, the running Session uses its execution Machine's accepted
source context and existing in-session model publication path. An Agent's model
observation replaces the prior declared list in the Session picker, including a
successful empty list; publication does not redeliver material or reopen the
Session. Codex native Connected Account Sessions obtain that observation from
their authenticated app-server's model list. Provider-bound Sessions retain
their authorized Provider catalog owner, rather than borrowing a native
Account's list. There is no additional pre-launch discovery seam. These are
development-source contracts, not loaded-runtime certification.

In development source, a Connected Account authentication mode may explicitly
declare access-only Direct delivery with a finite future expiry and declared
non-secret metadata. Muse declares brokered-only sharing for all connection
methods. Its opaque account token has no knowable expiry, and the incumbent
Team snapshot opener does not re-acquire from the custodian on vendor rejection.
Codex/Claude runtime rejection recovery refreshes the current Account's own
stored credential; it does not provide recovery for delivered Team snapshots.
No new recovery mechanism or synthetic expiry is added. Existing Muse accounts
pick up the current export declaration at registry publication and natural
credential acquisition; reconnecting does not enable native sharing.
Brokered-only Muse selections still follow the existing early native Agent
compatibility refusal.

Team-share explanations use the same Agent declaration fact as the brokered
source picker: a resolved Agent without Provider requirements needs its own
native login. Connected Account projections carry the affected Agents' qualified
identities and declared display names in `nativeLoginRequiredBy`, derived by the
canonical Team credential demand owner. Both Machine and Account declaration
publication supply this presentation fact for bundled and installed plugins;
missing Agent declarations remain unknown. The UI does not maintain a service
identity exception or a separate roster of compatible Agents.

Withdrawal clears delivered credential files from retained daemon materialization
homes at the next existing Team reconciliation. The materialization manifest
records the admitted Team resource and exact secret paths; replacing the source
replaces that ownership. Session and Run settings and resume state remain intact.
An already admitted Agent process removes its selected native credential file
when it exits through the existing Agent identity cleanup. For Muse that file
contains both the delivered access token and the member's derived inference key.

Brokered usage limits block brokered choices only. Current Direct model rows
remain selectable under that limit; reconnect, withdrawal and missing or stale
Direct material still refuse selection. UI and CLI consume the same Protocol
delivery-readiness rule. Experimental compatibility stays separate.
The actual worker's admitted adapter computes compatibility at selection and
launch. Source-reported compatibility is not worker authority.
A present refused model retains the worker's typed reason through launch and the
public spawn result; `provider_model_not_found` denotes a missing exact model row,
not a compatibility refusal.
Experimental Team Agent/model pairings require no confirmation from either the
custodian or recipient, across brokered, Direct and vendor-native delivery.
Their informational Experimental badge is separate from Not checked catalog
evidence. The worker still computes actual compatibility and refuses hard
incompatibility. Personal Provider confirmation retains its existing
Account-scoped owner and `providers.models.experimental.confirm` Action.
Retained Team confirmation records are ignored at the storage read boundary;
old personal records remain readable. No database migration is required.

Team runtime admission retains the captured requesting Account for resource
entitlement and transport authority.
The daemon's shared Session/Run binding composition also uses that captured
Account's bearer and Home for the entitled-resource catalog and broker-open
requests, and its Account identity for the signed machine-carrier tunnel.
Changing only the Home URL would leave the daemon Account's bearer in use and
can hide a Team resource available to the requester on a shared Machine.
Home catalog reads and broker-open revalidation both request the source-only
projection, so the offered source revision is not recomputed with the custodian's
Agent adapter or consent. Closed broker-open refusal codes remain typed through
the daemon/runner boundary and construction diagnostics; they are not daemon
authority failures.
The Agent receives the local machine-carrier capability through its declared raw
credential header, not a public-header/config literal; signed Home authority
remains with the admitted stream. Security/currentness fingerprints continue
to bind the admitted source and transport.

Team policy and current source membership decide what is offered; actual worker
compatibility decides selection/launch admission without experimental consent.
Launch reads an application-qualified catalog through
the accepted Session/Run binding. Source support alone does not prove a working
native turn; loaded-runtime replay remains a separate integration check.

The development daemon launch composition normalizes a fresh Session's
service-purpose Team selection together with its effective model before
Session binding admission. It uses the declared Agent/Provider application
and an exact currently offered Team model row, not a personal Provider
connection or a model-name inference. Explicit model-source choices retain
precedence; an unavailable or ambiguous model source is refused rather than
falling back to native authentication. A Team model source with no selected
model refuses with `team_credential_model_selection_required` and asks the
person to choose a Team model; the daemon does not infer one. Pool member
rotation preserves the selection while its resource and exact model remain
available. Catalog, broker and reconnect refusals retain their existing typed
codes through the launch result and the shared UI failure presenter. Broker
software incompatibility retains `update_required`, rather than a missing-model
diagnosis. Runtime opens use the selected delivery mode: an exhausted brokered
allowance does not block an offered Direct model, while a confirmed source
reconnect requirement still refuses both modes.
A Team model launch commits its Session
before native-auth preflight. Owner detail projects the Home-written model-slot
witness into the protected attach snapshot; rejoin reads that Session's accepted
selection rather than treating a new caller intent as accepted. The attaching
host consumes the snapshot before capturing native runtime inputs. Only an
accepted brokered inference binding satisfies native-auth preflight; native
Sessions retain their sign-in check. Broker open admits the job against current
resource, source and consumer authority, including Execution Run custody; each
later request only checks that the admitted job is still active (see Brokered).
The running route display reads the runtime-opened source from the existing
`sessionModelsV1.activeSelectionV1` carrier. Its closed V2 witness retains the
accepted Team model identity alongside the exact model tuple and runner; native
and Account Provider witnesses retain V1. The legacy carrier name does not make
a V2 witness readable as V1. Both owner metadata and client stored readers retain
the same witness, and a missing or mismatched open cannot supply active proof.
V1 intent or `sessionAppliedModelV1` with a null Provider connection cannot by
itself distinguish a Team source from native sign-in. Pending choices remain
separate from the applied source; retained proof may describe history without
authorizing a replacement runner. This is unreleased 0.3 development behavior;
the daemon, Home metadata reader and UI must load the matching source together.
In the development composer, the local restart marker bridges only the wait for
the durable model intent echo, whether V1 or V2. After that echo, the shared
selection disposition decides whether a transition is still pending. A Team
selection applied from another device therefore clears the marker and the armed
Send continuation from its actual runtime witness, without comparing it to a
native-only selection key.
New Session credential readiness uses the selected current Team model's binding
facts and the Agent's admitted authentication-isolation declaration, as Account
Provider selections do. When that binding replaces native authentication, native
sign-in is not a launch prerequisite; installation and worker compatibility
remain required.
The picker retains the last successfully admitted Team catalog choices during a
background refresh, including a matching Home wake. Refresh freshness is separate
from picker eligibility: an explicit invalidation, observer gap, failed read or
refusal withdraws eligibility until a successful reread. Retained choices do not
authorize credential use; launch and broker open recheck the current grant,
resource and source through their existing owners, and each request checks that
the admitted job is still active.
In development source, picker and spawn catalog reads share the protocol catalog
merger. An application refusal outranks generic available discovery with no
models. A completed broker model read with no models settles as the existing
`broker_unavailable` / `catalog_empty` refusal and offers Retry; generic
credential discovery and current Direct material remain independent of broker
model availability.
Native Connected Account purposes remain limited to the Agent's declared
services. A resource from another service can still supply Provider models when
their complete application matches an application supported by that Agent;
that does not offer the resource as native authentication. Workflow engine
authoring uses this same exact-Machine catalog and preserves the selected Team
resource, application, execution Machine and model in its provider-model binding.
The new-Session model picker's existing Refresh also reloads this Team catalog,
alongside native/configuration and Provider observations. Favorites runs that
shared refresh once across its Agent collectors.
In development source, a selected Team Connected Account binding (brokered or
direct), or a Team Provider model for the current Agent, uses this Team catalog
instead of native model discovery. The shared model preflight hook suppresses
the native request and its cached rows/failure state; native and Account
selections retain native probing. The CLI still refuses Team model operation probes
without admitted Session authority, and browsing never materializes Team credentials.
Finite managed provisioner and SCM hosting Actions use their separate admitted
Action consumer at the shared Team operation owner; that contract preserves
the resource's brokered or direct mode (see [Teams](teams.md#brokered-provider-credentials)).
The runtime's entitled-catalog read derives its applications from the worker's
leased Agent requirements and uses the same paginated Session catalog transport
as launch normalization. The composed recipient Pool → Action/CLI spawn →
native-turn journey and loaded-runtime replay still require integrated validation.

Managed Team credential use identifies its known source through the existing
spawn/admission presentation: “uses <Team>’s shared <account>”. The grant supplies
those source facts at admission. The adapter selected afterwards is an internal
runtime detail and adds no separate disclosure or approval. The generic credential
warning and a direct plugin's declared operation disclosure remain in place.

#### Vendor-native Team delivery (development contract)

The unreleased 0.3 delivery contract adds `vendor-native` alongside brokered and
direct. Integration is in progress; these contracts do not establish loaded
availability, completed isolation or a real Vercel turn. Focused tests exercise
explicit Action/HTTP source composition. The approved first-use contract extends
ordinary spawn approval to that Session's exact custodian-authorized native binding;
terminal lifetime removal does not require a live spawn or turn ingress. Current
source and loaded integration evidence are tracked separately; loaded integration
remains parked. A resource's custodian
owns one ordered `preferredAllowedModes` allowance; new resources default to
`['brokered']`. Audience grants contain independent allowed route sets. Native
permission must be explicit in both; legacy `both` never includes future routes.
Team administration alone cannot authorize vendor disclosure.

Native allowance, native source replacement and native audience grants require
person-reviewed confirmation through the canonical Action admission, even when
ordinary Action prompts have a persisted waiver. The existing host-owned,
same-Action confirmation can carry the editor's reviewed vendor consequences;
an explicit Ask preference still applies. Unchanged disclosure authority does
not make an ordinary metadata edit a new disclosure decision. This uses the
existing approval/replay mechanism, not a separate native consent setting.

The existing Provider Team-binding owner selects the custodian's most-preferred
allowed, entitled mode supported by the exact Machine and current source/runtime
facts. Picker, CLI and launch consume that result. There is no member route
chooser or per-Session override. Native installation requires a supporting
provisioner, qualified tenant/runtime, compatible HTTPS header transport, exact
managed placement and lawful co-located source custody. Missing declaration,
unknown support or unavailable installation authority makes native unavailable;
an allowed lower mode may be offered by this same owner, never silently selected
during an admitted launch.

Installation is the ordinary `machines.managed.credentials.install` Action on the
exact controller. The host recomputes the complete policy from current active
bindings, keyed per binding, and the provisioner applies one logical replacement.
Home distinguishes retained owned rules from currently authorized desired uses;
the controller consumes that classification. Disabled resources and withdrawn
audiences are omitted from desired policy without losing their owned descriptors.
Withdrawal alone does not block a binding's release or require opening the
withdrawn source. The controller's confirmed completion reports the actual
post-submission owned and desired binding keys applied to the vendor; Home does
not reconstruct that cohort from entitlements that may have changed during IO.
The exact released binding is retired, while acknowledged omitted confirmed
peers return to prepared with their accepted selections intact. Unknown or
submitted effects remain retained and block ready use across the managed
resource. An exact prepared, never-submitted binding can still report known
absence without opening credential material or requiring a new Use grant.
For Vercel, running and saved policy acknowledgements are both required. Partial
or unknown IO, including an abandoned remote mutation after local cancellation,
remains unconfirmed. Compensation alone does not establish remote settlement.
The same composer owns lifecycle reconciliation and awaited owning-Session cleanup;
unimplemented transitions refuse before new use. No event replay, new timer or
controller request occurs for each inference request on an unchanged installed
binding.

The member guest receives the final Provider endpoint and a random placeholder.
Vercel substitutes the admitted headers outside the guest; the real inference key
is intentionally disclosed to Vercel's control plane. The separate Vercel
provisioning credential never becomes Agent authentication. Native delivery is
not a general OAuth-refresh, request-signing, external-key or detached-Run route.
Future vendor adapters must implement and qualify the same public provisioner
seam before advertising support.

**Upstream key rotation/revocation is the hard stop; controller-offline policy
removal is not guaranteed.** Installed rules may continue working while the
controller is offline; new installs and changes need control-plane reachability.
Native traffic bypasses Happier's per-request membership, body/model policy and
request/token/cost limits. Existing Agent usage remains observation, never native
quota enforcement or authenticated per-member billing identity. Configure verified
Gateway/vendor restrictions at their own owner. Vercel's current
[vendor documentation](https://vercel.com/kb/guide/vercel-sandbox-vs-e2b)
includes Hobby in credential-transformation availability; Happier must still
qualify the actual tenant and exact resource rather than infer support from a
plan label. Vercel's [matchers](https://vercel.com/docs/sandbox/concepts/firewall#credentials-brokering)
select substitution, not an arbitrary request-body firewall.

Placeholders permit use within their sandbox. Co-members sharing one Agent OS
user can read each other's placeholders until per-member users and private
execution material are implemented and verified. API projection filtering is
not OS isolation; same-Account Sessions and privileged owners remain trusted.
Separately granted direct access still permits intentional material disclosure.

Resource access therefore has three distinct delivery/privacy contracts:

- **Brokered** access keeps usable credential material on one exact broker Machine. A custodian
  can configure that Machine directly or choose a personal Machine Pool. For a genuinely new
  Pool-backed open, the source-owning daemons return only current eligibility status, the Home
  applies the canonical Pool selector once, and the ordinary exact-Machine broker path continues.
  In 0.3 development, the worker may use its own Machine as the broker, including
  through a Pool. The native carrier uses that endpoint's active local Machine
  admission instead of an unsupported Iroh self-connection. Fresh signed authority,
  per-request admission, target capabilities and acceptor withdrawal still apply.
  Separate daemons on one host retain distinct Machine and endpoint identities;
  another Machine claiming the initiator's endpoint is refused with
  `resource_unavailable` before model projection or signing.
  An external API key's retained operation must stay on its selected exact Machine. Pool tier
  reordering, disabling and removal affect future opens only. Lost presence, unavailable source
  readiness or a failed RPC is not proof of retirement and must not trigger reselection.
  **Development completion gap:** the current admission UsageEvent anchor cannot establish
  operation lifetime or arbitrate requests before first admission. The approved correction
  extends the existing external-key/admission aggregate with a private current-operation binding
  and compare-and-clear retirement from actual daemon custody cleanup. That integrated path is
  not yet complete; read-only model listing must not establish an operation. The Home admits the current Account, Team resource, Session or execution run, policy
  and placement once per job, at broker open. Each later request reads only whether that job
  is still active (signed credential epoch, resource row and revision, the active Session,
  or the Run occurrence) and admits its usage and limits. In 0.3 development, a Session request
  may precede its first or next turn-begin publication. An available in-progress turn witness
  must match the admitted requester/resource and supplies usage attribution; before publication,
  usage retains its Session, requester and resource attribution with no turn id. A completed
  previous turn is never used for the next request's attribution. The custodian's source and member are
  not re-read per request or on a source-change notification: the admitted operation
  retains its capture, and the next acquisition re-admits against the current source.
  Grant withdrawal advances the resource revision in the same transaction. The
  admitted resource revision is bound by the existing signed broker admission
  fingerprint. The cheap active-job lookup refuses a changed revision on the
  next request or new stream. A fresh Start admits a new job. Already-open response
  bodies finish. This deliberately also interrupts
  unaffected recipients at their next request: they re-admit at their next Start,
  an accepted rare, visible and recoverable glitch. Connected Account catalog
  publication does not change the Team resource revision. Tightening the Team sign-in policy (or removing the factor that
  qualified the credential) is decided at admission only: admitted routes run to their natural end,
  and the next fresh open or turn re-qualifies. Renewing an admitted job's transport
  proof checks job activity without repeating qualification. Signing the credential out ends the route on
  its next request. A source that needs reconnecting is refused by the broker's own source owner
  before it asks the Home. Recipients do
  not receive credential bytes, the private Pool roster, or Pool-management authority.
  Source-member currentness is checked by `resolveTeamCredentialSourceMemberCurrentnessInTx`
  with brokered delivery: the account or enabled Pool member must still belong to the pinned
  source lifetime, but need not support direct export. Native OAuth/device accounts therefore
  remain usable through the broker without becoming exportable.
- **Direct** access deliberately discloses usable current material to an authorized recipient for
  a source that supports export. Future revocation can stop new retrieval, but cannot recall
  material already delivered or enforce later out-of-product requests.
- **Vendor-native** access discloses the admitted key to a supporting cloud vendor,
  whose external egress rule replaces a guest placeholder. It preserves the
  source/entitlement owners while giving up Happier per-request enforcement.

In 0.3 development, the installed controller replaces the complete current
vendor-native policy. Admission and fresh secret acquisition remain separate:
withdrawal refuses a new use or acquisition, but does not turn a completed vendor
write into an unknown result. A later confirmed replacement settles earlier
unknown outcomes and abandoned submission markers; an actual partial live/saved
write still reports unknown.

Session, binding, resource and Account deletion do not retain rows solely as
native cleanup proof. Before cascading those rows, the server publishes the
existing managed-policy invalidation. The controller re-reads the current set,
including an empty set, at start/reconnect and on that invalidation through the
same per-resource writer used by explicit installation. Vercel recognises its
rules by the existing `x-happier-attribution` header, refuses unmarked rules and
writes only changed policy projections. An offline controller cannot remove a
rule until its next connection; deletion is not immediate vendor revocation.

Broker placement has one interpreter. The resource row carries two nullable columns,
`brokerMachineId` and `brokerPoolId`, and `readTeamCredentialBrokerPlacement` in
`apps/server/sources/app/teams/credentials/brokerPlacementResolver.ts` is the only code that
reads them: exactly one set names the broker location, neither set is an unplaced resource,
and both set is `resource_corrupt` rather than a silent preference for one column. Every
placement, eligibility and selection decision starts there, so no caller compares the raw
columns, and `teamCredentialBrokerPlacementPinsMachine` is the one answer to "is this
resource pinned to this Machine" — a Pool placement never pins. Saving a Pool placement
mirrors the saved exact-Machine rule: the Pool must be the custodian's and carry at least
one enabled member that is a compatible persistent broker. Presence is not required to save,
because an offline Pool is repairable while an empty or incompatible one is simply not a
broker location.

The resource `revision` is an **authority** revision, not a row version. Every durable Session
binding and signed broker open compares it, so `resourceUpdate.ts` advances it only when an
authority fact changes: the source binding, disclosure ceiling, placement, enabled state,
Session use policy, request policy, audience, or usage limits. A presentation-only edit — a
display-name change — keeps the current revision, so renaming a resource does not invalidate
live bindings. The optimistic-concurrency precondition is independent of that: `expectedRevision`
is still required and a stale value still answers `resource_changed`, whichever kind of edit it
was. Direct delivery tracks its own narrower authority set and clears stored direct source
versions when the source, the disclosure ceiling, or the direct audience changes, or when the
resource is disabled.

For normal Sessions and execution runs, the runtime admission owner supplies the authenticated
accountable Account independently of message authorship. Background work must not guess that
authority from Machine ownership, the last human message, or Session storage ownership. External
API keys identify one resource and accountable API client; they do not let a caller select a
Machine, source member, Pool member, internal bearer, or loopback endpoint.

The assigned member is also the external key's authentication principal. A self-assigned key
captures that Account's current authentication evidence at creation. A key created for another
member carries no manager proof: the assignee authorizes the exact resource/key through
`teams.credentials.externalKeys.authorize`. The existing key row stores the canonical Lane 03
evidence snapshot; bearer verification and broker admission recheck it against current identity,
Team policy, membership, and resource entitlement. Authorization never returns or replaces the
bearer. Qualified managers list all safe key summaries; entitled assignees can list their own
summaries to repair authentication, without source or audience internals.

Recipient catalogs expose only selection and recovery facts. Source identity, broker placement,
grant internals, revisions, limits, and encrypted material remain manager/source-owner data.
Readiness and failures use the typed Team-credential result unions; clients must preserve the
reported recovery action and must not silently fall back to a personal connection or from direct
to brokered delivery.

In development 0.3, the Shared credentials page combines the member's custodied
administration rows with the existing least-privilege recipient catalog. Entitled
resources remain visible with their typed readiness and owner-recovery guidance,
including Brokered-only resources whose source needs reconnect and has no selectable
models. This does not widen administration disclosure or change model eligibility.
Saved-resource Test results carry their typed cause and existing request ID into
the collapsed Details disclosure: the broker request ID after dispatch, or the
HTTP request ID for preflight answers. Optional `failureDetail` preserves only
the closed application refusal code, carrier stage and actual HTTP status when
one was received. It contains no upstream body or arbitrary headers. These
optional output fields are a direct development contract change; matching
producers and readers reload together. New readers accept old replies without
diagnostics; older strict readers reject replies with the additional fields.
Optionality does not establish compatibility in that direction. The generic
`upstream_unavailable` result alone does not establish a vendor outage: the
carrier also uses it for incomplete or malformed application responses. Closed
broker application refusal codes remain available to Test Details.

The development readiness owner preserves typed source-projection failures.
Generic recipient catalogs, application-qualified catalogs and credential
administration consume the launch placement resolver through the Team broker
readiness projection. An offline selected broker returns `broker_unavailable`;
unknown presence retains `projection_unavailable`. Reads select the demanded
Machine presence rooms, without changing resource revisions or adding a poll.
Current direct material remains independently usable when brokerage is unavailable.
The strict Session creation adapter preserves a closed preflight cause carried
by `SPAWN_VALIDATION_FAILED`, so retained operation results and the Session error
presenter can explain broker recovery using the credential owner's guidance.
These are development-source behaviors; loaded-runtime validation is separate.

An application-qualified catalog read distinguishes an unavailable transport,
an invalid response, missing source authorization, incompatible rows and a
current empty catalog with bounded `broker_unavailable.reason` values. These
failures do not become an unexplained empty model list reported as available.
Usable rows from another evaluated candidate retain their availability; a
configured usage limit or structural resource failure still takes precedence.
Request-policy support, administration and saved-resource Test share one
broker-refusal interpreter. A Pool-wide application or model refusal requires
every candidate to agree; mixed, missing or malformed observations remain
`broker_unavailable`.
Administration reports a broker target as `not_verified` until presence has
actually been observed. None of these presentation facts grants access or
replaces the existing recovery action. Diagnostics carry no model, account or
credential details.

Saved-resource Test connection failures also leave content-free `stage` and
`code` records in the server logger: `team-credential-resource-test` identifies
placement, candidate, dispatch and response-body failures; `provider-broker-carrier`
identifies feature, signing, authorization, initial write, incomplete or invalid
response headers and application refusals. Application-response records include
the HTTP status and only a schema-admitted broker code; unknown headers become a
constant diagnostic. The daemon logs source-open/currentness and application
failure stages as well. These records omit request/response content and exception
text. Unexpected application exceptions return the existing typed
`broker_unavailable` refusal with retryable HTTP 503, while authority and policy
refusals keep HTTP 403; the file diagnostic includes only recognized error
names and system, Fastify or Axios error codes, a closed failed phase and an
application request id. Private broker requests also carry the host-generated
broker request id used for Home admission, distinguishing Home admission,
source opening and upstream forwarding without logging URLs, headers or bodies.
In 0.3 development, the existing `[provider-broker-application]` file records
also distinguish fresh carrier admission, target HTTP receipt, phase settlement,
upstream HTTP status and completed responses. A context record joins the target
HTTP request id to the existing broker request id used by Home admission and source forwarding;
the Home-generated grant UUID and consumer id join carrier admission to target
receipt. Non-UUID grant ids and arbitrary exception codes are omitted. A carrier
admission success proves a fresh witness, not successful native forwarding;
a missing target receipt still needs native transport evidence. These diagnostics
perform no additional admission, source or upstream requests.
In development source, a fresh Home admission refusal on an already-open
carrier answers the Agent's local HTTP request with the existing typed 403
broker error body, including its closed reason and selected Team resource.
The initiating host captures its existing admitted Session turn before the
fresh Home check and retains only the closed reason, selected resource and
allowance facts for that turn. The canonical Session lifecycle reads this
evidence before publishing a failed turn, so the named Team denial survives
Agents that discard the HTTP body. Daemon runners use their existing private
service channel; temporary-computer runners read the same host evidence owner
in process. A successful fresh admission clears that turn's refusal, and a
late response cannot attach it to a successor. Cancellation stays cancellation.
The same file logger records capture attribution, the daemon evidence-read
decision, the runner's private-read outcome, failed-turn enrichment and
begin/terminal publication.
These records carry only Session/host-turn ids, available PID-generation facts
and closed stage/outcome codes. They distinguish capture attribution skips,
missing evidence, turn or PID-generation mismatch, unsupported runner reads,
failed reads and failed mutation or marker custody without logging the
refusal body, selected resource, Agent diagnostic or exception text. Publication
acceptance means local durable custody and any installed marker notification succeeded; it
does not prove Home applied the mutation. These observations add no admission,
evidence or upstream requests. Loaded-runtime replay remains necessary to
identify which link failed in a particular incident.
The existing Agent-body classifier remains an ingress for Agents that preserve
the typed envelope. The local native callback carries the
refusal without opening a remote stream; cancellation and unexpected callback
failures retain their existing close behavior. This requires the matching
rebuilt Iroh addon and updated initiator daemon; an older loaded addon cannot
render the new local callback outcome.
Streamed responses also record one `response_body` settlement with a closed
`completed`, `failed` or `cancelled` outcome and the number of upstream body
bytes read into forwarding. This distinguishes a body failure after successful
HTTP headers from a completed response; it does not prove delivery to the Agent.
No body content, exception text or per-chunk record is logged.
In development, broker resource reads and Home admissions follow the containing
request's cancellation rather than a separate ten-second HTTP cutoff. Runner
broker readiness likewise follows its caller's signal without an independent
thirty-second Axios deadline.
In 0.3 development, the Test
result's optional, closed `code` preserves the
exact admitted application refusal or the carrier's public failure classification;
`source_unavailable` alone does not establish an absent or expired credential.
A trusted broker update refusal retains the existing `incompatible` readiness reason.

The development Temporary-computer flow resolves its Team credential before a Session exists. It
authorizes the named resource through the planned-Session admission owner before it discovers any
broker, because Pool selection reads the custodian's Machine presence and asks their daemon whether
it can run the source. A caller who is not entitled to the resource reaches neither step and cannot
tell a resource that does not exist from one they may not use: both refuse with the same reason.
The reviewed `RunnerCredentialSelectionBindingV1` pins the exact resource, broker Machine, resource
revision, Provider application binding, and source/catalog revision. For direct placement that is
the configured Machine. For Pool placement, the server intersects current generic Pool availability
with source-specific content-free eligibility, selects once, and emits the same exact binding; the
Runner never lists, joins, manages, or reranks the Pool. It deliberately does not own the chosen
model or initial prompt: those remain inside the creator-reviewed sealed launch manifest. Resolution
creates no Session, sends no paid inference request, exports no credential, and retains no broker or
managed-service lease.

Readiness does not turn that review result into durable authority. Immediately before materializing
the Machine and Session, the activation owner revalidates the signed readiness statement, reviewed
selection, current resource and source, exact broker Machine and endpoint, application protocol,
Agent installation, and current creator consent. Any mismatch returns a typed unavailable or
conflict result before Session creation; it never substitutes a newer model, source, or Machine.
Pool membership changes after exact selection do not become a new Runner ACL. Resource relocation
or Pool deletion changes the resource revision and invalidates the binding; source, Machine,
endpoint, policy, and usage controls remain current through their existing owners.

## Model catalogs, visibility, and stale references

In 0.3 development, `providers.models.list` reads current model metadata without
refreshing a managed source. The existing `providers.models.refresh` Action also
accepts an exact connection operand to refresh its declared sources. That operand
can contact the Provider. Both the connection and Agent model-picker refresh
operands use the shared dangerous-Action approval default for agents. Explicit
approval preferences still apply. A connection without a
supported source refresh returns typed unavailable rather than reporting success
from its cached metadata.

Refreshing saved Provider usage (`providers.usage.refresh`) reads current
spend and credits on the selected Machine using the shared read approval defaults.
It does not change Provider configuration or credentials.

The canonical model catalog merges sources in this order:

1. user-entered manual model metadata;
2. verified static plugin metadata;
3. external catalog metadata;
4. live probe observations;
5. unknown metadata, which remains unknown rather than guessed.

The merger preserves provenance. A model that disappears from a current probe leaves normal picker results but remains renderable when referenced by a favorite, draft, or historical session. Missing definitions and tombstoned connections produce explicit stale states and actionable errors; they never trigger a native fallback.

In 0.3 development, both regional MiniMax contributions list M3.1 Flash first,
followed by M3 and M2.7. This catalog order does not hide older models or replace
an existing selection. Importing an unpersisted built-in MiniMax profile uses
Flash for the implicit model and newly materialized tier defaults. Explicit
model aliases, completed model selections and saved custom profile bodies retain
their existing values; historical source-recognition expressions stay unchanged.

Model visibility has one owner, keyed by structured model reference:

- native models can be hidden per Agent;
- provider models can be hidden per Agent or for all Agents using that connection;
- an intentional all-hidden state remains an honest empty state with **Show hidden** and **Reset visibility** actions.

Visibility affects discovery in the picker, not the validity of an already-running session.

In 0.3 development, Agent Models keeps an already admitted Account catalog visible
read-only during refresh and transient read failures. Mutations resume only when
that catalog is current and writable. Authorization, encryption-mode/material,
and invalid-content failures withdraw the catalog at its existing read owner;
the screen does not preserve its own copy after that withdrawal.

The Provider, connected-account configuration and connected metadata catalog
owners retain their admitted snapshots during ordinary transport refresh; an
equal result publishes nothing. Explicit invalidation still marks retained data
stale, and admission failures still withdraw private content. Provider Machine
target presentation subscribes to label and eligibility facts at the Machine
owner, while execution resolves the current raw inventory.

Large catalogs must use the app's virtualized option-list path. OpenRouter-scale catalogs must not render hundreds of model rows through a direct `.map()` of pressables.

Catalog and health refresh is demand-driven. Enabling a connection, a semantic connection-detail or model-picker read, or an explicit Test/Refresh schedules work through the canonical Provider probe scheduler. Concurrent identical demands share one operation, and each caller can withdraw independently. The last caller leaving aborts cancellable work; a boundary that cannot abort retains its pending work until settlement. A settled failure does not impose a local retry delay; an endpoint's actual `Retry-After` remains observable and manual Refresh can retry immediately. There are no Provider-specific concurrency ceilings, freshness TTLs, background crawlers, or retry timers. Catalog refresh already publishes health for the endpoints it observes, so the same demand does not request those observations twice.

In 0.3 development, the connection header and Test row consume the same current
Machine health projection. Test re-reads that projection after settlement;
its success is not retained as a separate health verdict. A later observation
can change the result while the last-known model catalog remains visible.
Mounted detail and Machine readers consume updates from the shared check owner
without replacing the Account catalog an open editor read. A failed refresh
marks retained model membership stale; it does not make its count zero. Models
leave active membership only after a successful catalog omits them. Until a
model list is available, the detail uses the Machine's retained count rather
than the Account's static/manual-only count. Selected shared-secret admission
accepts unrelated Account-preference advances while the Account scope and
Provider catalog authority remain unchanged; actual authority changes still
refuse admission before HTTP dispatch.
In 0.3 development, connection readers derive Account rows from the shared
catalog snapshot rather than issuing their own Account describe Actions. The
catalog loader owns observation and pushed invalidation. Local write receipts
advance all readers, including an editor's revision basis; an unrelated remote
refresh does not overwrite an open draft. Machine checks remain keyed by their
exact Home, Account, credential, Machine and connection query. Refreshing one
query does not fan out private describes to neighboring panes.

In 0.3 development, Connected Service pool detail, the index and choosers share
the Account profile's `connectedAccountGroupsV4` projection. Remote edits update
an open detail through the existing profile push; detail does not fetch or retain
a separate pool list. The server projects optional pool policy fields through
the same Home feature decisions for profile pushes, list reads and mutation
replies. A successful edit returns its acknowledged CAS revision for a draft's
next member write without replacing the pushed profile with a private copy.

Authenticated HTTP 401/403 retains `provider_endpoint_unauthorized`; HTTP 5xx
needs attention, while a transport failure is unreachable. Usage-source
credential results remain separate: a successful public catalog read does not
establish that the inference or billing key is accepted.

In 0.3 development, an Agent may declare an ordered native endpoint and credential target for that same catalog observation. The host reads declared environment or native-home sources and executes an eligible user settings helper under the containing request's lifetime. It routes the target through the existing Provider observer, parser, cache and refresh scheduler. Claude uses this path when no selected Connected Service supplies the catalog credential; its account setting and environment kill switch run before credentials, helpers, cache or network are touched. The helper runs as a shell command on the execution machine in the selected workspace directory. A configured helper failure shows the built-in catalog with a failed refresh without substituting another account's credentials; a saved native OAuth login is eligible only for the default endpoint. [Agent catalog ownership](agents-catalog.md) describes the native preflight settings and gateway contract.

A model-picker read waits for the demand it schedules only when a connection is **cold**: it has no catalog observation yet and would therefore contribute no row at all. Answering that read immediately would be a silently empty picker with nothing to follow it, because the projection response is the only completion signal the client has. A connection that already holds an observation—even an empty, stale, or failed one—renders from that observation and keeps its refresh advisory, so an unreachable endpoint never blocks a later read. Waiting and advisory reads use the same single-flight scheduler. Explicit model Load requests one fresh catalog observation after its effect; an older in-flight GET cannot confirm the load.

### Manual reasoning-effort declarations (0.3 development)

In unreleased 0.3 development, a manual model can declare optional
`reasoningEffortLevels`, for example `['low', 'medium', 'high']`. The shared
Protocol reasoning-effort schema owns the closed level vocabulary. Author the
declaration through `providers.models.manual.add` in each model entry, or the
friendly CLI:

```sh
happier providers add-model <connection-id> --models custom-model --reasoning-effort-levels low,medium,high
```

The existing add operation also replaces the manual metadata for an existing
model id; omitting `reasoningEffortLevels` on that update clears its declaration.
The Account Provider Action writer persists it with the manual model; catalog
merging remains owned by `packages/protocol/src/providers/catalog/merge.ts`.
Import and migration conflict review compare declared effort tiers alongside the
model id and name, while ignoring provenance timestamps. Explicit imports preserve
existing tiers when the incoming model omits that declaration and refuse conflicting
declared tiers rather than silently discarding them.
The merger fills absent reasoning facts with `reasoningControls: 'supported'`
and the shared `reasoning_effort` option. Probe-reported reasoning facts and
curated/static reasoning facts take precedence, including explicit unsupported
or unknown controls. A model listed by a probe without reasoning facts can use
the manual declaration. Without either source of evidence, reasoning controls
remain unavailable. Effort controls appear only when the selected Agent can
apply the selected model's declared tiers. Anthropic API compatibility alone
does not enable Claude Code's Ultracode control.

An Anthropic-compatible endpoint can supply the same evidence in each
`/v1/models` row's `capabilities.effort`: `supported: true` plus supported tier
objects such as `low: { supported: true }` and `high: { supported: true }`.
An explicit `supported: false` reports no effort support. A manual declaration
does not override this report or prove endpoint health or Agent compatibility.
Tier declaration is currently authored through the Action or CLI.

Session and Execution Run admission refuse an explicitly requested, non-null
`reasoning_effort` when the selected model declares different allowed values,
explicitly reports unsupported reasoning controls, or the Agent cannot apply
Provider effort. Absent effort facts remain unknown: admission preserves the
requested value for the Agent rather than inferring unsupported capability.
The shared Provider authorization owner returns
non-retryable `provider_model_config_option_unsupported` before runner startup;
retrying the same explicit launch choice preserves that requirement. Clearing or
omitting the option leaves inherited/default configuration to the Agent's
normalization. A model switch does not make retained effort a fresh explicit
choice; for example, Codex omits unsupported inherited effort at startup.

## Session lifecycle

In 0.3 development, a model-scoped failure (`quotaScope: model`) stays a model
problem, including model availability, plan restrictions and model usage limits.
Connected Services recovery does not mark an account as needing attention,
switch accounts or schedule account retries for it. The Session retains the
typed model failure so the person can choose another model. Account-scoped
authentication, credit and usage-limit failures retain account recovery.

In 0.3 development, Codex app-server turns bound to a Provider connection map
structured upstream HTTP 401 evidence to `provider_endpoint_unauthorized`.
The native turn diagnostic carries the existing `ProviderErrorV1` with the
connection id and `replace_secret` recovery; the Session issue preserves the code
for the existing Saved Secret presenter. Native Codex sign-in failures retain
their separate recovery. HTTP 403 alone, a missing HTTP status, or error prose
does not establish an invalid Provider credential.

Structured Codex endpoint connection/stream failures without an HTTP response
map to `provider_endpoint_unreachable` for the admitted Provider connection,
with the existing retryable `retry` recovery. A retry-exhaustion marker alone
does not establish reachability. This attribution does not change Codex's native
request/stream retry policy; Session input settlement owns whether a retry
control can safely resubmit the retained input.

In 0.3 development, a failed model switch reports the Agent's actual running
model and a visible failure; it never silently switches back. If runtime
application succeeds but publishing its active facts fails, the existing
reconciliation result retains the known applied selection and prompt admission
stays fenced until the facts recover; an unavailable publisher may require the
existing explicit runner restart. A next-prompt configuration is not proof
that the running model changed. Runtime-origin drift likewise reports the
observed model without automatically restoring a previous selection.

Home validates the current publisher before dispatching a model transition.
Once the operation returns, Home relays its exact result; a later publisher
change does not turn a known applied switch into an unavailable outcome.

At launch, Happier persists the structured model selection plus exact non-secret resolution metadata: connection revision, chosen protocol, `compatibilityFingerprint`, `bindingSecurityFingerprint`, and the materialization kind. It does not persist a transient compatibility status, a derived materialization fingerprint, or credentials in session metadata.

In 0.3 development, resume continuity uses the retained runtime binding basis
and model to compare actual connection, endpoint, materialization and credential
destination facts. Adapter-version or model-capability metadata drift alone is
not a security change. A model change admitted by the existing launch authority
also preserves continuity when those source/destination facts are unchanged;
the persisted next-launch intent supplies the requested model on Resume.
Actual source/destination changes and hard incompatibility
still refuse or require the existing recovery. Historical records without those
retained facts keep their existing opaque-fingerprint comparison; no missing
historical destination is inferred. Stored fingerprint formats are unchanged.

In the development Session-creation Action path, a daemon Provider rejection retains its validated `ProviderErrorV1` in the `spawn_failed` result, including the Provider's retryability. The ordinary New Session composer uses that result for its existing inline recovery controls. Recovery stays bound to the original launch context; changing the Home, Machine, or Provider selection must not retry the previous request against the new target.

Development Resume alerts use the same Provider-error presentation as Session
creation and retain the specific Provider code in Technical details. Arbitrary
private validation diagnostics remain outside the alert message.

In 0.3 development, a requester Session's protected local custody retains its
Account identity across Stop and physical runner exit. Cold Resume rebuilds the
requester runtime through that custody and uses the same Account-qualified
Connected Account homes as birth. Runner cleanup releases the live runtime, not
the retained Session's private birth. Unavailable requester custody does not
authorize another Account's runtime. Historical custody already deleted by an
older daemon cannot be reconstructed from native transcript files.
For ordinary owner Sessions without private requester birth, a new Resume or
runner native-launch admission captures the currently stored sign-in through
the ordinary Session custody owner. Same-Account bearer renewal does not change
the Session's Account; Home still qualifies the exact Machine and Session, and
a different Account or unavailable retained birth refuses admission.
Resume and Session creation share the existing Connected Service diagnostic
presenter, including `provider_session_state_unavailable_for_resume`; local
paths and native Session ids remain outside the alert.

In 0.3 development, a Connected Account pool keeps its existing
`no_eligible_member` control refusal and per-member pool-selection exclusions.
When every enabled member is excluded for exhausted quota, the same spawn result
presents the existing `usage_limit` launch code and failure cause; finite execution
runs retain that cause too. Mixed authentication and quota refusals retain the
generic code and their member-specific reasons. The start-error presenter groups
those reasons using the usage pool's reason-copy owner. “Sign in again” opens the existing Connect sheet
for a member excluded for invalid authentication; “Use another account” opens
its saved-account selection and updates the composer's existing binding. Neither
action automatically retries Start. A Session committed before this refusal
follows the existing [pre-runner archival and retry contract](./cli-architecture.md#session-spawning).

In 0.3 development, unexpected launch preparation, Agent activation and model
projection failures use the existing `agent_error` result. They do not establish
that the Agent lacks Provider runtime support. The daemon's local file records
`[PROVIDER] Unexpected failure` with the operation, exception class and source
coordinates, or `[PROVIDER] Agent activation refused` with plugin identities and
diagnostic codes. These records omit exception messages, causes, absolute paths
and request/credential content; validated Provider refusals retain their own code.
The shared `[RPC] Request completed` record also retains a structured error
result's bounded code; an unclassified error result is never logged as success.
For model-probe `capabilities.invoke` results, its `modelProbe` projection also
records the closed `source`, `refreshError`, `availableModelsCount` and, when
present, `spawnFailure.code` (the canonical spawn-failure reason). An outer
`ok` result can therefore be distinguished from a nested unavailable probe.
No model rows, names, OS error text or credentials enter this record.

Agent plugins own model-switch policy. A same-session switch may be permitted only when the adapter can apply the new provider/model safely. Otherwise the UI offers restart/fork semantics. Resume and fork re-resolve the exact stored connection and refuse actionably when it was deleted, disabled, changed incompatibly, or lost its required grant/secret.

Deleting a connection creates a tombstone. Existing running child processes are not retroactively rewritten, but new spawn, resume, fork, probe, or model-switch operations must not resolve the deleted connection. Secret access is revoked for future operations.

## Feature gates

Provider surfaces use the canonical feature system:

- `providers` gates first-class provider settings, registry, and resolution;
- `providers.localDiscovery` depends on `providers` and `localServices.inventory`;
- `providers.localModelManagement` depends on `providers`;
- `localServices.managed` gates the daemon Local Services UI product (inventory launch actions, previews, and related controls), not Provider managed-runtime start or supervision.

Dependencies are declared in `packages/protocol/src/features/catalog.ts` and applied centrally. Missing or malformed server bits fail closed before settings, secrets, network, or processes are touched. See [Feature gating](./feature-gating.md).

## Migration and retained compatibility

The migration from overloaded launch profiles is versioned and atomic through account-settings compare-and-swap updates.

In development 0.3, remembered profile evidence comes from the Account authoring-memory row, not the Settings document. After a successful Settings migration, its removal disposition conditionally clears that row only if the remembered profile still matches the captured choice. A repeat run repairs an interrupted clear without overwriting a newer choice. The three shipped 0.2 authoring-memory keys are imported destination-first and retired with exact Settings CAS; unrelated Settings roots are preserved.

- legacy DeepSeek, Z.AI, and OpenAI routing profiles migrate to provider connections;
- Anthropic, Codex, and Gemini machine-login placeholders collapse to **Default Environment**;
- Azure OpenAI remains a legacy V1 launch profile until its richer endpoint/auth model has a dedicated typed provider contract;
- Gemini API-key and Vertex profiles remain Agent-auth configurations, not generic model-provider connections;
- ambiguous user-created routing profiles remain visible and enter a guided migration flow rather than being guessed or deleted.

In development 0.3, retained 0.2 Profiles preserve `defaultBackendTargetKey` at the legacy boundary. Current logical Profiles use `preferredAgentTargetKey`; the shared Profile preference owner also derives an Agent from a native model-only preference. Explicit Session target choices remain authoritative. Exact qualified or configured-definition compatibility overrides win; custom and native Profiles otherwise remain permissive, while historical built-ins remain restrictive. Released configured-container compatibility is read only on its retained legacy shape.

Provider conversion counts an Agent default as a real preference, so a default-only Profile survives conversion. A matching Provider model and Agent preference are retained together. A conflicting initial mapping returns the existing `migration_conflict` refusal before any write, preserving both inputs for a coherent guided mapping. The RPC exposes this as `provider_profile_migration_conflict` with the existing retryable error presentation. Machine-login prerequisites and legacy configured-container wildcard compatibility retain their V1 definition because V2 cannot represent those contracts.

After conversion, a person's current retained Profile preference takes precedence over a historical migration default. A model tied to another Agent remains in migration history and becomes applicable again when that Agent is selected; it cannot retarget the current Profile. The current native model choice likewise precedes migration history. These are current-source semantics, not a mixed-version or rollback promise.

Migration descriptors are plugin-owned provider facts. New writes use provider connections; compatibility readers are boundary-owned and narrowly preserve the deployed legacy shapes.

In development 0.3, resume and respawn restore an omitted Launch Profile identity from the Session owner metadata. An explicit empty identity selects Default Environment. The daemon then uses its existing Account-scoped Profile defaults and saved-secret materialization owners; retained legacy Profile environments are restored through that same defaults owner. Missing, disabled, or migrated Profiles refuse the launch. Saved-secret materialization retains its canonical policy: required bindings and exact one-shot references fail closed when unavailable; optional defaults may be omitted. Persisted Provider resume selection remains authoritative over current Profile model defaults. This requires the updated CLI daemon and adds no new wire or persisted format.

Connected Account resume admission verifies Session files when materialization
relocates the Agent's native home. Credential-only launches, including brokered
Team delivery, retain native Session storage; the Agent runtime owns resume
against that storage. The materializer reports no relocated target for these
launches, even when the Agent declares a native home. A temporary credential
directory is not a relocated Session store. Missing catalog facts continue to
fail the existing reachability check.

In development 0.3, that continuity hook can also inspect a native Session through
`nativeInspection.withDeclaredJsonRpcClient`, using the already-prepared launch
environment and existing probe lifetime. Returning `{ ok: true, proof: 'native_session' }`
proves resume reachability only. It supplies no file path or import authority;
the file-copy path omits native inspection and requires a host-verified declared
path for the legacy `{ ok: true }` result. Muse uses this protocol path to read
the exact native UUID without acquiring or resuming a conversation.

## Adding a provider plugin

1. Create `packages/plugins/<providerId>/src/provider/contribution.ts` and a schema-validation test.
2. Declare stable identity, endpoint templates, wire protocols, capability facts, credential transports, and catalog sources. A wire protocol is the rendezvous key between this Provider's endpoint and an Agent's `acceptsProtocols`; both sides are contributed, so declaring a protocol Happier does not bundle is ordinary — the host matches the two declarations and never interprets the value.
3. Keep an ordinary Provider descriptor-only. For a local descriptor-only Provider, add only bounded declarative detection facts and a provider-specific availability probe. A command-output catalog fallback names its own output format the same way an HTTP catalog probe does, and the declaring plugin implements it with the same registered parser.
4. When the Provider owns a supervised local runtime, declare its single cold `managedRuntime` facet and register exactly one matching runtime with `api.providers.register(localId, runtime)`.
   In 0.3 development source, a runtime that always supplies its declared client credential may set `managedRuntime.credentialRequired: true`, derived from the same canonical client-access declaration used by its runtime. The shared source-fact owner then marks the existing credential slot and transports as required for `managedLocal` compatibility. External connections retain the contribution's ordinary credential requirement. Omit the managed field when the runtime has no such guarantee; `false` is not a declaration value.
   In 0.3 development source, a managed Connected Account purpose may declare `endpointTemplateIds` for its supported downstream broker routes. Each endpoint must belong to that managed runtime and be unique within its purpose; different upstream services may support the same endpoint. The broker validates the signed implementation, exact endpoint/protocol and source service against the current Provider registry, requiring exactly one matching purpose before selecting the declared account. Missing or ambiguous declarations make the route unavailable. CLIProxyAPI projects its proven downstream translations from the same upstream-family contract used by ordinary managed serving; an endpoint alone never selects a vendor or authorizes an unbound account.
   In 0.3 development source, `managedRuntime.unavailableConnectedAccounts` declares passive family identities, titles and localized reasons for the gateway's family presentation. The family projection reads these alongside executable `connectedAccounts`; gateway selection, request-auth uses and endpoint admission consume only executable purposes. Derive both projections from the plugin's one family declaration so displaying an unavailable family cannot activate its adapter.
5. When the Provider's catalog endpoint answers in a wire format Happier does not bundle, name that format in the catalog probe's `parser` and register its implementation with `api.providers.registerCatalogParser(localId, format, parse)`. Happier bundles `openai-models`, `anthropic-models`, `ollama-tags`, and `lmstudio-native-models`; every other declared format is implemented by the declaring plugin, and a format with no reachable implementation fails the probe with `provider_contribution_unavailable` rather than being read by another Provider's parser. Set the probe's `reportsModelLoadState` when the format carries per-model load state, which is what makes model loading available — not whether the host bundles the format.
6. Register every arm the contribution declares. Activation validates the complete declared-vs-registered composite: a Provider that declares a managed runtime and a contributed catalog format must register both, and registering a managed runtime or catalog format the contribution does not declare is refused. A partial registration fails activation instead of silently publishing the half that registered.
7. Add explicit compatibility overrides only for verified pair-specific quirks.
8. Add a legacy-profile migration descriptor only when a deterministic built-in legacy profile exists.
9. Export the contribution through the plugin's generated contribution descriptor path; never register it by filesystem scanning or host-core branching.
10. Test schema invariants, registration correspondence where applicable, endpoint safety, compatibility, catalog merging, connection identity, secret/grant refusal ordering, and any real external integration behind an opt-in lane.

Third-party plugins use the same `contributes.providers` family. Built-ins receive no privileged host path, and the bundled vocabularies below name what the host already implements rather than what a plugin may contribute (the two exceptions that are still closed are listed after them):

- **wire protocols** — `anthropic`, `openai-chat`, `openai-responses`, and `ollama-native` are the protocols Happier bundles an implementation for. Any other protocol id is contributable by a Provider plugin and an Agent plugin together;
- **catalog formats** — `openai-models`, `anthropic-models`, `ollama-tags`, and `lmstudio-native-models` are the HTTP catalog formats Happier bundles, and `ollama-list-table` is the bundled command-output format. Any other format is declared and implemented by the contributing plugin;
- **credential transports** — a plugin declares an HTTP header or query parameter of any validated name in `raw`, `bearer`, or `{secret}`-template form. The five `credentialStyle` presets and three protocol presets in the in-app *custom provider* form are a person-facing authoring vocabulary for endpoints with no plugin behind them, not a plugin ceiling.

Two optional declarations still carry a bundled-only vocabulary. Both are narrow, both are recorded here so an author is never surprised by them, and both name the condition that reopens them:

- **local-readiness shortcut** — `discovery.presenceCheck.parser` accepts `exit-zero-running` or `lms-status-json`. `exit-zero-running` is the general mechanism and is available identically to every Provider plugin, while `lms-status-json` exists for one CLI whose exit code is not a readiness signal. It only refines a discovery status label (`app_running_server_off` versus `installed_not_running`); readiness itself is decided by the required, open-format `availabilityProbe`. Replace the pair with a declarative success criterion if a plugin needs a readiness signal that neither an exit code nor an availability probe can express.
- **model loading** — `modelLoad.request` accepts only `json-model-id-v1` and `modelLoad.confirmation` only `refresh-catalog-load-state`, so a local Provider whose load API takes a different request shape cannot declare model loading today. Everything around it is already open: the endpoint protocol, the catalog format, and the `reportsModelLoadState` fact that makes loading *available* are all contributable. Open the request vocabulary the same way catalog formats were opened — a plugin-registered load requester keyed by the declaring plugin's own id — when a Provider needs a load call the bundled shape cannot express.

`packages/plugins/*/src/provider/verification/*.json` is a first-party review record asserted at build time, not a runtime capability: an external Provider declares the same `compatibilityOverrides` evidence inline and is not subject to that assertion.

External third-party Provider authoring is experimental until a packed plugin completes the generic install, trust, projection, runtime-use, reload/update, collision, and uninstall graduation suite. This does not make bundled Providers or in-app custom Provider connections experimental.

## Validation map

In 0.3 development, the CLIProxyAPI static catalog generator preserves the
pinned SDK's declared `context_length` as `contextWindowTokens`. Managed catalog
enrichment supplies it when a live model row omits the window, making the same
descriptor available to every Agent. Codex provider materialization writes that
descriptor's window as `model_context_window` for app-server configuration and
native CLI overrides; undeclared windows leave the native default unchanged.
Happier does not set a separate auto-compaction threshold. Codex 0.162.1 clamps
this override to its native model's `max_context_window`, including the 272,000
fallback maximum for unknown models. Supplying the override alone therefore
does not establish an effective larger native window or reduced compaction.
See the [pinned native override implementation](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/models-manager/src/model_info.rs).

In 0.3 development, accounting distinguishes a witnessed native model source
from a Provider connection with `providerSource`. Request-bound attribution is
captured from the accepted host runtime binding or the Agent's actual native
request-auth boundary, validated by the host, and retained through Usage ingest and
contribution projection. A later account switch or current Session metadata
cannot relabel an earlier response. Without proof the contribution remains
unknown; a null Provider connection alone never proves native routing. Coach
and Plans consume these response-bound contributions, not current selections.

Codex supplies its immutable identity at native `turn/start` and qualifies exact
`rawResponse/completed` usage only against that native attempt. The pinned
`rust-v0.160.0` and `rust-v0.162.1` app-server contracts emit this internal native
notification with the same response id persisted for collector deduplication.
Its numeric usage becomes a `codex-app-server-response-usage` request delta with
partial history; cumulative
`thread/tokenUsage/updated` counters and context remain readable but never
certify a native request/account, including last-only compatibility inputs.
Natives without the exact completion event retain unknown native-account
attribution. Older scalar servers receive only the unchanged cumulative stream;
its legacy projection excludes the supplemental exact stream because scalar
replacement cannot reconcile it. An in-turn auth application,
refresh or contradictory native account read withdraws that attempt's proof,
including an A → B → A transition. Combined counters remain unknown. An explicit
unknown native witness also prevents substitution of launch proof for a
contradicted response or a last-only snapshot.

The prospective Codex native attribution also carries optional `accountScope`
(`personal` or `workspace`) from the supported native Account plan contract at
that dispatch. Missing or unrecognized plans stay unknown; a later plan read
cannot classify historical Usage. Refresh must not attach the failed Account's
plan hint to replacement tokens. This extends the same request attribution,
not a separate subscription collector or provider-independent attestation.

The connected-service materialization result now has optional, credential-free
`usageAccountScope` in 0.3 development. The service classifies the actual admitted
credential revision; the shared host snapshots the unambiguous actually used
Account at dispatch. If selection remains ambiguous and a workspace-plan
Account is a candidate, the host conservatively records workspace scope so the
request stays excluded from public profiles. Claude subscription
`pro`/`max` classify personal, `team`/`enterprise` workspace, and missing or
unrecognized values unknown. Setup tokens and API keys provide no plan proof.
The protected daemon bootstrap and foreground claim carry this classification;
current Session metadata is never an evidence source. Host-turn-attributed
`turn_delta` usage consumes the snapshot; a native response witness takes
precedence, but a missing native plan scope does not erase captured workspace
scope. Public eligibility excludes known Happier Team credentials and
proved workspace-plan usage. Unknown plans and ownership, API-key usage,
imported native history, unturned observations and cumulative residuals count
through the same reconciliation as private Usage; supplemental deltas and
whole-call totals cannot double count them. The Session model is Account-owned;
Team/Group grants and authored Team context are not Team ownership.

Runtime accounting carries the existing host runtime incarnation and event
sequence as optional ordering evidence. Equal-clock response deltas and counter
snapshots from that same incarnation reconcile in native event order even when
HTTP writes arrive backwards. Other runtime streams and rows without a witness
keep their existing chronological slots. A duplicate may restore its earlier
witnessed position and actual source instant, but cannot change stored counters
or upgrade its native-account proof.

Session admission also carries the exact admitted Connected Account references
beside its materialized launch environment. Foreground admission uses the daemon
claim; daemon-started Sessions use the protected runner bootstrap, written after
successful exact-purpose Account materialization. For that protected daemon
transport, the CLI scoped-environment consumer preserves the materializer's
selection controls alongside the native home; the explicit-key marker alone
does not authorize them. Profile/provider overlays and launches without the
validated bootstrap still cannot supply those controls. Their startup readers forward
the references to the same private late native-open input; the Codex plugin
consumes them as the attribution service identity. A declared target, an
unresolved group or a native home alone does not produce a daemon launch reference.
A credential environment alone does not replace the missing reference or establish personal
scope. Codex attribution still requires the materialized native auth identity
and the exact request's native account-scope read, just as hot-auth application
does. Missing bindings remain unknown rather than being inferred from a current
subscription or used to relabel history.

Provider tests are distributed by owner:

- protocol schemas, settings, migrations, selection, compatibility, and catalog merge: `packages/protocol/src/providers/**/*.test.ts`;
- daemon resolution, probing, discovery, materialization, catalog projection, and lifecycle: `apps/cli/src/providers/**/*.test.ts`;
- provider UI/settings/picker behavior: `apps/ui/sources/providers/**/*.test.ts(x)` and provider-focused UI E2E;
- built-in facts: `packages/plugins/<providerId>/src/provider/contribution.test.ts`;
- real end-to-end flows: `packages/tests/suites/core-e2e/**` and `packages/tests/suites/ui-e2e/**`, gated with the canonical provider feature ids.

Tests mock only system boundaries. Security-sensitive refusal tests must prove that failing enablement, grant, compatibility, or endpoint checks happen before secret lookup and network/process activity. See [Testing](./testing.md).
