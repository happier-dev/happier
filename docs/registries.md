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

UI registry browsing and Registry Actions share the Account's exact
`registry-sources` read. An active row is read through its own endpoint and
refreshed on relevant Home changes. If the row is absent, the existing retained
Settings transfer initializes only this row. Full Prompt Library consumers own
catalog activation and Settings/history maintenance.

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

The registry request validator requires HTTPS links without embedded credentials.
Its typed input refusal passes through the Action failure projection to the Add
form's existing registry presenter, so these refusals explain how to correct the
link separately from a source that could not be reached.

Marketplace detection uses the same published source-identity binding as listing
before Add saves the source. A URL alias, including a different query string,
must match the catalog's declared URL and derived source id; returning the same
JSON at the alias does not establish that identity. Binding refusals retain the
registry's typed status in the Add form.

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
Machine-local npm profile snapshots and private-profile template acquisition
are available to admitted Manage callers, including agents acting for their own
Account. Public template reads without a selected private profile retain Use.
An externally carried private acquisition consumes one installation-signed
declared-purpose admission from Home's canonical Account Action Machine admission
owner before reading the profile credential; npm requests and retries consume
that result. A refusal preserves Home's `access_denied` and `requiredRole: manage`
in the registry status and template Action failure details. This does not
grant access to another Account's Saved Secrets or Connected Accounts.
UI tokened list/read uses that carrier. Registry-backed skill installation and
update diff/apply keep their pinned file reads inside the whole originating-Account
Action; the retained registry-install shim uses the same custody with its explicit
Machine target. A received content ACK survives later cancellation or projection
failure; preview/read content still requires the captured Account to be current.

Theme listing acquisition uses this same requester-safe carrier for tokened
sources. The placement owner carries the internal `registryThemeContent` operand
inside the original Account envelope and opens it into executor context; the
daemon registry host consumes it as `themeContent`. Ordinary
`registries.items.read` input remains metadata-only. In E2EE mode the operand is
inside the encrypted request payload. The public Open VSX source keeps its
existing direct/browser and native/daemon placements. Opening an unversioned theme
resolves latest in the acquisition itself, without a preceding metadata read.

Theme cards use published summary miniatures when available. Otherwise, the
existing measured near-viewport owner admits package acquisition as a card
approaches the visible page. The theme registry lifecycle reuses acquisitions
by Home, Account, source, item and package version, including concurrent card and
listing reads. Scrolling back does not reacquire the package. Pending cards keep
their preview geometry; failed acquisitions retain the icon and name without
retrying on scroll-back. Opening the listing or explicitly trying again can
recover a failed acquisition through the same owner.

Open VSX category=Themes also returns icon and product-icon extensions. The
format owner reads the versioned manifest through that same acquisition and
settles an empty colour-theme contribution without downloading its archive.
The lifecycle retains this negative result per Home/Account/source/item/version.
The listing immediately removes known negatives through the existing Collection
projection, leaving no empty grid cell. Acquisition uses the near-viewport owner's
existing prebuild margin so discovery can finish before a card enters view;
late exclusions reflow through the same list layout. Network/parse failures
remain recoverable failures, never negative theme classifications.
Selected ZIP paths prefer an exact entry. When it is absent, one unique
case-insensitive match is accepted for theme files and includes; zero or
multiple matches remain unreadable. All-entry skill ZIP imports retain their
archive entries and original paths.

Open VSX npm-style `SEE LICENSE IN …` declarations project to a custom-licence
classification in listing metadata. The detail translates its label and opens
the advertised licence-file URL when available; neither lookup nor acquisition
fetches that document. Ordinary declarations remain unchanged, and a missing or
malformed optional document URL leaves the theme usable without a link.

Versioned `appearance.themes.store.get` inputs require matching unreleased 0.3
UI and Protocol readers; older development readers reject the added version.
Omitting the version continues to resolve latest within acquisition.

The Store's existing listing controller and body present acquired theme faces in
both pane and page layouts. Opening a versioned listing reuses its card's
acquisition. Closing the listing releases the open-listing reference but retains
the versioned acquisition and local try-on; one shell host presents its
origin-aware Keep/Install and Revert controls. Installing the inspected preview
uses Keep and its acquired package, while an explicit Install resolves latest.
Installed faces expose the
canonical Uninstall Action and its approval. Removing them preserves user-owned
copies; a missing selected Artifact renders the mode's base without rewriting
the saved preference.

Plugin declarations are read-only locations from the existing lazy contribution
catalog. Their Account union retains proven Machine suppliers, including retained
offline declarations for the same Account. Supplier retirement removes the
declaration. Enablement is Account state, not permission to edit the declaration
or disclose credentials. See [plugin ownership](plugin-platform.md).

An app-only `happier-catalog` declaration may instead name inert
`packageContent.path` data. Its projected source binds the owning Plugin version
and installed occurrence, without inventing a remote URL. A supplying daemon
reads the declared file beneath that occurrence's package root through the
existing installed-Plugin runtime lease. Selection rechecks the same declaration,
version and occurrence; retiring or replacing the occurrence withdraws that
source rather than allowing a stale read. Reading catalog data does not activate
the Plugin.
Remote app declarations likewise retain an observed active Plugin version and
occurrence in `origin.contributor`. Each selected read admits the enabled app
source through the registry owner. Supplier occurrence is provenance: reloading
the Plugin does not change an otherwise identical selected content pin. Existing
non-app declaration outputs are unchanged.

## Declarative app inputs (0.3 development source)

App browsing and selected reads use the same registry Actions and source authority
as the existing kinds. The normalized
[`DeploymentTemplateV1`](../packages/protocol/src/plugins/contributions/deploymentTemplates.ts)
descriptor has wire epoch `deployment-template.v1`. It contains reviewed Compose
data and declared variables, generators, Domains, volumes, data/export facts and
optional login or first-run hints. It has no author callback or installation hook.
Generated credentials are selections of host-owned profiles; literal secret
defaults and executable generator fields are rejected.

In 0.3 development source, a routed template Domain may declare
`healthCheck {path, expectStatus}`. Compose normalization retains an authored
probe or derives it from a supported exact HTTP-status assertion. Missing or
opaque probes do not block ordinary reviewed installation: health remains
unknown and displays as **Not checked**. There is no generic path or HTTP-status
default. Caddy adds neither an active probe nor a private health authentication
exemption when the declaration is absent. Supplied declarations remain strictly
validated. The reviewed Domain projection retains the optional declaration,
while `domainBindings` selects only the hostname.

Catalog Install for a template with a required Domain creates the Environment,
runs the existing reviewed deploy, then adds the Domain after deployment succeeds.
A refused or failed deploy returns its typed result with the Environment retained
and no Domain created. Store retry applies the template to that retained
Environment with a new deploy attempt, then adds the Domain; it does not replay
Environment creation. Templates without a required Domain retain their existing
creation behavior.

`happier-catalog` accepts inert app data (`schemaVersion: 1`, with `apps` entries
containing an `itemId` and `app` descriptor) and curated pointers into an app
format. Happier Picks includes app pointers. The built-in **Service templates**
source selects the Coolify catalog; its `coolify-templates` adapter lists the pinned service-template index
without decoding its embedded bodies, then reads only the selected YAML.
The built-in **Dokploy templates** source lists the published `meta.json` index,
then reads only the selected app's Compose and TOML pair. GitHub sources can use
the repository's blueprint metadata when its aggregate index is generated only
for publication. The `dokploy-templates` adapter translates declarative variables,
generated credentials, Domains and public files through the shared Compose
normalization owner. Exact public file contents travel with the stored source;
native contained bind paths remain Compose binds. Review includes the Compose
document and these files, so host mounts and vendor path mismatches stay visible.
Dokploy's sibling `files/` root becomes a contained project path without changing
a vendor file into a persistent volume or injecting unused environment values.
Unsupported helpers or mappings remain
`needs_review`; template expressions are never executed. Neither format accepts
another registry kind. Their parsers do not own credentials, placement or
deployment execution.

In 0.3 development source, the selected Dokploy `supabase` app additionally maps
HS256 JWTs and hexadecimal hash helpers to inert host profiles. JWT claims are
restricted to Supabase's `anon`/`service_role` role, issuer and fixed expiry;
timestamp substitution is accepted only inside those claims. Hash lengths count
hexadecimal characters, and composite API-key prefixes remain literal. Preparation
orders each generated signing secret before its tokens. Install and preview
creation share signing material only within the admitted generation operation,
then release it; results and bindings contain Saved Secret references only.
Generating tokens from a caller-selected existing signing secret remains
`template_needs_review`. Secret-bearing mount contents, unsupported helpers and
unsupported environment-array entries also remain review diagnostics, so this
exception does not make the full upstream Supabase template installable.

In the development source, a selected app with available source bytes can carry
`reviewSource` in its `needs_review` result. Store and Environment Add let the
person edit those inert source bytes and explicitly check the mapping again.
The optional `appMappingCorrection` follows registry reads and template
preparation through the same format adapter and strict descriptor parser. It
retains the original selected source reference and version; unresolved mappings
remain review-only. The correction belongs to that review and is not saved as a
second catalog or template record. Missing upstream bodies remain unavailable.

Store preparation and Environment Add collect public values, existing Saved Secret
references and named-volume choices before installation. The shared catalog
binding builder retains explicit choices and adds defaults only for generators
that were not selected explicitly. Environment Add offers existing services from
the template planner's preview for `connectTo`, with an explicit list of variable
keys to replace. Editing these fields performs no Action; the person requests
another review before confirming Add. Agents pass the same typed bindings,
`volumeBindings`, `connectTo` and `replace` to the template Action.

The daemon retains one admitted immutable Coolify catalog read per Account,
source and resolved commit: its index and the selected YAMLs acquired so far.
Separate preparations share in-flight and completed resource reads. Cancelling a
preparation stops its own wait while other preparations can finish the shared read. A full
40-hex commit pin bypasses commit-API resolution; listing loads and explicit
update checks retain their existing latest-revision resolution. Each source
keeps its latest admitted resolved commit plus older commits still being consumed;
an older entry is released after its last read settles. This process-local
retention has no TTL and does not replace source or credential admission.
Upstream reset headers still own rate-limit recovery. A rate-limited currentness
check settles with the typed status and optional `retryAt`, while an admitted
immutable pin remains readable. The registry owner schedules no retry loop.

The first-party `happier.deployment.templates` Plugin declares the packaged
`data-services` source. Its `postgresql` item supplies a PostgreSQL 17 service,
an internal endpoint, declared username/database/password inputs, a logical-dump
backup descriptor and direct `DATABASE_URL`/`DIRECT_URL` exports. The password is
a secret input, not a catalog default. Its optional `pgbouncer` companion is off
unless the review selects it (`companions` on `deployments.templates.instantiate`).
Selected, it adds a pinned `edoburu/pgbouncer` service in transaction mode with
SCRAM and `max_prepared_statements=200`; the image writes its own auth file at
start from the same `DB_USER`/`DB_PASSWORD` bindings passed as ordinary env, so
there is no Happier-written credential file. `DATABASE_URL` then points at the
pooler and `DIRECT_URL` stays on PostgreSQL for migrations and session features
(SET, LISTEN, advisory locks, WITH HOLD cursors, SQL PREPARE). Query, backup and
restore always use PostgreSQL. Unselected, the companion's service leaves the
document. This is development-source catalog data;
availability still requires the supplying Plugin occurrence and the deployment
journey below.

A selected app returns its descriptor and immutable content reference. Git
references retain the admitted commit and the native tree identity of the
selected files; HTTPS app data uses the selected descriptor's canonical content
digest. Re-reading a different pin refuses rather than substituting latest.
Packaged data uses a `packageContent` reference containing the Plugin id, version,
installed occurrence, declared path and selected descriptor digest.
Pin comparison retains the id, version, path and digest; the recorded runtime
occurrence does not veto unchanged content from the current admitted supplier.
Catalog changes do not mutate an Environment or create secrets. Template
instantiation still depends on the deployment owner's admission and sole
definition/provenance writers; registry read support alone does not establish
that deployment journey.

The source-derived format preserves its declaring service's routes, Compose
healthcheck and volume data. Supported dialect translations become standard
Compose; unsupported mappings remain `needs_review` with field diagnostics.
One host-owned source/item hint table adds only existing descriptor fields. Its
source id, built-in origin, format, URL, path and source ref must match the actual
built-in declaration. Curated pointers retain that source id only for the exact
declared app catalog; user and plugin source aliases do not borrow its hints.
Uptime Kuma is marked as first-run setup without inventing login credentials.
Its authored Domain probe uses `/api/entry-page` with HTTP 200, matching the
[public Uptime Kuma 2 endpoint](https://github.com/louislam/uptime-kuma/blob/2.0.0/server/routers/api-router.js).
Unresolved items remain review-only even when a hint exists.
Native icon tokens and `minversion` remain upstream metadata, not a Happier
version floor. Git-backed native icons resolve to the pinned repository's public
assets; HTTP-only relative tokens are retained without guessing an asset URL.
Catalog licensing is distinct from application-image licensing. The inspected
source catalog's Apache-2.0 licence is at
[`coollabsio/coolify`, commit `e4c1e1a6b32c7770de71456a73df8af250480df7`](https://github.com/coollabsio/coolify/blob/e4c1e1a6b32c7770de71456a73df8af250480df7/LICENSE).
The separate Dokploy catalog is fetched from its public source; this does not
establish permission to redistribute that catalog or its application images.

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

The Registry host omits a Happier-picks kind only after a successful zero-item
answer. Failed pages retain their status and source choice so Add and Store can
show the reason and manual Retry through their existing source-state bindings.

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

Exact plugin install acquisition in 0.3 development source also consumes this
Registry host and its `happier-catalog`/`happier-npm` adapters. CLI execution
passes the exact source/package/version pointer to daemon admission, where the
Account-bound host acquires the listing once. Its host-local `withSource`
operation shares one admitted source descriptor across discovery and the exact
read; the next installation reads the current Account source again. The
marketplace service projects Machine-local artifact-profile availability and
full-review admission from the selected published listing; editorial display
and installation policy remain separate consumers. The retired marketplace
loader and its disk cache no longer acquire installation facts. Package-targeted
npm installs read the exact package/version directly; retained plugin-id-only
requests use Registry search to locate the package first. Download integrity,
signature verification, archive extraction and daemon install admission stay
with the existing distribution and installation owners.

Plugin Browse in 0.3 development source consumes admitted lightweight summaries.
Their optional `pluginListing` projection carries published publisher, categories,
contributions, realms, platforms, review, update policy and links; host-access
details and executable distribution operands remain in the selected payload.
`usePluginCatalog` shares the existing Registry list/read owners across Browse,
listing pages and selected panes. Opening a list does not read every item body.
Older summaries without those facts still show title, description and version,
without inventing review or installation eligibility.

New Plugin listing links carry `sourceId`, native `itemId`, Plugin identity and
the reviewed version. For npm the native id is the package name, not the Plugin
id. An exact link reads that coordinate directly and rejects a returned Plugin
identity mismatch. A legacy catalog link can use the format's Plugin-id identity
or an already admitted summary. A cold npm link without its native locator offers
source-filtered Browse; it never guesses a package name or scans a source to
pretend the link was exact. Registry refresh reconciles summary content while
source observation time remains on the page; unchanged rows retain identity,
and Account/source retirement still withdraws their authority.

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

### Catalog logo metadata (0.3 development)

The MCP format adapter retains upstream `icons[].theme` in list summaries and
selected detail through the same normalization owner. `iconUrl` selects the first
declared light icon, otherwise the first unthemed icon. Optional `iconDarkUrl`
selects the first dark icon, otherwise an unthemed icon when light has its own
variant. Unthemed and absent icons remain valid. Strict Registry summary/payload
schemas and generated SDK Action DTOs carry these display facts together.

The host admits these URLs into its private brand projection once and chooses
the supplied variant for the theme. Without a dark variant, it keeps the supplied
coloured image; it does not guess contrast or recolour arbitrary artwork. Missing,
refused or decoder-broken artwork uses the shared bare-letter fallback. This
path performs no image preflight or registry/body read during rendering and
forwards no registry credentials to image origins. The platform image host may
acquire and decode its selected URI. Public plugin image props gain no URL input.

MCP registry create/update retains the selected item's optional `iconUrl` and
`iconDarkUrl` in its existing catalog origin. The Account-scoped catalog snapshot
admits that artwork beside the saved entry, so installed rows, home marks and
detail reuse the same projection after reopening. Older entries without artwork
keep the shared fallback; reopening does not fetch a registry item to fill it in.

These optional fields are presentation data, not package, pin, credential or
installation authority. Current readers accept older `iconUrl`-only output.
Matching strict development producers/readers move together; optional fields do
not imply support for an older strict reader receiving new output. No migration,
dual writer or new registry epoch is introduced. See [compatibility](compatibility.md#sdk-protocol-evolution).

### Curated picks and homepage suggestions

Store Discover also accepts optional closed `discovery.suggestions` mappings in
the same catalog payload. A mapping names a local admitted item and a repository
hosting kind (`because: { kind: 'repository', hostingKind: 'github' }`, for
example). It grants no execution or installation authority. The one pure
`matchRegistryProjectSuggestions` projection matches these mappings against
repository identities already held in the authorized selected Project's complete
Account snapshot. It returns the actual checkout/repository fact as its
explanation, never scans, probes, enriches or reads another source. Native Project
identity and Account admission remain with their existing owners. Refused or
retired facts withdraw suggestions; absent mappings produce no row or placeholder.
The approved editorial source currently contains no suggestion mappings.

Store Installed reads daemon Plugin details only for an explicitly selected,
admitted online Machine. `usePluginMachineDetails` owns that demand/cache/reconnect
lifecycle and is shared with Plugins administration; the administration wrapper
alone selects from its existing preference. All other placements use recorded
Account inventory. Held rows preserve the native Account identity and may carry
the selected Machine's native detail for presentation. The existing capability
cache receives the captured Account lifetime; retiring it cancels the read and
cannot disclose an old Account's cached answer in a successor scope. Native Skills
retry and selected Plugin refresh are demand-bound continuations, never background
pagination. A failed MCP read exposes its existing scoped catalog refresh for
explicit Retry; a complete MCP, Agent-definition or Provider read has no
fabricated pagination. Family failure and partial-coverage disclosures remain
visible beside retained rows, across Kind/Machine/Project grouping and no-match
results.

In 0.3 development source, Installed and the Machine inventory also compose P30's
recorded adopted watches. These are Machine-owned configured subjects, not native
health or installation observations. Rows open the exact watch's existing
Machine Services page; Environment-owned services remain with their App. Reading
this composition starts no discovery, service-control or log read. Software and
watched services use the same section renderer in both entry points.
Installed Software recipe rows offer one Remove action: a single installation
opens the shared setup review directly; several installations first require an
explicit choice of one installed Machine. Native preparation owns removal offers
and unselected items stay installed; the shared review confirms the exact input
through `machines.setup.remove` and its existing approval continuation. The App
family consumes the deployment inventory producer's Account-wide or exact-Machine
page and explicit continuation. App rows in both doors use the deployment owner's
Environment link, including Apps without a checkout. This does not establish
complete operational inventory.

The curated marketplace snapshot carries optional registry pointers in `picks`;
older snapshots read as an empty list. Only a curated source may publish them.
The website generator validates and emits these pointers through the same strict
schema that clients read. The committed list remains empty until release selects
and publishes its contents.

The catalog adapter lists pointers without opening their targets. Optional
`display` supplies lightweight title/description; older pointers use their native
item/path/repository label and have no version until selected. Skill pick
identities still include format, source URL, subdirectory and native item id, so
two root skills cannot select the wrong repository. Only the selected pointer
reaches the existing target reader and placement rule. Exact read and download
retain its requested pin and native Git ref; daemon reads carry the original
catalog pointer, never a caller-supplied target override. Unknown or removed
target facts are reported by that read, not guessed during browsing. Agent item
ids remain native; ambiguous pointers cannot be added. An empty or unreachable
picks kind remains quietly omitted; Plugin catalog failures keep their source
status.

Development catalog admission also accepts optional inert `discovery` data:
lightweight items reference existing Registry pointers, qualified Provider
contributions or native Agent targets. Featured, category and job choices refer
to those local item ids. Missing choices and executable operands are rejected.
This data grants neither activation, installation authority nor review status.
Plugin-declared catalogs bind only references to their own published source id
to the admitted declaration id; external references retain their native source.
Old pointer-only catalogs project the same cross-kind discovery data without
target reads. This prepares readers; no new production catalog publication is
implied. Independently published readers must be ready before new outer fields
are published because older catalog readers are strict.

The development website catalog source now carries the approved six-job
editorial copy. Its generator emits only already-supported native references;
explicit pending App, Software and bundled-only plugin bindings remain source
review gaps, not runtime choices. The pending featured app has no substitute.
Job/category membership is projected through those same admitted choices, so an
empty group does not claim a complete database, backup or media setup. Exact
public npm entries still require their existing approved release facts. Local
generation does not authorize production publication: dev rendering uses an
ordinary admitted HTTPS user Registry Source, without changing the built-in URL.
For that dev path, call the same `generateMarketplaceCatalog` with an explicit
`sourceUrl` for the already-authorized HTTPS catalog location and a scratch
`publicDir`. The canonical marketplace URL/id helpers and Registry source
projection bind the output to that location as a user source. The default build
still emits the canonical curated production binding. Admit the matching native
marketplace source id through the ordinary Registry Source owner; serving the
production-bound bytes at another URL is correctly rejected, not a dev bypass.

`useRegistryCuration` in the existing suggestions owner acquires all enabled,
admitted `happier-catalog` sources through one Registry Action composition;
an explicit `sourceIds` selection narrows that scope. Each source is acquired
once for the presented surface, including ordinary dev/user sources. Its
admitted discovery payload is shared by featured/job/category and kind-shelf
consumers; hidden demand reads nothing. Item placement keeps the first occurrence
of each full canonical reference, preserving distinct sources and version pins.
The Store's optional Project scope is an explicit qualified Project reference in
its route, encoded and parsed by `pluginsSurfaceRoutes`. The Project menu's
Browse Store entrance uses `workspace.tabs.open`; the header's shared Project
picker changes or clears the route selection. Current Account Project rows
validate it before Discover receives `project` or Installed receives `projectKey`.
Unknown, removed or inaccessible Projects fall back to the no-Project view.
The development Store also accepts a qualified `{ serverId, machineId }` route
hint through `pluginsSurfaceRoutes` and `useStoreMachineScope`. Store navigation
and listing pushes retain it; App preparation captures it when its review opens.
It seeds the existing Machine picker only in the matching Home. The picker's
current Account census, installation and presence rules still decide whether it
can prepare, and the person can change the choice. Malformed hints select nothing;
there is no remembered Machine setting or extra Machine read.
Discover matches admitted editorial predicates only against held Project facts;
its explanation retains the native checkout and repository reference. Missing,
false or retired facts remove recommendations without repository or Machine
scans, additional reads, a scope store, or ambient current-Project selection.
`useRegistryItems` reconciles this content separately from fetchedAt, retaining
unchanged item identities across refresh. `useRegistrySuggestions` consumes that
shared result (or owns it for a standalone homepage). It prefers picks, then the first enabled built-in whose canonical fetch
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
unknown platform facts remain unknown. The in-process release extractor supports
ZIP, tar.gz/tgz, tar.xz and tar.bz2/tbz2 without system decompression tools;
bzip2 streams pass through the same archive budgets and path validation as xz,
and registry-pinned SHA-256 verification is unchanged. uv packages use the host-managed uv owner through the
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

## Pets in 0.3 development source

The shared registry host supports `codex-pets.net` and `petdex.dev` through
[`pet` adapters](../packages/protocol/src/registries/formats/pets.ts). Listings
retain publisher credit, sheet metadata and source rights/report links. A selected
`readRegistryPet` acquires the package manifest and sheet through the existing
admitted HTTP plan. Public native reads need no Machine. These sources are
ineligible for direct browser HTTP because their listing APIs do not establish
the required CORS contract; web uses the existing Machine carrier or returns
`needs_machine` when no eligible Machine is available. Browse and search recover
through the existing carrier subscription when a Machine becomes reachable.

Sheet bytes use base64 across the JSON carrier and become bytes at the host API.
Account library provenance retains only `{kind: 'registry', sourceId, itemId}`;
the registry item id may differ from the package manifest id. Upstream sprite
version labels remain informational: the Account import validator derives the
atlas version from decoded sheet dimensions. Pet adapters do not define an
update lifecycle.

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
In 0.3 development, first-page listings are reused per source across Store views,
including settled unreachable pages, so navigation does not retry known failures
or refetch healthy siblings. Source descriptors share the same Account/source
revision memo, including their kind-specific Picks emptiness read; explicit Retry
reacquires them. Rate-limited pages retain
last-good rows and discovery metadata across navigation, with an “Updated earlier”
status and manual Retry; no idle timer refetches them. Discovery artwork consumes
listing summaries rather than fetching an item's installation payload per card.
Native Compose catalog adapters own the query projection of their complete
summary page. Local searches reuse that page; remote searches and cursors retain
their upstream operands. Explicit Retry acquires a new complete page.
Initial unfiltered Apps browsing holds its layout until editorial sections are
known, including after a cold failure and recovery. Retained editorial layouts
remain readable during outages.
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
In 0.3 development, failed check results also carry the native `sourceId` and,
when its descriptor was available, `sourceTitle`. These optional display facts
let Updates name the failing source without another catalog read. A refused
Environment read has no admitted source to disclose; older results may omit
both fields. The reason remains the existing source-status value.

Exact Environment app checks resolve only the requested occurrences before
upstream acquisition. Git-backed Compose catalogs use the selected file's blob
metadata. HTTPS-only Compose catalogs hash that same selected raw YAML through
the existing read/pin owner, without normalizing it or decoding index-embedded
bodies. Multiple demanded occurrences of one item share that selected read;
unrelated bodies remain unopened. The existing HTTP transport conditionally
revalidates the index and selected body when upstream supplies ETags. A denied
read remains unchecked even when that transport holds earlier successful bytes.

`registries.updates.check` is the one manual Action. The UI delegates it through
the captured originating-Account Machine Action transport. The CLI and daemon
compose the same checker with Skills, MCP and Agent trackers. Agent observations
update only `origin.upstream` through the ACP catalog CAS: they preserve launch
pins, environment edits and session defaults, and duplicate observations write
nothing. A registry Agent update remains an explicitly approved
`agents.acp.backends.installFromRegistry` Action. Plugins retain their existing
update policy.
Store Updates binds that Action and its installed inventory to the Store's selected
Machine through the shared Store Machine owner. Browser extension observations
keep their Machine, profile and extension identity. Current browser extensions
remain visible with their installed version and do not contribute to the update
badge; source failures remain typed, per-item unchecked results.
The Store's passive column/phone count projects the same held Updates review
entries only after a complete check and complete inventory coverage. Before a
check or after an unchecked/failed result, the count is unknown. Its transient
scalar survives leaving the page and is withdrawn with the active Account
lifetime; badges issue no reads and schedule no refresh. Plugin observations retain
their reporting Machine, so a current sibling does not erase another Machine's update.

In unreleased 0.3 source, `updates/useInstalledUpdates.ts` is the shared installed-update
acquisition owner for Store Updates and the Machine Updates model. Both consume
`storeUpdatesModel.ts`, which projects registry-reported state without comparing versions
on the client. App checks supply the installed Environment's exact id and revision to
the existing app-check Action. Machine groups expose the same Store entry references in
`storeItems`, placed by the Environment runtime link, browser inventory, Plugin
materialization, or the native reach projection. Account Agent definitions have no
Machine membership; executable Agent CLI updates retain their existing owner. Machine
presentation of these Store entries remains a UI integration task.

Applied Machine recipes record a qualified recipe reference and definition revision,
with setup observations. They have no per-recipe registry provenance or upstream-update
observation in this composition. Recipe-provider Plugin updates use the existing Plugin
flow; definition revisions are not interpreted as locally available recipe updates.
The registry Action declarations admit original Account roots so this transport
can reach the daemon while retaining Account placement, strict inputs and the
existing approval policy. Expected upstream failures return per-item `unchecked`
reasons; a headerless rate limit has no reset time and requires manual Retry.

An Environment app check admits its selected Environments and their revisions
when the root is issued. Its finite HTTP continuation requires an active binding
and remains scoped to those Environments and their current Artifact references;
it does not repeat Source permission or revision admission. The Environment and
Artifact readers consume that verified scope, retaining Artifact mode, envelope
and version validation. The update protocol still owns revision comparison, so
editing one selected Environment does not invalidate reads for every other one.
New checks use current Source authority.

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

## Browser extensions in development source

The `browserExtension` Store kind reads Web Store IDs from `happier-catalog`
entries. Acquisition belongs to the daemon's browser extension owner: it verifies
CRX3 developer identity and Web Store publisher signatures before extracting
through the release-runtime archive owner. Unpacked directories use the same
manifest reader and machine-local package publication path.

Installed packages and enablement belong to one persistent browser profile on
one Machine. They are not Account settings or synced extension data. Mutations
require Machine Manage access; list, popup and options operations use the
existing browser access boundary. Changes take effect at the next browser
start, with confirmation before restarting an active profile. Popup and options
pages are native Chromium extension pages bound to the installed extension and
profile, presented through the existing browser view and capture/input owners.
Ordinary external URL admission remains HTTP(S)-only.

The existing `registryUpdateTracker.ts` composition checks both Web Store and
unpacked sources. It records only upstream observations against the installed
version, preserving newer package and enablement changes. Store review entries
include Machine, profile and extension identity. Applying an update carries its
selected version through `browser.extensions.update`; added manifest permissions
or website access require a new review before publication. The manifest owner
projects effective website access from both `host_permissions` and
`content_scripts[].matches`, deduplicated into `hostPermissions`, matching
[Chrome's declared-permission warnings](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions).
There is no
extension-specific update timer or coordinator.

The managed browser owns execution. The native-webview presentation contract is
the typed `managed_browser_required` state with an action to open the managed
browser. Store UI composition and rendered-state review remain part of the RU2
UI pass; these development contracts do not establish stable-release availability.

## Related

- [Published registry guide](../apps/docs/content/docs/extending/registries.mdx)
- [Plugin platform](plugin-platform.md)
- [Encryption](encryption.md)
- [Compatibility](compatibility.md)

## Chrome Web Store source (unreleased 0.3)

The built-in `Chrome Web Store` source is an informational browser-extension registry. Home, the Google collection and the Extensions category are projected from the store’s SSR listing callbacks into the existing marketplace discovery model. Search and detail use form-POST through `RegistryHttpV1.postForm` to the store's private batchexecute endpoints (`zTyKYc`, `xY2Ddd`) and parse defensively; update checks use the existing update2 XML endpoint. The web client uses the existing daemon carrier because the store does not allow browser CORS. Search forwards the store's opaque continuation cursor through the existing registry paging contract. These endpoints are unofficial and have no SLA. A non-200, rate limit, shape change or parse failure is surfaced as the existing typed unavailable source state, while paste-link/ID installation remains usable. The adapter never downloads or installs a package: acquisition continues through the browser-extension owner and CRX3 verification.

Listing detail retains the upstream Store publisher (organization or Offered-by name, falling back to a supplied manifest author), plus manifest display version, declared permissions and website patterns alongside the named source. These are informational listing facts: the content digest remains the pinned registry version. Install and update consent use the acquired manifest returned by the browser-extension owner, presented through the shared Store review with labelled version and permission rows. Known manifest permissions have plain-language labels; unknown identifiers and site patterns stay visible.

Store search, listing and detail reads carry the Store's Machine scope: an embedded or Machine-qualified destination, otherwise the existing Plugins administration Machine choice. App installation review passes its chosen installation Machine through that same read scope. The registry carrier consumes this target instead of choosing the first live Machine again; source recovery observes the same target.

Native catalog categories and collections retain their source-qualified browse destination on the existing Store directory group. Its “All” action opens the shared Store category/list page, which reads that catalog's declared kind and discovery categories. Chrome Web Store uses this path alongside the other catalogs; it has no separate browse page.
