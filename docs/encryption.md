# Encryption and Data Encoding

This document details how client data is encrypted, how encrypted blobs are structured, and how those blobs map onto protocol fields. It is based on `apps/cli/src/api/encryption.ts` and the server routes that accept/emit these values.

For transport and event shapes, see `protocol.md`. For HTTP endpoints, see `api.md`.

The encryption layouts below describe E2EE content. Plaintext Session storage is
described separately under **Session storage modes**; the unreleased development
Machine format is described under **Plain Machines (development)**.

## Overview

```mermaid
graph TB
    subgraph "Client (CLI/Mobile)"
        Plain[Plaintext Data]
        ClientEnc[Client Encryption]
        B64[Base64 Encoded]
    end

    subgraph "Transport"
        Wire[HTTP / WebSocket]
    end

    subgraph "Server"
        Store[(Postgres)]
        ServerEnc[Server Encryption]
        Tokens[Service Tokens]
    end

    Plain --> ClientEnc --> B64 --> Wire --> Store
    Tokens --> ServerEnc --> Store

    style Plain fill:#e8f5e9
    style B64 fill:#fff3e0
    style Store fill:#e3f2fd
```

## Design goals
- Keep the server blind to user content (end-to-end encryption on clients).
- Use explicit, stable binary layouts so clients can interoperate across versions.
- Prefer simple, consistent base64 encoding on the wire.

## Encryption variants

```mermaid
graph LR
    subgraph "Variant Selection"
        Check{Has dataKey?}
        Check --> |No| Legacy[Legacy NaCl]
        Check --> |Yes| DataKey[DataKey AES-GCM]
    end

    subgraph "Legacy"
        L1[XSalsa20-Poly1305]
        L2[32-byte shared secret]
    end

    subgraph "DataKey"
        D1[AES-256-GCM]
        D2[Per-session/machine key]
    end

    Legacy --> L1 & L2
    DataKey --> D1 & D2
```

Clients currently use one of two encryption variants:

### 1) legacy (NaCl secretbox)
Used when the client only has a shared secret key.

**Algorithm**: `tweetnacl.secretbox` (XSalsa20-Poly1305)
- **Nonce length**: 24 bytes
- **Key length**: 32 bytes

**Binary layout** (plaintext JSON -> bytes):
```
[ nonce (24) | ciphertext+auth (secretbox output) ]
```

```mermaid
packet-beta
  0-23: "nonce (24 bytes)"
  24-55: "ciphertext + auth tag"
```

### 2) dataKey (AES-256-GCM)
Used when the client supports per-session/per-machine data keys.

**Algorithm**: AES-256-GCM
- **Nonce length**: 12 bytes
- **Auth tag**: 16 bytes
- **Key length**: 32 bytes

**Binary layout**:
```
[ version (1) | nonce (12) | ciphertext (...) | authTag (16) ]
```

```mermaid
packet-beta
  0-0: "ver"
  1-12: "nonce (12 bytes)"
  13-44: "ciphertext (...)"
  45-60: "authTag (16 bytes)"
```

- `version` is currently `0`.

## Data encryption key (dataKey variant)

```mermaid
flowchart LR
    subgraph "Key Wrapping"
        DEK[Data Encryption Key]
        Eph[Ephemeral Keypair]
        Box[tweetnacl.box]
        Bundle[Key Bundle]
    end

    DEK --> Box
    Eph --> Box
    Box --> Bundle

    subgraph "Content Encryption"
        Plain[Plaintext]
        AES[AES-256-GCM]
        Cipher[Ciphertext]
    end

    DEK --> AES
    Plain --> AES --> Cipher
```

When `dataKey` is used, the actual content key is encrypted for storage/transport.

**Algorithm**: `tweetnacl.box` with an ephemeral keypair.
- **Ephemeral public key**: 32 bytes
- **Nonce**: 24 bytes

**Binary layout**:
```
[ ephPublicKey (32) | nonce (24) | ciphertext (...) ]
```

```mermaid
packet-beta
  0-31: "ephPublicKey (32 bytes)"
  32-55: "nonce (24 bytes)"
  56-87: "ciphertext (...)"
```

This blob is then wrapped with a version byte before being sent/stored:
```
[ version (1 = 0) | boxBundle (...) ]
```

The resulting bytes are base64-encoded and placed in fields such as `dataEncryptionKey` for sessions/machines/artifacts.

## Where encryption is applied

```mermaid
graph TB
    subgraph "Client-Encrypted Fields"
        direction TB
        S1[Session metadata]
        S2[Session agent state]
        S3[Session messages]
        M1[Machine metadata]
        M2[Daemon state]
        A1[Artifact header]
        A2[Artifact body]
        K1[KV store values]
        AK[Access keys]
    end

    subgraph "Server Storage"
        DB[(Postgres)]
    end

    S1 & S2 & S3 --> |opaque strings| DB
    M1 & M2 --> |opaque strings| DB
    A1 & A2 --> |opaque bytes| DB
    K1 --> |opaque bytes| DB
    AK --> |opaque string| DB

    style S1 fill:#e1f5fe
    style S2 fill:#e1f5fe
    style S3 fill:#e1f5fe
    style M1 fill:#e1f5fe
    style M2 fill:#e1f5fe
    style A1 fill:#e1f5fe
    style A2 fill:#e1f5fe
    style K1 fill:#e1f5fe
    style AK fill:#e1f5fe
```

The server treats these fields as opaque strings/blobs. The client encrypts them before sending.

### Session metadata + agent state
- **Encrypted by client** and stored as strings in the DB.
- Used in:
  - `POST /v1/sessions` (create/load)
  - WebSocket `update-metadata` / `update-state`
  - `update-session` events

### Session messages

```mermaid
sequenceDiagram
    participant Client
    participant Server
    participant DB as Postgres

    Client->>Client: Encrypt message
    Client->>Server: emit "message" { sid, message: "<base64>" }
    Server->>DB: Store { t: "encrypted", c: "<base64>" }

    Note over Server: Later, sync to other clients

    Server->>Client: update "new-message"<br/>content: { t: "encrypted", c: "<base64>" }
    Client->>Client: Decrypt message
```

- Client emits `message` with a base64 encrypted blob.
- Server stores it as `SessionMessage.content`:
  - `{ t: "encrypted", c: "<base64>" }`
- Server emits it back in `new-message` updates with the same structure.

### Machine metadata + daemon state
- **Encrypted by client** and stored as strings in the DB.
- Used in:
  - `POST /v1/machines`
  - WebSocket `machine-update-metadata` / `machine-update-state`
  - `update-machine` events

In released 0.2, plaintext Account or Session storage does not disable encryption of Machine
metadata, daemon state, or Machine RPC. Signing in independently through an identity
provider can authorize devices for the same Account without giving them matching
content keys. Machine control still requires key material that can open the target
Machine's published data-encryption key. Genuine legacy records without a published
key retain their credential-key path; a malformed or unopenable published key never
falls back to a different local key.

Development clients report target-key and response-decryption failures explicitly,
rather than treating them as a missing Machine capability. Authentication success or
plaintext Session access does not establish that encrypted Machine control is usable.
The development-only plain Machine contract below is not a claim of availability
in those released clients or servers.

Development source records `rpc_params_decryption_failed` in the target's normal
file log when RPC parameters cannot be decrypted, with the unprefixed method and
encryption variant; it excludes payloads, ciphertext, keys, and Machine/Session
identifiers. This is a diagnostic for rejected input, which can also be malformed,
rather than proof of a key mismatch or a migration of existing device keys.

#### Plain Machines (development)

Current 0.2 development source adds genuine plain Machine metadata, daemon state,
and RPC. Clients require the explicit `encryption.plaintextMachine` server feature
bit; absent or false means unsupported. The server derives this bit from plaintext
storage support, subject to the canonical build feature policy and its
`encryption.plaintextStorage` dependency. Plain registration requires a plain
Account. E2EE Machines retain their encrypted format and key requirements.

The existing `dataEncryptionKey` carrier stores base64-encoded UTF-8 JSON
`{ "t": "plain", "v": null }` as an explicit plain marker. An absent key retains
its released meaning: legacy encryption using genuine Account credential material.
Plain `metadata` and non-null `daemonState` are base64-encoded typed envelopes
`{ "t": "plain", "v": <complete JSON document> }`. Base64 is encoding, not
encryption. Plain Machine RPC parameters and responses are readable by the relay;
deployments using it trust the server with Machine control content as well as
plaintext stored content. It introduces no server-derived shared content key.

Historical encrypted Machines remain encrypted after a released client's Account
opt-out. A capable client with the genuine old key can decode both complete
documents, preserve unknown fields, and convert the whole content triple through
`POST /v1/machines/:id/content-key/transition`. The server compares the expected
published key and both document versions before atomically replacing the key,
metadata, and daemon state and clearing the content-key fingerprint. A stale basis
returns a conflict; the caller refreshes before retrying. Ordinary registration
never substitutes a newly supplied key for incumbent content: a key mismatch keeps
the incumbent key, metadata, and daemon state together. Metadata/state updates must
match the persisted row's mode, including encrypted history in a plain Account.

The Account mode migration accepts a complete Machine census and converts all
owned records in the same transaction as the Account mode, in either direction.
Missing records or stale key/version preconditions abort that transition. Omission
of the Machine directive preserves released-client opt-out behavior; enabling
E2EE while an explicitly plain Machine remains returns `machines_require_upgrade`.
After explicit conversion, an older running daemon must restart and refetch the
new Machine context; ordinary encrypted Machines do not require a global restart.

Token-only authentication carries authorization without invented encryption keys.
Refreshing the same Account preserves any genuine locally held legacy or data-key
material. A client without the old material cannot convert or control an encrypted
historical Machine: it reports an operation failure rather than replacing stored
documents with defaults. Restore the genuine key material to convert that history.

The development CLI's private request-settlement journal remains encrypted even
for token-only plain Accounts. It derives a scoped local key from the existing
private installation identity; this does not fabricate Account encryption material
or change Machine/Session storage mode. Existing account-key journal envelopes keep
their original reader. Recovery requires the original installation identity and
does not replace missing key material. The exact local envelope and derivation are
documented in [CLI architecture](./cli-architecture.md).

### Artifacts
- `header` and `body` are encrypted bytes encoded as base64 on the wire.
- Stored as `Bytes` in the DB.
- Emitted in `new-artifact` / `update-artifact` events as base64 strings.

### Access keys
- `AccessKey.data` is treated as an **opaque encrypted string**.
- The server does not decode it or inspect its contents.

### Key-value store
- `UserKVStore.value` is encrypted bytes encoded as base64 on the wire.
- `kvMutate` expects base64 strings; `kvGet/list/bulk` return base64 strings.

Session drafts reserve a typed `UserKVStore` key prefix instead of exposing their rows through the
generic KV API. The draft routes carry an explicit content envelope and enforce its owner:

- a new-Session draft follows the Account encryption mode and uses Account-scoped key material;
- an existing-Session draft follows that Session's fixed encryption mode and, in E2EE mode, uses
  the Session data-encryption key;
- raw attachment bytes, local file handles and URIs, credentials, secret values, and local
  presentation state are not part of synchronized draft content.

This keeps one draft document and synchronization contract without weakening the different key
ownership of Account-scoped and Session-scoped data.

Snapshot hydration distinguishes a temporarily unavailable existing-Session key/context from an
invalid envelope or payload. It may skip only the unavailable Session record while continuing to
materialize other Account drafts; malformed or mode-incompatible content fails the snapshot so it
cannot be silently classified as a local key-loading condition.

## On-wire formats (encrypted fields)

```mermaid
graph LR
    subgraph "Wire Format"
        JSON[JSON payload]
        B64["base64 strings<br/>(encrypted bytes)"]
        Plain["plain values<br/>(ids, versions, timestamps)"]
    end

    JSON --> B64
    JSON --> Plain
```

Below are the typical JSON shapes that carry encrypted data. All `...` values are base64 strings representing encrypted bytes.

### Session creation
```http
POST /v1/sessions
```
```json
{
  "tag": "<string>",
  "metadata": "<base64 encrypted>",
  "agentState": "<base64 encrypted or null>",
  "dataEncryptionKey": "<base64 data key bundle or null>"
}
```

### Encrypted message (client -> server)
```
Socket emit: "message"
```
```json
{
  "sid": "<session id>",
  "message": "<base64 encrypted>"
}
```

### Encrypted message (server -> client)
```
update.body.t = "new-message"
```
```json
{
  "t": "encrypted",
  "c": "<base64 encrypted>"
}
```

### Session metadata update (WebSocket)
```
Socket emit: "update-metadata"
```
```json
{
  "sid": "<session id>",
  "metadata": "<base64 encrypted>",
  "expectedVersion": 3
}
```

### Machine update (WebSocket)
```
Socket emit: "machine-update-state"
```
```json
{
  "machineId": "<machine id>",
  "daemonState": "<base64 encrypted>",
  "expectedVersion": 2
}
```

### Artifact create/update (HTTP)
```http
POST /v1/artifacts
```
```json
{
  "id": "<uuid>",
  "header": "<base64 encrypted>",
  "body": "<base64 encrypted>",
  "dataEncryptionKey": "<base64 data key bundle>"
}
```

### KV mutate (HTTP)
```http
POST /v1/kv
```
```json
{
  "mutations": [
    { "key": "prefs.theme", "value": "<base64 encrypted>", "version": 2 },
    { "key": "prefs.legacy", "value": null, "version": 5 }
  ]
}
```

## Client-side types (shapes used before encryption)
These are the client-side structures that get encrypted and sent over the wire. They are defined in `apps/cli/src/api/types.ts`.

### Session message content (encrypted)
The payload stored in `SessionMessage.content` is always encrypted and wrapped as:
```json
{ "t": "encrypted", "c": "<base64 encrypted>" }
```

### Encrypted message payload (plaintext before encryption)
Messages are encrypted as `MessageContent` and then base64 encoded:

**User message**
```json
{
  "role": "user",
  "content": { "type": "text", "text": "..." },
  "localKey": "...",
  "meta": { }
}
```

**Agent message**
```json
{
  "role": "agent",
  "content": { "type": "output | codex | acp | event", "data": "..." },
  "meta": { }
}
```

### Metadata (encrypted)
```json
{
  "path": "...",
  "host": "...",
  "homeDir": "...",
  "happyHomeDir": "...",
  "happyLibDir": "...",
  "happyToolsDir": "...",
  "version": "...",
  "name": "...",
  "os": "...",
  "summary": { "text": "...", "updatedAt": 123 },
  "machineId": "...",
  "claudeSessionId": "...",
  "tools": ["..."],
  "slashCommands": ["..."],
  "startedFromDaemon": true,
  "hostPid": 12345,
  "startedBy": "daemon | terminal",
  "lifecycleState": "running | archiveRequested | archived",
  "lifecycleStateSince": 123,
  "archivedBy": "...",
  "archiveReason": "...",
  "flavor": "..."
}
```

### Agent state (encrypted)
```json
{
  "controlledByUser": true,
  "requests": {
    "<id>": { "tool": "...", "arguments": {}, "createdAt": 123 }
  },
  "completedRequests": {
    "<id>": {
      "tool": "...",
      "arguments": {},
      "createdAt": 123,
      "completedAt": 123,
      "status": "canceled | denied | approved",
      "reason": "...",
      "mode": "default | acceptEdits | bypassPermissions | plan | read-only | safe-yolo | yolo",
      "decision": "approved | approved_for_session | denied | abort",
      "allowTools": ["..."]
    }
  }
}
```

### Machine metadata (encrypted)
```json
{
  "host": "...",
  "platform": "...",
  "happyCliVersion": "...",
  "homeDir": "...",
  "happyHomeDir": "...",
  "happyLibDir": "..."
}
```

### Daemon state (encrypted)
```json
{
  "status": "running | shutting-down",
  "pid": 123,
  "httpPort": 123,
  "startedAt": 123,
  "shutdownRequestedAt": 123,
  "shutdownSource": "mobile-app | cli | os-signal | unknown"
}
```

## Decryption flow (client side)

```mermaid
flowchart TD
    Start([Receive encrypted field]) --> B64[Decode base64 to bytes]
    B64 --> Check{Has dataKey?}

    Check --> |No| Legacy[Use legacy variant]
    Check --> |Yes| DataKey[Use dataKey variant]

    subgraph "Legacy Path"
        Legacy --> ExtractL[Extract nonce + ciphertext]
        ExtractL --> DecryptL[secretbox.open with shared key]
    end

    subgraph "DataKey Path"
        DataKey --> GetDEK[Decrypt dataEncryptionKey bundle]
        GetDEK --> ExtractD[Extract version + nonce + ciphertext + tag]
        ExtractD --> DecryptD[AES-GCM decrypt with DEK]
    end

    DecryptL --> Plain([Plaintext JSON])
    DecryptD --> Plain
```

- Read base64 field from API/Socket.
- Decode base64 to bytes.
- Choose encryption variant (`legacy` or `dataKey`) based on local credentials.
- Decrypt bytes using the appropriate key and algorithm.

For `dataKey`, clients must first decrypt or derive the per-session/per-machine data key from the stored `dataEncryptionKey` bundle.

## Server-side encryption (service tokens)

```mermaid
graph LR
    subgraph "Third-Party Tokens"
        GH[GitHub OAuth]
        OAI[OpenAI]
        ANT[Anthropic]
        GEM[Gemini]
    end

    subgraph "Server"
        Secret[HANDY_MASTER_SECRET]
        KeyTree[KeyTree]
        Encrypt[Encrypt]
    end

    DB[(Postgres)]

    Secret --> KeyTree --> Encrypt
    GH & OAI & ANT & GEM --> Encrypt --> DB

    style GH fill:#fff3e0
    style OAI fill:#fff3e0
    style ANT fill:#fff3e0
    style GEM fill:#fff3e0
```

The server encrypts certain third-party tokens at rest:
- GitHub OAuth tokens (`GithubUser.token`).
- Vendor service tokens (`ServiceAccountToken.token`).

These are encrypted with a server-only KeyTree derived from `HANDY_MASTER_SECRET` and are not end-to-end encrypted.

## Encoding conventions

```mermaid
graph TB
    subgraph "Encoding Rules"
        E1["Encrypted bytes → base64 string"]
        E2["Timestamps → plain number (epoch ms)"]
        E3["IDs, tags, versions → plain string/number"]
    end

    subgraph "Examples"
        Ex1["metadata: 'SGVsbG8gV29ybGQ='"]
        Ex2["createdAt: 1704067200000"]
        Ex3["id: 'abc-123', version: 5"]
    end

    E1 --> Ex1
    E2 --> Ex2
    E3 --> Ex3
```

- All encrypted bytes are base64 strings on the wire unless explicitly noted.
- Timestamps remain plain numbers (epoch ms) and are not encrypted by the server.
- Non-encrypted identifiers (ids, tags, versions) are always plain strings/numbers.

## Session storage modes

Sessions can store transcript content in encrypted-at-rest or plaintext-at-rest mode. This is a storage mode, not a transport-security or authentication mode.

Canonical concepts:

- **Server storage policy:** `required_e2ee | optional | plaintext_only`, surfaced through `/v1/features`.
- **Account encryption mode:** `e2ee | plain`, used as the default for new sessions.
- **Session encryption mode:** `e2ee | plain`, fixed at session creation so a transcript does not mix modes.
- **Client encryption requirement:** `follow_account | require_e2ee`, resolved strongest-wins from the synced Account preference, a UI device-local pin, and the daemon's `HAPPIER_ENCRYPTION_REQUIREMENT` override.
- **Content envelope:**
  - encrypted content: `{ t: 'encrypted', c: string }`
  - plaintext content: `{ t: 'plain', v: unknown }`

Write paths must enforce mode/content-kind compatibility:

- `e2ee` sessions accept encrypted content only.
- `plain` sessions accept plain content only.

Clients must parse the envelope and branch explicitly. Do not guess that content is encrypted.

`require_e2ee` is enforced at the Account-settings and Session-content choke points. A client must reject a plaintext Account envelope before publishing it, reject plaintext session creation or a create-or-load response, and avoid opening or authoring plaintext Session content. The UI device-local pin remains scoped with the existing server/account settings persistence; the synced preference reaches a daemon through the existing Account-settings snapshot and pre-spawn minimum-version hint. No relay API or separate UI-to-daemon policy field owns this decision.

Missing client-requirement fields preserve the released behavior (`follow_account`). The daemon environment override can only strengthen the effective requirement; invalid non-empty values fail startup.

Sharing rules:

- Plain sessions can share without `encryptedDataKey` because access is server-managed.
- E2EE sessions and public shares require a valid encrypted data-key envelope.

Feature gates:

- `encryption.plaintextStorage`
- `encryption.accountOptOut`
- `encryption.plaintextMachine` (development Machine support)

Do not gate plaintext behavior on raw env vars or `capabilities` fields.

When Account encryption mode changes, every active new-Session draft participates in the same
atomic mode transition as the other Account-scoped encrypted records. Existing-Session drafts do
not participate: their envelope remains bound to the owning Session. A missing or incomplete draft
census, a revision mismatch, or a wrong envelope kind aborts the Account transition without
partially changing the mode.

## Terminal pairing authentication rollout

Terminal pairing v3 adds a 32-byte secret to the QR/deep link and authenticates the sealed
content-key response with HMAC-SHA-256. The terminal keeps that secret local and does not include it
in the relay auth request.

The current rollout is an **expansion phase**: new native clients produce v3 responses, while the
terminal still accepts legacy v1/v2 responses for compatibility. Until a later release activates
v3 enforcement, a malicious relay can still downgrade the exchange to a forged legacy response.

Users who want to opt into enforcement during the expansion phase can require the current
authenticated protocol locally:

```bash
HAPPIER_TERMINAL_PAIRING_REQUIRE=v3 happier auth login
```

`v3` is a minimum accepted pairing-protocol requirement: legacy v1/v2 responses are rejected, and
future supported versions may satisfy the same or a stronger requirement. Unknown values fail
closed with a configuration error. For `auth request --json` plus `auth wait`, the requirement is
persisted in the private pending-auth state so the wait process cannot accidentally lose it.

Native-app QR pairing can provide relay-independent authentication once enforcement is active
because the secret travels camera-to-app. Web pairing cannot make the same guarantee against a
hostile self-hosted relay: that relay also serves the JavaScript which receives the secret, so the
web flow necessarily trusts its web origin.

### Credential variants (development)

The development terminal response parser distinguishes `dataKey` and `tokenOnly`.
The data-key response keeps its existing bytes and v3 MAC contract; legacy v1/v2
responses remain readable under the expansion policy above. An approver sends the
new token-only response only when the terminal request explicitly advertises
`supportsTokenOnly: true`. The token arrives through the existing authorized auth
response; the sealed token-only payload supplies no fabricated content key.

Account-link QR responses also distinguish legacy recovery secrets, data-key
material, and token-only authorization. New readers advertise
`supportsCredentialVariants`; reverse Add Phone pairing persists that boolean for
the approver. A data-key machine key is never relabeled as a legacy recovery secret
for an older reader. Unsupported credential variants fail explicitly rather than
producing an unusable linked device.

Before development clients release Account key material through terminal pairing or
Account-link QR, they read the current Account mode. E2EE provisioning checks that
the retained key matches the Account's published content public key and verifies
its signature against the Account signing key. A valid Account token and retained
key custody alone do not prove that this is still the active encryption key.

Released legacy Accounts without a published content key remain provisionable when
the recovery secret proves their unchanged signing identity. A data-key credential
without a verifiable current binding, or a retained key that differs from the
published key, cannot approve this operation; restore the Account's current key
first. Plain Accounts retain their genuine historical key custody and token-only
pairing behavior. These checks establish authority at the current read; they do
not introduce a new ordering or revocation protocol for concurrent mode changes.

## Implementation references
- Client crypto: `apps/cli/src/api/encryption.ts`
- Session message format: `apps/cli/src/api/types.ts`
- Server message ingestion: `apps/server/sources/app/api/socket/sessionUpdateHandler.ts`
- Artifact/KV routes: `apps/server/sources/app/api/routes/artifactsRoutes.ts`, `apps/server/sources/app/kv/kvMutate.ts`
- Plain Machine format: `packages/protocol/src/machines/machineStoredContent.ts`
- Machine conversion: `apps/cli/src/api/machine/resolveMachineRegistrationContent.ts`, `apps/server/sources/app/machines/transitionMachineContentKey.ts`, `apps/server/sources/app/machines/migrateMachineAccountEncryptionInTx.ts`
- Credential variants: `packages/protocol/src/crypto/terminalProvisioningV2.ts`, `apps/ui/sources/auth/flows/buildAccountLinkResponse.ts`
