# Machine content key lifecycle

Status: **APPROVED 2026-10-08 — implemented, awaiting integration gate (see §11 status)**  
Contract revision: **r9.4**
Date: **2026-10-06**  
Owner: Lane 12 / PD; approval record: none. Binding product inputs: D2, D15, D16, D41/D42; this draft does not authorize
implementation.

- **Supersedes:** [archived Machine plan](../../reviews/2026-10-02-lane12-replan/archive-r6/05-managed-machines.md) §“Full Machine key and requester Session
  lifecycle”, the resource-key contract. Its acquisition/provider work transfers to
  `50-managed-resources-and-enrollment.md` s1–s3, not here.
- **Extends:** current persistent-Machine registration/read/write lifecycle; `workspace-sync/PLAN.md` revision 2 is unchanged.
- **Consumes:** existing Account-mode and recipient-binding owners; `41-machine-sharing-and-project-terminals.md` s1 supplies recipient access/currentness for
  delivery, and s2 supplies the privacy prerequisite before delivery. These do not gate ordinary owner registration or conversion.
- **Provides:** **40s1** canonical create/adopt; **40s2** atomic content/key transition and stale-writer rejection; **40s3** current codecs/cache/RPC binding.
  `41` s1–s2 and `50` s2–s3 consume those exact slices, never implement another key factory.

Evidence notation: **Observed** means source inspected on 2026-10-05; **Target** means proposed behavior; dated
earlier observations below are not a refreshed release frontier. Current HEAD:
`dcdc500965b063a7537ad473d5829ac5a8dacf90`. Source is moving and dirty. Predecessor basis is in §10. No runtime crypto
reproduction, test, build or live QA has run for this draft.

Reading terms:

- Numbered plan references and slice ids follow the program index. D-number references identify binding product decisions.
- Final-lab frame ids name exact design variants in `lane12-final`; requirement and invariant ids remain stable.
- PD names the Lane 12 resource-key, sharing and requester-Session corridor (plans 40–42).
- EC is the Account settings entity-catalog plan at `../2026-10-06-account-settings-entity-catalogs/PLAN.md`; S-number references name its slices.
- E2EE means end-to-end encryption; DEK means data-encryption key.

## 1. Outcome and user value

An owner can register, reconnect and share a Machine without giving recipients an Account encryption key or losing
existing Machine content. Legacy 0.2 metadata remains readable. Plain Machines stay keyless. Sharing's lab references
are final `.happier/design-lab/lane12-final/` (D27) `m-share A/Ap/SS` and `m-pick A/Ap`; this plan produces their crypto facts, while `41` owns
the mounted panel and recipient controls.

- **MK-R1:** each new persistent E2EE Machine receives its own random 32-byte content DEK, sealed through the existing recipient-envelope format to the
  verified owner binding.
- **MK-R2:** every registration result adopts the published winning key before decoding returned metadata/state; a repeat or losing registration cannot replace
  another row's key independently of ciphertext.
- **MK-R3:** owner-authorized legacy conversion atomically commits matching metadata, daemon state and owner envelope, preserves display-name/user edits, and
  rejects stale-envelope writers even when they know the new content versions.
- **MK-R4:** UI, SDK, daemon and RPC read/write owners retire old ciphers/caches/in-flight results coherently before recipient delivery; Plain and
  malformed-present-envelope behavior remain explicit.
- **MK-I1:** no Account-derived key is sealed to a Machine recipient.
- **MK-I2:** persisted Account mode decides owner storage mode; key presence does not.
  **MK-I3:** only truly absent persistent owner envelopes reach the 0.2 reader; a foreign recipient or Runner cannot use that fallback.

The deciding evidence is decryption of actual winning ciphertext, rejection of a stale live writer at the server, and
preservation of predecessor-produced content through conversion/reconnect. Key length or a new helper alone cannot close
this plan.

## 2. User-facing flows and copy

**Owner registration:** desktop/phone existing Connect/Add Machine and CLI enrollment → existing registration → returned
canonical row → normal Machine detail. Agent-initiated connection uses incumbent pairing/SSH Actions and approvals; no
separate “generate key” action. Managed guest registration consumes this path from `50` s2; this plan does not authorize
guest credential exposure.

**First share of an old Machine:** `41` Share approves the exact audience/role. The key holder reads current content,
performs the owner transition if needed, and then prepares recipient envelopes only after `41` s2's shareable projection
is safe. An offline holder leaves the grant pending. The recipient can see a pending row and retain their composer;
pending does not permit RPC. Retry uses `machines.access.prepareKeys` owned by `41`, not an alias in this plan.

**Reconnection/change:** existing owner UI and CLI reload the exact row and install its canonical context. On a changed
envelope, discard old decoded caches; asynchronous results cannot reinstall a retired cipher. A malformed envelope shows
locked/unavailable with repair guidance. A dropped commit response observes post-state, never publishes the proposal
again or replays an admitted effect.

Proposed localized keys below belong in the existing UI translation catalog, with CLI/Action error codes mapped to the
same outcomes. English interpolation uses display names, never raw keys or bearer material.

| State / key | English string | Recovery and surfaces |
| --- | --- | --- |
| `machines.keys.loading` | Checking access to {machine}. | Stable Machine row/header on desktop and phone; structured pending read for CLI/agent. |
| `machines.keys.preparing` | Preparing secure access to {machine}. | Existing share row status; no decorative stage timer. |
| `machines.keys.pendingHolder` | Waiting for an authorized key holder to prepare access to {machine}. | `41`'s approved sharing client seals immediately when possible; later owner client/daemon delivery and explicit Retry/Cancel share the same owner. |
| `machines.keys.offline` | {machine} is offline. Your sharing changes are saved. | Retain row and draft; no execution until current access is ready. |
| `machines.keys.unavailable` | Secure access to {machine} is unavailable. | Retry; owner repair route when the current binding is inconsistent. |
| `machines.keys.refusedPlain` | {machine} is end-to-end encrypted and {person}'s account is not. | Share a Plain Machine or link to Account encryption settings; no automatic mode switch. |
| `machines.keys.changed` | Access changed while it was being prepared. Try again. | Refresh exact row/grant and reprepare only unapplied work. |
| `machines.keys.outcomeUnknown` | The access update could not be confirmed. Check its status before trying again. | Observe current row; no blind write retry. |
| `machines.keys.plain` | Not end-to-end encrypted | Explicit fact, no fabricated key controls. |
| `machines.keys.encrypted` | End-to-end encrypted | Quiet header fact, no success banner. |
| `machines.keys.emptyRecipients` | Share this machine so teammates can work here. | Existing Share affordance; no new key setup wizard. |
| `machines.keys.readFailed` | Could not check access to {machine}. | Retry current read; keep last-known information marked stale. |

There is no separate key screen. Metrics and state transitions consume `41` §8 and
`70-shared-ui-and-plugin-presentation.md` s1/s4: app page/row tokens win over the lab's illustrative 56/48/30
measurements. Rendering does not create, reseal or migrate anything.

## 3. Current owners and change map

Paths are exact current files; line numbers are observed anchors, not permanent identifiers. New target files are
expressly marked NEW later.

| Current path:line + symbol | Verdict | Exact change |
| --- | --- | --- |
| `apps/cli/src/api/client/encryptionKey.ts:56` `resolveMachineEncryptionContext` | REFACTOR | It currently uses Account `machineKey` (the Account content private key)/legacy secret. New E2EE creation uses random resource DEK; existing reads retain the canonical legacy adapter. |
| `apps/cli/src/api/api.ts:1025` `getOrCreateMachine`; `:859` published context use | CONSOLIDATE | Registration currently decodes with its proposal. Adopt returned row through `resolvePublishedMachineEncryptionContext` first; preserve winner on repeat/P2002 paths. |
| `apps/cli/src/api/machine/machineDataEncryptionKey.ts:75` `resolvePublishedMachineEncryptionContext`; `:134` `resolvePublishedMachineContentCodec` | EXTEND | One owner for owner/recipient/resource-mode selection, malformed-present refusal and scoped codecs. |
| `packages/protocol/src/machines/machineStoredContent.ts:236` `resolvePublishedMachineDataEncryptionKeyV1` | REUSE / EXTEND | Explicit plain/legacy/e2ee/unavailable parsing; retain independent Runner trust. Add sharing inputs only with `41`'s authenticated projection. |
| `apps/server/sources/app/api/routes/machines/machinesRoutes.ts:530` registration update | REFINE | Keep metadata create-only on repeated registration; prohibit independently replacing envelope/state encrypted under a losing proposal. Adoption precedes subsequent versioned owner refresh. |
| `apps/server/sources/app/machines/machineMutations.ts:26` `createMachineWithInstallationIdentityInTx` | REUSE | Existing transaction/installation creation wins once; no new Machine record or owner identity. |
| `apps/server/sources/app/machines/migrateMachineAccountEncryptionInTx.ts:141` `migrateMachineAccountEncryptionInTx`; `:69` post-state matching | EXTRACT | Share only the real conditional ciphertext/version primitive with the per-Machine transition; keep whole-Account inventory/mode checks intact. |
| `apps/server/sources/app/api/socket/machineUpdateHandler.ts:781/:908` metadata/state handlers | EXTEND | Validate encoded-against envelope identity in the same mutation condition as versions and current installation. |
| `apps/cli/src/api/apiMachine.ts:2031/:2078` metadata/state writes | REFACTOR | One current context owner supplies encryption, expected envelope and update retry; swap RPC/read/reconnect context together. |
| `apps/ui/sources/sync/encryption/encryption.ts:527` `initializeMachines`; `machineEncryption.ts:27` `MachineEncryption` | REFINE | Successful changed-key installation currently shares version-keyed cache. Clear at actual key change and retire in-flight results through the existing cache owner. Warm-cache failure is a reachable hypothesis to test, not a reproduced runtime defect. |
| `apps/ui/sources/sync/engine/machines/syncMachines.ts:186/:322` socket update/fetch-and-apply | EXTEND | Propagate authenticated resource mode/current envelope; prohibit stale async hydration and preserve subscription locality. |
| `packages/sdk/src/machines.ts:95` `resolveMachineProtectedActionMaterial` | EXTEND | Select exact admitted Machine material through the common resolver, including persistent shared target (`41` s2). No Account/plain fallback on failed Machine opening. |

The touched owner corridor includes UI display cache, socket hint, exact scoped RPC, daemon startup/reconnect and SDK
bootstrap callers. `40s3` must inventory their current imports by symbol at implementation time, then migrate all
reached callers; this is not permission to stop at the table's first factory.

## 4. Split-brains contracted here

1.  Proposed-key registration and published-key loading converge at `resolvePublishedMachineEncryptionContext`; delete proposal-based response decoding and
   repeat-registration reseal churn.
2.  Key-only registration update and separate opaque-content writes converge at one conditional whole-content transition; delete independent key replacement for
   existing rows.
3.  Captured constructor codecs and later retry writers converge at one Machine-client context/adoption boundary; no local writer may accept ciphertext solely
   because its version retry succeeded.
4.  UI successful-key replacement and unavailable-key retirement use the same key-bound cache retirement behavior; remove old-key cache reuse and stale result
   reinstalls, without broad Account cache resets.

Retain owner-only historical data reading, whole-Account mode migration and independent Runner authenticity checks:
these translate or enforce different contracts and are not alternative shared-key writers.

## 5. Contracts

Follow [index](../teams-lane-12-managed-environments-and-workspaces.md) §Daemon weight; `packages/protocol/src/json/storedReadSchema.ts#createStoredReadSchema` already owns lazy derivation and reuse.

**Reader/input classification:** Stored: published Machine content/key-basis records, plain/encrypted envelopes and warm Machine cache records. Strict input/event: MachineKeyBasisV1, MachineEncodedWriteBasisV1, transition input/result, encoded writes, authoritative updates and signed proofs. Follow [index](../teams-lane-12-managed-environments-and-workspaces.md) §Stored contracts at the existing codec; the owner-only legacy/mode rules below remain binding.

**Target input/event types**, implemented as strict Zod schemas in existing Protocol Machine domains; wire epoch V1 is
independent of npm version. Identity, mutation input/outcome, nested binding and authoritative event objects are
**closed**; unknown fields cannot select keys or gain authority. Reuse validated IDs/envelope codecs already used by
`machineStoredContent` and Machine installation schemas rather than introducing brands or another crypto format.

```ts
type MachineKeyBasisV1 = Readonly<{
  dataEncryptionKey: string | null; // exact published encoded owner envelope/marker
  metadataVersion: number;
  daemonStateVersion: number;
}>;
type MachineContentKeyTransitionInputV1 = Readonly<{
  machineId: string;
  expected: MachineKeyBasisV1;
  next: Readonly<{
    dataEncryptionKey: string;
    metadata: string;
    daemonState: string | null;
  }>;
}>;
type MachineContentKeyTransitionResultV1 =
  | Readonly<{ kind: 'committed'; machine: PublishedMachineRow }>
  | Readonly<{ kind: 'conflict'; current: MachineKeyBasisV1 }>
  | Readonly<{ kind: 'refused'; code: 'forbidden' | 'machine_unavailable'
      | 'machine_storage_mode_mismatch' | 'encryption_material_unavailable' }>;
type MachineEncodedWriteBasisV1 = Readonly<{
  expectedDataEncryptionKey: string | null;
  expectedVersion: number;
}>;
```

`PublishedMachineRow` above denotes the incumbent validated Machine row, not a new permissive bag. NEW schema file:
`packages/protocol/src/machines/machineContentKeyTransitionV1.ts`. NEW transaction owner:
`apps/server/sources/app/machines/transitionMachineContentKeyInTx.ts`. Proposed authenticated owner-only route: `POST
/v1/machines/:id/content-key/transition`, registered inside `machinesRoutes.ts`; the body id must match the path.
Response projection never includes plaintext DEKs. Private holder invocation uses existing installation/current Account
authorization; plugins cannot supply expected authority.

No new Prisma key epoch/provenance/ciphertext-history table. Existing Machine key/content/version columns remain
canonical. A legacy holder resolves actual owner credentials through `auth/terminalProvisioningMaterial.ts` and existing
derivation/binding validation; the server cannot infer key provenance from envelope bytes. The owner compares the opened
key against supported historical Account material and performs conversion before recipient sealing; unavailable
provenance/material stays pending/repair, never “probably resource-scoped.”

All versioned encrypted Machine writers, including UI metadata edits, carry the envelope identity used to encode. Server
checks it before writing ciphertext, including on version-mismatch retries. Plain writes carry the canonical Plain
identity and need no encryption material. Existing Machine update/Account-change events project the committed envelope
plus content revisions and invalidate callers after commit via `afterTx`; no independent `machine.key.changed` stream.
Normal resource context changes reuse existing update events and strict parsing.

### Current policy and owner decisions

Consume [index](../teams-lane-12-managed-environments-and-workspaces.md) §Outcome and binding decisions (D18/D19/D20/D24) and 41’s single access/disclosure owner. 40 owns only resource-key creation/conversion/current codecs; no disclosure acknowledgement or approval store. D2 resource-key and D3 requester-credential obligations remain separate.

## 6. Actions (D16)

This lifecycle is host-owned; there is no user-addressable random-key or raw transition Action.
Key preparation/retry consumes `machines.access.prepareKeys` from [41 §6](41-machine-sharing-and-project-terminals.md#6-actions-d16).
It calls this plan's transition/seal owners under current access and the configured Action policy; D24 disclosure is presentation, not another acknowledgement.

Existing `machines.list`, enrollment/pairing/SSH and Machine rename/update retain canonical Actions. Refresh repeats the
admitted read; repair/settings navigation uses the existing concrete navigation operation when an answering client
exists. Focus, expand, Back and clipboard are local presentation, not transported arbitrary callbacks or a new command
bus; headless reads return safe status/data. 71 owns discovery/placement/approval, not a second key Action or RPC
bypass.

## 7. Plugin extensibility

Safe current Machine projections and ordinary Action DTOs project through existing generated Protocol/SDK consumers and
host `executeAction`. Providers from `50` call ordinary registration. No new `machineKeys` contribution family, DEK
export, raw bearer API, key mint callback, lifecycle control or host-internal import. Public UI status composition
consumes `@happier-dev/plugin-ui` `ItemGroup`, `Item`, `SurfaceStateCard` and `SurfaceFreshnessLine`; missing neutral
anatomy belongs `70`, not this crypto owner.

## 8. UI composition and motion

Mounted tree: existing Machine detail → existing Sharing `ItemGroup` → incumbent
`components/sharing/ShareSheet.tsx#ShareSheet` with `41`'s NEW `machineShareAdapter.tsx` → recipient/status/quiet retry
or cancel. Picker rows consume the same ready/pending/refused facts through the existing destination model. `40` adds no
card/overlay/stepper.

`packages/plugin-ui/src/presentation/layout/pageMetrics.ts` owns the 52px regular/40px compact rows and 28px section
rhythm; use the owning app aliases. `components/ui/motion/motionTokens.ts` supplies disclosure/popup state transitions;
changing crypto state updates the existing status line without shifting rows. Reduced motion is immediate. Do not copy
the lab's timed simulated delivery as a completion producer.

## 9. Lifecycle, cancellation and recovery

Create proposes once → server winner returned → canonical adoption → decoding/writer readiness. Repeat registration
reloads winner rather than resealing. Existing owner metadata refresh follows a versioned write under the adopted
context.

Conversion reads current row → decrypts/preserves edits → conditional transaction → observes
commit if acknowledgement is lost → installs current context/cache/binding. First characterize captured request/reply codecs at
`apps/ui/sources/sync/api/session/apiSocket.ts#machineRPC` and `apps/cli/src/api/rpc/RpcHandlerManager.ts#handleRequest`:
the UI supplies the selected cipher to `callSocketRpc`, and the manager captures its transport at construction. These observations
do not prove safe live conversion. 40s3's held-reply test determines which calls can settle with their captured codec and which
need an owner-local hold or retirement during the swap. Hold only the unsafe codec-bound path; no universal RPC, Session or
process drain. Version/envelope fencing unconditionally rejects old ciphertext, and retired async work cannot publish stale state.
Version/envelope conflict leaves
the whole old row unchanged and reprepare starts from a fresh row. Crash before commit leaves old readability; crash
after commit leaves new readability. Never auto-replay an ambiguous remote effect while reconnecting.

Cancel before commit removes only local preparation. Once commit may have occurred, observe; cancellation cannot undo a
transmitted transaction. `41` grant cancellation prevents future recipient delivery through current grant checks; it
does not revert an already valid owner conversion. A held old writer must be rejected even after reading newer content
versions. No key-switch record or timer declares settlement.

Mode/recipient-key changes compose with `41` current admission and the existing whole-Account mode migration. Warn
through its existing preflight about affected shared readiness; recheck actual grant/current binding before delivery. Do
not reinterpret failed E2EE as Plain. Revocation alone does not require rotating every remaining recipient's key or
erasing already disclosed bytes.

## 10. Compatibility

Observed prospective `../0.2` HEAD: `51f8ac630607ce4041cc6a774de824c330f421f3`; scoped status was empty for CLI key/API,
Server schema/Machine route and UI encryption files. The actual key factory still seals Account `machineKey` and uses
legacy secret when appropriate. This is current predecessor evidence, not a released artifact claim.

Required direction: 0.2-created persistent owner Machine data → current reader → converted current writer → current
reader after restart. Preserve absent-envelope legacy-secret data, Account-derived owner envelopes, plain markers and
user edits. Use actual predecessor-produced vectors under both credential forms in `40s2`, recording
serializer/path/HEAD. A present malformed envelope refuses; a foreign recipient never obtains the legacy fallback.
Runner trust remains separate.

The explicit one-way all-component 0.3 transition refactors unreleased wire shapes in place; no old-0.3 writer, dual
ciphertext, rollback epoch or writer-floor machinery. `docs/compatibility.md` and `docs/encryption.md` remain canonical;
implementation updates their Machine lifecycle sections in the same coherent change. `40s1` refreshes immutable
supported stable/preview producer/artifact provenance where it establishes real historical data obligations; the draft
does not certify a deployment frontier. Recheck the current sibling paths before implementation handoff if
advanced/dirty.

## 11. Slices in order

**Stored-reader checks:** 40s1’s stored-envelope regression below owns projection/writeback proof; 40s2/s3 consume it and keep their distinct transaction/cache tests. Shared doctrine and helper tests live in [index](../teams-lane-12-managed-environments-and-workspaces.md) §Stored contracts.

**Existing rejecting stored envelope reader — owned by 40s1 (D15/D16):**
`packages/protocol/src/machines/machineStoredContent.ts:15–18,42` reads encoded stored Plain content with strict
`MachinePlainStoredContentEnvelopeSchema`. Make this stored parse tolerant/drop-only at the incumbent codec; the
`{t:'plain',v}` discriminator/content and Account/resource mode checks remain explicit, with no Plain fallback for
malformed/encrypted content. Keep encoded mutation requests and signed/cryptographic proof inputs strict. RED seeds an
extra envelope field and proves readable known content plus canonical encoding; malformed required content/mode still
fails.

All paths below denote source edits for a future approved execution, not work performed while writing this draft.
Strengthen existing tests before inventing a suite; internal crypto/normalization/transaction logic stays real.

### 40s1 — Canonical new-key creation and adoption

**Key, policy and conversion owner:** refine existing Machine registration/create/adopt and Machine content/envelope
writers, not a new key/policy store. Generate a random per-Machine DEK once; race losers adopt the committed winner.
Establish stable published envelope/context identity at the existing crypto/commit owner before comparing encoded
owner-envelope bytes; fresh randomized resealing of the same DEK is not an identity. Preserve atomic metadata +
daemon-state + key-basis CAS; stale and lost-ack writers re-read the winner. Custodian persisted Account mode governs
foreign rows, not viewer mode. Reuse recipient public-binding/sealing verification, characterize swapped
Machine/recipient/owner-envelope vectors at that boundary, and allow a current Manage key holder to prepare eligible
recipient tuples without making owner presence a universal prerequisite. Plain is keyless; E2EE→Plain recipient sharing
refuses. Retire cached codecs/RPC contexts on committed basis change.

30s1–s2's finite accepting/runAtMost policy belongs to the Machine content owner so an admitted manager can operate it;
no custodian-private Account KV writer or plaintext server semantic merge. Clients validate/open/merge, while the server
validates strict grammar, explicit envelope/mode, existing fence and CAS without decryption. Keep 30/32's actual
Account-scoped placement configuration at its own owner. Register finite Machine policy in the existing Account-mode
Machine conversion inventory/reseal/commit path (`account/encryptionMigrate.ts#AccountEncryptionMigrateMachinesDirectiveSchema`) before its first write; EC owns
its distinct reserved-row registration. New Machine
schemas follow the index's Daemon weight rule; call `createStoredReadSchema` directly, which already uses
`lazyDefinition` and schema-keyed reuse. Add no outer lazy wrapper or cache.

Consumes Account-mode/binding and published-key resolver; provides MK-R1/R2/I1–I3 to owner enrollment and `50` s2. Touch
`encryptionKey.ts`, `api.ts`, `machineDataEncryptionKey.ts`, Protocol `machineStoredContent.ts`, `machinesRoutes.ts`,
and existing registration tests. Extend normal returned-row adoption and preserve repeat-registration winner; do not
expose recipient sealing yet.

**RED:** `apps/cli/src/api/client/encryptionKey.test.ts` adds actual Machine cases (current suite primarily covers
Sessions): two creations open to distinct DEKs, neither equals Account material; Plain allocates none.
`api.getMachine.runtimeCatalog.integration.test.ts` returns a different winning row and must decrypt its metadata/state
instead of proposal ciphertext. Server `machinesRoutes.updateExisting.integration.spec.ts` repeats registration with a
different proposal and must retain matching canonical envelope/content. Mock only randomness/network, use real seal/open
and route/DB harness.

**GREEN and completion:** all owner new/load/repeat/P2002/startup consumers adopt the winner; no independent existing-row key
replacement remains. Adjacent `api.plaintextMachine.runtimeCatalog.integration.test.ts` and
`machinesRoutes.updateExisting.txBusy.integration.spec.ts` pass. Package checks follow the index integration rule. Can run in parallel with A/B/C/E/F work that does not disclose Machine keys.

### 40s2 — Existing content converts as one committed state

**Deciding RED additions:** real registration/transition integration proves simultaneous create/adopt selects one
winner using 40s1's existing creation suite; rerandomized seal cannot impersonate the committed basis; swapped recipient/Machine binding refuses;
consume 41s1's current-Manage/offline-holder delivery proof. Stale encoded writes cannot mix old/new content. Extend
incumbent populated Plain→E2EE and E2EE→Plain Account-mode Machine conversion suites with finite Machine policy, semantic
preservation, incomplete coverage and stale revision refusal. Server never opens policy E2EE. Shared-enable proof uses the D24 API guarantee and 41 pre-grant
disclosure; same-user OS secrecy is not promised.

Consumes 40s1; provides MK-R3 to 40s3/41. Touch NEW `machineContentKeyTransitionV1.ts` and
`transitionMachineContentKeyInTx.ts`, current registration/Account migration/socket writers, CLI `ApiMachineClient`, UI
Machine metadata writer reached by symbol census, and canonical docs.

**RED:** extend `apps/server/sources/app/machines/migrateMachineAccountEncryptionInTx.sqlite.integration.spec.ts` with
the shared conditional primitive; NEW sibling `transitionMachineContentKeyInTx.sqlite.integration.spec.ts` tests actual
transaction: conflicting expected envelope/content version leaves old row untouched; dropped acknowledgement can be
identified from committed post-state. `machineUpdateHandler.currentness.sqlite.integration.spec.ts` holds an old-key
writer through conversion, refreshes its expected content version and still rejects its ciphertext. Real SQLite
harness/crypto; only socket/network interruption is a boundary fixture.

**GREEN and completion:** legacy vectors decrypt before/after restart, both ciphertexts/envelope move atomically and user edits
survive; no server plaintext crypto, key-only route, independent retry writer or unverified post-state success. Adjacent
`apiMachine.updates.test.ts`, `apiMachine.quiescence.runtimeCatalog.integration.test.ts`, Account migration checks. Package checks follow the index integration rule. Cannot enable delivery until 40s3 and 41s2 also complete.

### 40s3 — Live readers, caches and RPC adopt current context

Consumes 40s2; provides MK-R4 and complete key lifecycle to 41s1–s2. Touch UI encryption/cache/Machine sync/socket
hints/scoped RPC owners, CLI read/write/reconnect/RPC bindings, SDK Machine material resolver and generated contract
projections. Coordinate actual shared hunks with 41s2; no parallel conflicting edits.

**RED:** `apps/ui/sources/sync/encryption/encryption.initializeMachines.keyUpdate.test.ts` warms old plaintext at a
version, installs a new key and same-version different ciphertext, and must return new plaintext; resolve a delayed old
installation after revoke/change and prove it cannot reinstall. `syncMachines.staleUpdates.test.ts` must preserve
current cipher/state. CLI `apiMachine.reconnectRace.test.ts` / `apiMachine.rpcScope.test.ts` must open a real
post-transition response with current binding. Mock network/platform boundary only; no mock of the key/cache owner.

At the real `RpcHandlerManager` / `callSocketRpc` transport boundary, hold an old-codec request's reply across conversion:
it settles under its captured codec or receives a truthful retired/unknown outcome without replay, new requests use the current
codec, and the old-key writer refreshed to a new content version still refuses through 40s2's server test. This one
characterization decides the smallest necessary local hold in §9; a constructor snapshot alone is not GREEN proof.

**GREEN and completion:** exact RPC, SDK, hints, hydration and every reached writer use committed current context; caches retire
only affected Machine, captured retired async results cannot publish. Adjacent Machine sync/data-key/plain tests pass;
Package/generated-export checks follow the index integration rule. Complete owner live segment of §12
before this plan's implementation verdict. Cache tests can be prepared alongside 40s2, but the consumed swap/writer
vertical closes sequentially.

Validation/commands follow [index](../teams-lane-12-managed-environments-and-workspaces.md) §Integrated implementation evidence, once at the coherent 40–42 boundary. Focused owner and adjacent suites remain slice-local; this draft ran none.

### Execution state

Execution evidence observed 2026-10-10 from [TRACKING](../../reviews/2026-10-02-lane12-replan/impl-C/TRACKING.md), the linked lane reports and review/fix deltas. Focused GREEN denotes the terminal source checks recorded there, not a new ST run or an integrated completion verdict. Open/partial rows retain deciding evidence gaps; historical failures are not erased by later narrow passes.

**Common Main integration gate (D50):** current touched-package typechecks/builds and relevant broader tests; canonical generated bundled manifests/projections plus SDK DTO regeneration/parity; retained-database migration deploy, including `20261009160000_add_machine_preset_environment`, with applicable provider/schema/FK checks; and the [composed loaded-runtime journey](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence), current runtime identities, cold-daemon evidence and light/dark/phone accessibility/performance comparison. [QAC](../../reviews/2026-10-02-lane12-replan/impl-C/QAC.md) and [QAC2](../../reviews/2026-10-02-lane12-replan/impl-C/QAC2.md) are partial live evidence; [FX16](../../reviews/2026-10-02-lane12-replan/impl-C/FX16.md) supplies source fixes for QAC2 blockers. [QAC3](../../reviews/2026-10-02-lane12-replan/impl-C/QAC3.md) is **in progress** and closes no pending gate.

Release evidence below names the applicable checks in the index's sole [Release checks](../teams-lane-12-managed-environments-and-workspaces.md#release-checks) list; real vendor tenants/billing, native executables/platforms, physical devices and signing remain release-owner evidence.

| Unit | State | Commits | Deciding focused evidence | Main integration remaining | Named release evidence |
| --- | --- | --- | --- | --- | --- |
| 40s1 | IMPLEMENTED (focused GREEN) | `71e10f8f39`, `92c476ae05`, `0cb95bb680`, `a205a50745` | [C40](../../reviews/2026-10-02-lane12-replan/impl-C/C40.md) records distinct resource keys, winning-row adoption and tolerant stored Plain reads; [CC2](../../reviews/2026-10-02-lane12-replan/impl-C/CC2.md) maps the committed owner paths. | Common gate; repeat registration/Plain/malformed-envelope segment on the loaded runtime. | Native enrollment on Linux/macOS/Windows; physical clients and signing. |
| 40s2 | IMPLEMENTED — open items | `92c476ae05`, `0cb95bb680`, `c72ecf82f0` | [C40](../../reviews/2026-10-02-lane12-replan/impl-C/C40.md) records opaque atomic transition/stale-envelope fencing source and predecessor read GREEN; [FX9](../../reviews/2026-10-02-lane12-replan/impl-C/FX9.md) repairs legacy first-share conversion from [RV-B](../../reviews/2026-10-02-lane12-replan/impl-C/RV-B.md). | Common gate; complete the deferred real SQLite transition/stale-writer and conversion/restart checks; preserve user edits through lost ACK recovery. | Native reconnect/conversion across supported platforms; physical clients and signing. |
| 40s3 | IMPLEMENTED (focused GREEN) | `a205a50745`, `ee62fef68b`, `c72ecf82f0`, `1122a710fb` | [C40](../../reviews/2026-10-02-lane12-replan/impl-C/C40.md) records captured RPC/cache/currentness GREEN; [FX15](../../reviews/2026-10-02-lane12-replan/impl-C/FX15.md) final GREEN covers real Machine-sync new-row, stale/key-withdrawal and hydration neighbors. | Common gate; reconcile C40's deferred final RPC/metadata cases and exercise held replies/current-key adoption live. | Native process/reconnect behavior; physical clients and signing. |

## 12. Live QA segment and completion

Key segment of [index](../teams-lane-12-managed-environments-and-workspaces.md) §Integrated implementation evidence: use predecessor-derived encrypted metadata/state and an active owner writer. Register twice, reconnect, initiate sharing, interrupt conversion acknowledgement, inspect current post-state,
then resume owner reads/writes and recipient preparation. Verify display-name preservation and no decrypted-cache
regression. Repeat Plain registration with no client key material and malformed-present refusal.

41/42 supply their own privacy/requester segments to that same index journey.

Completion follows the index integration rule with MK-R1–R4/I1–I3. A random-key helper without winning-row adoption, stale-writer rejection or live cache/codec proof cannot close this corridor.

## 13. Economy notes

Do not add crypto protocols, per-operation keypairs, key epochs, leases, retired-key tables, dual writers, mandatory
revoke rekeys, a migration scheduler, pending recipient ledger or release certification artifact. Existing envelope
identity plus content versions decides stale writes; existing readiness/seal/conditional commit decides delivery. The
supported legacy reader is data compatibility at the canonical seam and cannot mint a new shared key.

## 14. Open items

Resolve any remaining final-design questions and gaps recorded in `lanes/repoint.md` at their owning slices.

Residual risk: legacy
provenance, live writers and in-flight cache behavior require the named real boundary tests; source inspection alone
does not certify crypto safety.

History: see archive-r8.4 and the review folder
