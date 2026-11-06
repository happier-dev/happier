# Registry sources

This page owns the registry source architecture in **0.3 development source**.
It is not a release or loaded-runtime certification. The replacement registry
UI remains capabilities-program work.

## Source authority

The Account's existing prompt-library `registry-sources` entity row owns user
sources and disabled built-in/plugin source ids. The current value is version 2;
the canonical reader accepts predecessor rows, retains their ids and skips
malformed entries without discarding healthy sources.

[`registrySourcesV1.ts`](../packages/protocol/src/registries/registrySourcesV1.ts)
merges that row with built-ins and admitted plugin declarations.
[`promptLibraryCatalogV1.ts`](../packages/protocol/src/prompts/library/promptLibraryCatalogV1.ts)
owns encrypted/plain row opening and revision CAS. No machine-local marketplace
source file or client-supplied source list is an authority. An ordinary daemon
fetch reads its Account snapshot and installed declarations; an admitted Action
retains its originating Account's captured context.

Finite CLI/daemon catalog reads activate missing destination rows and run the
existing skill migration, then return after Account currentness admission. They
do not run retained Settings/history cleanup; Account hydration owns that work.
Concurrent folder, skill-rule and usage reads in one captured store share only
the in-flight inventory with the same cancellation lifetime; the next read
fetches again. Registry multi-source listing uses its admitted inventory for
every page rather than re-reading the Account catalog for each source.

User sources may retain a `token.secretRef` and, for plugin catalogs, an
`npmRegistryProfileId`. `registries.sources.token.set` binds or clears these
metadata fields through the same Account-row CAS owner. Built-in and plugin
declarations are not editable credential destinations. Tokened creation proves
the source using the ref before writing the row; clients delegate that operation
through the existing authenticated Action transport, not a fetch request carrying
credentials or a caller-supplied source list.

New token bindings require the canonical private-resource reference. Retained
bare personal ids remain readable for legacy promotion, but cannot become new
bindings; a legacy catalog selection must be imported first. Normal token-bearing
row writes carry the resource's current use/revision proof. The existing resource
owner validates that proof before row CAS and refuses missing, stale, deleted or
unentitled references as `invalid-reference`.

Token refs join the existing Saved Secret reference census, including legacy
promotion and delete-in-use checks. Materialization uses the incumbent private
resource owner and current Account authorization, never persists plaintext in a
registry row, and refuses missing or retired material before network disclosure.
Default HTTP authorization is Bearer; a declared header without a scheme receives
the raw value. HTTP credentials stay destination-scoped. Credentialed Git uses
HTTPS scoped process configuration, never token argv, and refuses redirects:
Git matches scoped headers against the original URL rather than redirected URLs.
The source must therefore identify its final HTTPS destination.

For GitHub repository reads without an explicit source token, source admission
uses the originating Account's existing forge authentication purpose binding.
The Connected Account owner materializes authorization for `api.github.com`;
the transport retains that exact origin and repository path scope. In 0.3
development, an unbound purpose may use the Machine's native `gh` login when
authenticated Machine admission identifies the custodian or grants Manage.
Use-only callers cannot borrow that login; without an available login, the read
is anonymous. Checking a source never selects a connection or changes defaults.
Explicit Saved Secret bindings retain precedence. HTTP throttle observations are scoped to the
credential actually sent (or the anonymous origin), so an exhausted anonymous
quota does not suppress an authenticated Check or a rotated credential.

Raw shared-Machine transports retain their authenticated requester/custodian
admission facts through registry fetch and file preparation. Public sources stay
available to shared callers; a foreign requester cannot materialize the
custodian's private source token. Requester-private operations require the
incumbent original-Account Action transport, not the raw Machine fetch carrier.
UI tokened list/read uses that carrier. Registry-backed skill installation and
update diff/apply keep their pinned file reads inside the whole originating-Account
Action; the retained registry-install shim uses the same custody with its explicit
Machine target. A received content ACK survives later cancellation or projection
failure; preview/read content still requires the captured Account to be current.

Plugin declarations are read-only locations from the existing lazy contribution
catalog. Their Account union retains proven Machine suppliers, including retained
offline declarations for the same Account. Supplier retirement removes the
declaration. Enablement is Account state, not permission to edit the declaration
or disclose credentials. See [plugin ownership](plugin-platform.md).

## Fetch and installation

[`registryHostV1.ts`](../packages/protocol/src/registries/registryHostV1.ts)
executes the one placement decision in
[`registryFetchPlanV1.ts`](../packages/protocol/src/registries/registryFetchPlanV1.ts).
Clients read public GitHub skills over HTTPS and HTTP plugin catalogs directly.
Web `skills.sh` uses a daemon; non-GitHub Git and retained predecessor SSH/Git/local
paths use a daemon on both web and native clients. A plugin source placed on a daemon selects one of its proven
suppliers through the shared reachability owner, not an unrelated administration
target. Explicit retry may try a supplier even when its reachability observation
is stale or unavailable.

Format adapters share parsing and listing rules between clients and daemon
revalidation. A failed source has its own typed status; healthy pages remain
usable. Only transport failures trigger the prescribed fallback. Programming
errors and cancellation are not rewritten as network unavailability. Rate-limit
reset times come from upstream headers. `rate_limited.retryAt` is optional:
without reset evidence the source still reports a rate limit and offers manual
retry, with no fabricated timestamp or host cooldown. The shared HTTP status
reader supplies that decision to both platform and daemon transports.

When upstream supplies a reset time, the transport retains an origin-wide
throttle until that time. At the reset boundary the next request reaches upstream
again, including after a token change; an HTTP 401/403 can then report the rejected
token. Changing a token does not clear an upstream-proven origin throttle.

Skill reads return a pinned pointer. Installation re-reads that version and
verifies Git blob/tree hashes and file modes before writing through `skills.*`.
Each non-GitHub Git request shares one temporary acquisition across its listing,
read and file steps. The SCM transport requests a blobless shallow clone and
reads blob sizes/content only within the selected skill folder; a name listing
needs only trees. Git servers that ignore filtering still work, with one full
acquisition instead. Every Git command, including lazy blob fetches, retains the
same source-scoped credential environment and cancellation signal. Acquisitions
are removed after the request's readers settle; no registry cache survives it.
Claude marketplace imports only skill bundles, not hooks, commands, Agents or
MCP servers. Plugin browsing contains published discovery facts; install review,
machine credential profiles and installation remain daemon-owned. Exact plugin
revalidation selects the reviewed version, not the current latest version.

Agent browsing also selects plugin listings whose canonical contribution summary
includes `agents`, from npm and Happier catalogs. Existing plugin-only Account or
plugin-declared catalogs gain this kind in the effective source projection;
stored source kinds remain unchanged. These rows and detail payloads keep their
plugin identity and pinned version, so their install handoff uses `plugins.install`
and the daemon's existing Install & Trust review. Curated Agent browsing combines
ACP pointers with these plugin picks. Npm continuation follows the upstream search
page, even when some packages are filtered out; its unfiltered total is omitted
from Agent pages. The daemon's marketplace source projection accepts Agent-only
catalogs for this install handoff and retains the Account's enablement, token
reference and npm credential-profile binding.

### Curated picks and homepage suggestions

The curated marketplace snapshot carries optional registry pointers in `picks`;
older snapshots read as an empty list. Only a curated source may publish them.
The website generator validates and emits these pointers through the same strict
schema that clients read. The committed list remains empty until release selects
and publishes its contents.

The catalog adapter resolves each pointer through the existing target adapter.
Skill pick identities include their format, source URL, subdirectory and native
item id, so two root skills cannot install from the wrong repository. Read and
download retain the reviewed version and the target's native Git ref. The host
applies the same placement rule to each target. Browsing a daemon-only target
keeps an unversioned pointer row without a Machine request; its explicit details
read and file download send the original catalog pointer through the existing
registry RPC. The daemon re-resolves that published pointer and uses its SCM
reader, so no request supplies a target source override. Agent
item ids remain native; ambiguous pointers cannot be added. A removed target is
an item problem; an empty or unreachable picks catalog is quietly omitted for
that kind. Plugin catalog failures keep their normal source status.

`useRegistrySuggestions` reads through the existing registry Actions and session
memo. It prefers picks, then the first enabled built-in whose canonical fetch
plan is direct. Web skills have no fallback because skills.sh browsing requires
a daemon; native skills may use its first page. Homepage open never schedules a
daemon browse. The Skills homepage data model supplies these shelf inputs;
the shelf's visible composition remains capabilities-program UI work.

### MCP Registry

The development-source MCP reader is registered with the same generic source
and fetch owners. Public v0.1 catalogs browse directly on web and native clients;
tokened sources retain the daemon path. List paging and name search use the
Registry API, with its 100-item page boundary. A pinned read checks both server
identity and version before passing the normalized payload to MCP Actions.
Published file hashes remain data; this reader adds no checksum confirmation.

`mcp.servers.create` and registry updates use one mapping owner and one catalog
CAS. Npm entries retain exact package versions and use the existing managed
package runner. Pypi entries retain exact `uvx` selectors; managed uv is supplied
by the package-runner owner, and an unavailable runtime is reported by Test.
OCI entries use the machine's Docker. MCPB, NuGet and Cargo execution is not
admitted. The Registry schema carries no OAuth discovery fact: an existing
explicit sign-in choice selects OAuth rather than guessing it from an address.

Import and Found adoption require explicit choices for every named environment
or header value. Saved Secret creation uses the canonical private-resource
Action and its returned reference. Preview and observations omit literal secrets;
approval input remains live-only. A partial secret creation or catalog failure
returns acknowledged references so a retry can reuse them. Registry updates keep
the person's name, values, tool settings and reach rules, and refuse a newly
required input until supplied. Update observations use the generic checker and
catalog CAS, write only changed state, and never auto-apply third-party content.
Paste imports default a bare `url` to Streamable HTTP, preserving the 0.2
parser. An explicit `type` or `transport: "sse"` selects SSE; in a config with
a sibling `httpUrl`, Gemini's `url` selects SSE and `httpUrl` selects HTTP.
The preview exposes the selected transport; an explicit revised choice is
used when adding. Parsing performs no network probing or URL inference.
Registry URL-variable values materialize only in private bridge configuration;
the bridge's existing credential lease redacts those values from server echoes
and transport diagnostics (see [encryption](encryption.md)). These are
development-source contracts; composed program acceptance remains separate.

### ACP Registry

The development-source ACP adapter reads the registry's `1.x` index envelope
and projects platform targets into the existing pinned-archive vocabulary.
Package distributions need exact npm or uv versions; an unpinned entry remains
an unsupported item rather than acquiring an inferred version. Published
SHA-256 values are retained, and their absence stays explicit. The reader does
not decide whether a binary URL is an archive or a raw executable.

[`mapAcpRegistryAgentV1.ts`](../packages/protocol/src/acp/catalog/registry/mapAcpRegistryAgentV1.ts)
owns the definition mapping and distribution choice: npm, then binary, then uv.
It carries registry provenance into the Account ACP definition and retains the
person's definition identity, environment edits and session defaults on update.
The same platform-fit owner handles mapped launches and registry previews;
unknown platform facts remain unknown, and bzip2 archives remain unsupported by
the current extractor. uv packages use the host-managed uv owner through the
existing install job and first-use path; their Python and tool state does not
depend on a system uv installation.

List summaries carry `agentDistribution`: the selected npm/uv kind, or binary
platforms with extraction support. The reader derives this small presentation
projection through the existing distribution-selection and platform-fit owners;
it includes no download URLs, commands or environment values. Add-agent rows use
it before details are opened, so unsupported targets and archive types can show
Can't run here without another fetch. Missing Machine facts still show unknown.

The upstream endpoint publishes a current index. A read at a reviewed version
refuses an entry whose version has changed; it cannot silently substitute the
latest version or promise that historical registry versions remain available.
The live-schema fixtures record their upstream URL and capture date.

## Actions and lifecycle

`registries.*` and `skills.*` use the canonical Action executor, spec-owned
approval policy and generated CLI leaves. The present user's reversible writes
act directly; deletion and installation follow their declared confirmations.
Agent, CLI and MCP requests ask by default. The generated Action reference owns
the exact inputs and outputs.

Read memos are scoped to the captured Account and source revision. They do not
grant access or replace current source authority. Failed refresh can preserve
last-known items only for the same Account/query/source identity; removal,
disablement or supplier retirement withdraws old results and install authority.
Acknowledged content/native exports survive a later failure as explicit partial
receipts: callers must repair the unfinished step rather than repeat the write.

The legacy `prompt_registry.install` adapter retains predecessor argument
normalization but delegates skill/content decisions to the current owner. It
drops `configuredSources`; there is no alternate registry list or daemon install
path behind that compatibility input. Prompt-asset native export is a separate
filesystem operation, not another registry decision-maker.
In 0.3 development the same adapter is available to Agent and MCP callers,
with approval by default and user-changeable surface waivers.
Its outer Action result also owns external-links settlement: a conflicting or
unavailable row write returns a failure with the already-acknowledged Artifact
and native export effects. A host's successful export receipt plus a failed row
settlement is not total success, and the caller must not repeat that export.

## Update observations in development source

`registryUpdatesV1.ts` checks upstream content through the existing format
adapters. Git content compares subtree hashes, not unrelated repository commits;
version registries compare the published version strings. Source failures remain
typed `unchecked` results and never overwrite the item's last successful state.

`registries.updates.check` is the one manual Action. The UI delegates it through
the captured originating-Account Machine Action transport. The CLI and daemon
compose the same checker with Skills, MCP and Agent trackers. Agent observations
update only `origin.upstream` through the ACP catalog CAS: they preserve launch
pins, environment edits and session defaults, and duplicate observations write
nothing. A registry Agent update remains an explicitly approved
`agents.acp.backends.installFromRegistry` Action. Plugins retain their existing
update policy.
The registry Action declarations admit original Account roots so this transport
can reach the daemon while retaining Account placement, strict inputs and the
existing approval policy. Expected upstream failures return per-item `unchecked`
reasons; a headerless rate limit has no reset time and requires manual Retry.

An unchanged pending skill update is still eligible for its explicit automatic
policy, including when that policy was enabled after the last check. The same
checker invokes the skill owner's existing CAS/apply operation; it does not
rewrite an unchanged observation or introduce another schedule.
Daemon start and Session spawn reuse one daemon-lifetime composition on the
installables gate's `registry-items` key and configured interval. There is no
registry timer or new persisted cache.

The skills operation writes `skillLock.upstream` only when state or the latest
pointer changes, using the existing Artifact revision CAS while preserving the
bundle body. A check whose installed baseline moved does not replay its write.
Only an explicitly selected `auto` policy on an unmodified skill fast-forwards
through `skills.updates.apply`; third-party imports default to manual, and
modified content waits for per-file choices. `checkedAt` is the manual check's
returned observation, never an item timestamp. R5 diff inputs continue through
`skills.updates.diff` and its strict file/cost schema.

## Related

- [Published registry guide](../apps/docs/content/docs/extending/registries.mdx)
- [Plugin platform](plugin-platform.md)
- [Encryption](encryption.md)
- [Compatibility](compatibility.md)
