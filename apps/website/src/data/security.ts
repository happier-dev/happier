/**
 * Copy for /security.
 *
 * THE SECOND-HIGHEST-STAKES PAGE ON THE SITE, and the one whose reader is most
 * likely to check. /enterprise is read by someone running a security review of a
 * server they will host; this page is read by one developer deciding whether to
 * put a work session through somebody else's relay. Both of them stop reading
 * at the first sentence that is not true.
 *
 * THE RULE, same as /enterprise: a claim appears below only if it is traceable
 * to shipped source or to the shipped docs. Primitives are named because they
 * are checkable; nothing is named that was not read.
 *
 * WHAT THIS PAGE DELIBERATELY DOES NOT SAY
 *   - No certification. SOC 2, ISO 27001, HIPAA and GDPR compliance are not
 *     claimed anywhere on it, because none is evidenced anywhere in the tree.
 *   - No audit, and no wording that implies one ("reviewed", "assessed",
 *     "verified by"). The closing section says what there is instead.
 *   - No env vars, no operator recipes. That register belongs to /enterprise and
 *     to the docs; this page is the architecture and what it means for one
 *     person. The two pages link to each other exactly once.
 *
 * VERIFICATION ANCHORS (happier-dev/happier, the shipped tree):
 *   key tree              packages/protocol/src/crypto/keyDerivation.ts:14-33 —
 *                           HMAC-SHA-512 root + labelled child steps
 *   sealed key envelope   packages/protocol/src/crypto/boxBundle.ts:18-41 —
 *                           ephemeral X25519 public key ‖ 24-byte nonce ‖ box
 *   data-key envelope     packages/protocol/src/crypto/
 *                           encryptedDataKeyEnvelopeV1.ts:5-18
 *   account-scoped seal   packages/protocol/src/crypto/accountScopedCipher.ts:
 *                           67-70 (per-kind key), 96-109 (XSalsa20-Poly1305)
 *   session content       apps/cli/src/api/encryption.ts:116-138 —
 *                           createCipheriv('aes-256-gcm', dataKey, 12-byte
 *                           nonce), bundle = version ‖ nonce ‖ ct ‖ tag
 *   metadata is sealed    apps/cli/src/api/api.ts:446-456 — metadata and
 *                           agentState are encrypted before POST /v1/sessions,
 *                           and are sent as plaintext JSON only when the
 *                           session's mode is 'plain'
 *   what metadata holds   apps/cli/src/agent/runtime/createSessionMetadata.ts:
 *                           174-190 — path, os.hostname(), homedir, version
 *   stored content shape  apps/server/sources/app/session/messageContent/
 *                           normalizeIncomingSessionMessageContent.ts —
 *                           { t: 'encrypted', c } or { t: 'plain', v }
 *   message role          packages/protocol/src/sessionMessages/
 *                           sessionMessageRole.ts:3 — user | agent | event |
 *                           unknown; apps/server/sources/app/session/messageRole/
 *                           resolveSessionMessageRole.ts:26-33 — the server can
 *                           only DERIVE a role from plaintext, so on an
 *                           encrypted row the role is what the client supplied
 *   activity projection   apps/server/prisma/schema.prisma:303-321, whose own
 *                           comment reads "Server-readable per-session activity
 *                           projection (minimal, E2EE-safe)"
 *   credentials sealed    apps/ui/sources/sync/domains/connectedServices/
 *                           sealConnectedServiceCredential.ts — sealed on the
 *                           device, uploaded already sealed
 *   storage policy        packages/protocol/src/features/payload/capabilities/
 *                           encryptionCapabilities.ts:22-28 — DEFAULT is
 *                           storagePolicy 'required_e2ee', defaultAccountMode
 *                           'e2ee', allowAccountOptOut false
 *   policy enforcement    apps/server/sources/app/session/
 *                           encryptionRejectionCodes.ts
 *   policy is advertised  apps/server/sources/app/features/
 *                           encryptionFeature.ts — GET /v1/features
 *   per-session mode      docs server/encryption.mdx, "Per-session encryption
 *                           mode": chosen at creation, no mixed-mode sessions;
 *                           account switches affect new sessions only
 *   at-rest sealing       docs server/encryption.mdx, "Plaintext at-rest
 *                           sealing": settings and credentials default to
 *                           server_sealed even for plaintext accounts
 *   restore model         docs security/encryption.mdx — keys created on the
 *                           device; a new device authenticates but cannot read
 *                           older encrypted sessions until it is restored
 *   pairing               docs features/device-linking-and-restore.mdx,
 *                           "Approval and safety checks": "The QR code itself is
 *                           not the final credential."
 *   terminal pairing      packages/protocol/src/crypto/terminalProvisioningV2.ts
 *                           :22-39 — the content private key is sealed to the
 *                           terminal's public key; :12-19 the v3 payload adds a
 *                           MAC bound to the pairing secret
 *   push notifications    docs advanced/notifications.mdx — "The server stores
 *                           push tokens per account (it does *not* send push
 *                           payloads)"; the CLI sends them, and Happier "does
 *                           not try to dump full raw tool input" into one
 *
 * ONE ANCHOR THAT WAS CHECKED AND NOT USED. apps/server/sources/app/share/
 * encryptDataKey.ts exports encryptDataKeyForRecipient, which takes a PLAINTEXT
 * data key on the server. It reads like a contradiction of this whole page, so
 * it was traced: nothing calls it. The live share path is
 * app/api/routes/share/encryptedDataKeyValidation.ts, which only parses an
 * envelope the client sealed. The page says the server never seals a key
 * because the server never seals a key — but the reason that sentence is safe
 * is the grep, not the docs.
 */

export type SecurityHop = {
    id: 'device' | 'relay' | 'computer';
    /** Label under the glyph in the diagram. */
    label: string;
    /** Two words for what happens to the message here. */
    verb: string;
    body: string;
};

/**
 * The three points on the wire, and the animation under the heading is this
 * array drawn. The order is the order a message you type actually travels.
 */
export const SECURITY_HOPS: ReadonlyArray<SecurityHop> = [
    {
        id: 'device',
        label: 'Your phone',
        verb: 'Sealed here',
        body: 'The message is encrypted on the device you typed it on, under a key that belongs to that session and nothing else — 32 random bytes drawn when the session is created, AES-256-GCM, a fresh nonce per message. The session key is then sealed to your account’s own key with an ephemeral X25519 exchange, and it is the sealed copy the relay is handed.',
    },
    {
        id: 'relay',
        label: 'The relay',
        // "Carried, not read" was the old verb, and naming the thing you are
        // ruling out plants it: a reader told the relay does not read spends one
        // beat wondering whether it wanted to. The positive carries the same
        // fact — it is sealed the whole way across — and the body below still
        // states the limit plainly, once.
        verb: 'Carried sealed',
        body: 'What the server writes is a row shaped { t: "encrypted", c: "…" } — base64, plus a sealed key envelope it has no secret key for. It can route that row, count it, keep it and hand it back. It has nothing to open it with, and no endpoint asks it to.',
    },
    {
        id: 'computer',
        label: 'Your computer',
        verb: 'Opened here',
        body: 'The CLI opens the sealed session key with the account key it was given when you connected the terminal, decrypts, and passes the plain text to Claude Code, Codex, OpenCode or whichever agent is running. The reply makes the same trip in reverse, sealed before it leaves.',
    },
];

/** The line under the diagram. Short on purpose; the hops carry the detail. */
export const SECURITY_DIAGRAM_CAPTION =
    'A message you send from your phone, drawn at the three points it passes through. Everything the agent says back takes the same path in the opposite direction, sealed on your computer before it leaves.';

export type SecurityLedgerEntry = { id: string; title: string; body: string };

/**
 * What the relay holds.
 *
 * This list is longer and more specific than it needs to be, on purpose. A page
 * that says "the server stores encrypted blobs" and stops has told a reader who
 * knows how sync works nothing they can check, and left them to discover the
 * activity projection themselves — at which point every other sentence on the
 * page is in question. Name it first.
 */
export const SECURITY_VISIBLE: ReadonlyArray<SecurityLedgerEntry> = [
    {
        id: 'ciphertext',
        title: 'Ciphertext, and a key it cannot open',
        body: 'One row per message, holding base64 and nothing else, plus the session’s wrapped data key. The wrapping is done on a device; no server route produces one.',
    },
    {
        id: 'ids',
        title: 'Identifiers and shape',
        body: 'Account, device and session ids, a random tag per session, sequence numbers, timestamps and sizes. This is the part encryption does not cover on any system that syncs, and it is worth being plain about: the relay knows how much you sent and when.',
    },
    {
        id: 'role',
        title: 'Which side each message came from',
        body: 'Every message carries a role — user, agent, event or unknown — supplied by the client alongside the ciphertext. It is a column so a transcript can be paged and counted without being opened. On an encrypted row the server cannot derive it; it can only store what the client filed.',
    },
    {
        id: 'attention',
        // THE EVIDENCE FOR THIS ENTRY LIVES HERE, NOT IN THE SENTENCE.
        // apps/server/prisma/schema.prisma:303-321 is the projection, and its
        // own comment reads "Server-readable per-session activity projection
        // (minimal, E2EE-safe). These fields exist to support authoritative
        // badge counts for background/closed devices." The columns are
        // lastViewedSessionSeq, pendingPermissionRequestCount,
        // pendingUserActionRequestCount, thinking, latestTurnStatus and their
        // observed-at stamps — every one of them a counter, a flag or a time,
        // set by the client that already holds the plaintext.
        //
        // The copy used to quote that comment on the page ("the schema comment
        // calls it minimal, E2EE-safe"), which told the reader where we read it
        // rather than what it is. The claim a reader needs is why counters are
        // safe to hand a server: they are derived state, not content.
        title: 'A deliberately small activity projection',
        body: 'Whether a session is unread, how many permission requests are waiting, how many questions the agent has asked, whether it is thinking, how the last turn ended. Every one of those is derived state — a counter, a flag or a timestamp the client writes as a session moves — never a word of what was said. It exists so a phone that has been shut for an hour shows a correct badge the moment you open it, and counting is the most the server is given to do that with.',
    },
];

/** What it does not hold. Same discipline: specific, and each one checkable. */
export const SECURITY_INVISIBLE: ReadonlyArray<SecurityLedgerEntry> = [
    {
        id: 'content',
        title: 'What you typed, and what the agent replied',
        body: 'The transcript is the ciphertext. There is no second copy, no server-side index over it, and no summarisation step that would need one.',
    },
    {
        id: 'metadata',
        title: 'Where the session is running',
        body: 'The project path, your hostname, your home directory and the CLI version are session metadata, and metadata is encrypted with the same session key before the session is created. They are fields inside a sealed blob, not columns the server can sort on.',
    },
    {
        id: 'credentials',
        title: 'Your provider credentials',
        body: 'A connected account — the Claude or ChatGPT credential a session runs under — is sealed on the device before it is uploaded, under a key derived for that one purpose from your account secret. The relay stores an envelope and hands it back to your own devices.',
    },
    {
        id: 'code',
        title: 'Your repository',
        // NOT "never sent". Verified false: docs features/git.mdx:213 — "Direct file
        // preview, file download, folder download, and review/diff loading all use the
        // same transfer/decryption path for session workspace data." A reader who has
        // downloaded a folder from the app would catch it, on the page where being
        // caught costs most. The true claim is narrower and still strong: the repo is
        // never synced or mirrored, and anything that does move is sealed like the rest.
        body: 'Your repository is never synced or mirrored. The agent reads and writes files on the computer it runs on, and that computer stays the only full copy. When you ask for a file, a folder or a diff, it travels the same sealed path as everything else — because you asked for it, not because Happier keeps a copy.',
    },
];

/**
 * Keys.
 *
 * The one section where a false reassurance would be worst, so it states the
 * unrecoverable case rather than leaving the reader to find it: if every
 * signed-in device is gone and the secret key is gone, the encrypted sessions
 * are gone. A relay that could give them back is a relay that could read them,
 * and that is the trade the whole page describes.
 */
export const SECURITY_KEYS: ReadonlyArray<string> = [
    'There is one secret at the root of your account, and it is created on a device — not issued by a server. Everything else is derived from it by a key tree: an HMAC-SHA-512 root, then one HMAC step per labelled path element. The keypair that opens sealed session keys comes out of that tree under the label "content", and so does a separate key for each other kind of stored blob, so no key is doing two jobs.',
    'This is why a brand-new browser can sign in to your account and still show you nothing from last week. Signing in proves who you are to the relay. Reading an old session needs the key, and the key is not on the relay to send. Restoring the device is the step that moves it — from a device that already has it, or from the secret key you kept.',
    'It also means the loss case is real and worth stating once: if every signed-in device is gone and the secret key is gone with them, the encrypted sessions cannot be recovered by us or by anyone. A relay that could hand them back would be a relay that could read them.',
];

/**
 * Pairing. The most interesting verified detail on the page: the relay is a
 * courier for the handoff and not a party to it.
 */
export const SECURITY_PAIRING: ReadonlyArray<string> = [
    // WHAT THE QR CODE IS, RATHER THAN WHAT IT IS NOT. This sentence used to
    // read "The QR code is not the credential — the shipped documentation says
    // so in those words", which did both defects at once: it defined the thing
    // by negation, and it cited our own source material in the copy. The
    // anchor is docs features/device-linking-and-restore.mdx, "Approval and
    // safety checks": "The QR code itself is not the final credential." What
    // the reader needs is what scanning it actually does, which is raise a
    // request that a signed-in device has to approve.
    'Adding a device is the moment key material moves, so it is the moment worth understanding. Scanning the QR code raises a request, and that is all it does: the approval happens on a device that is already signed in, and when both screens show a short confirmation code you are meant to compare them before approving.',
    'What the approval actually does is seal the content key to the public key of the device that asked, in an envelope carrying an ephemeral sender key and a fresh nonce. That envelope travels through the relay like everything else does. Connecting a terminal adds one more binding on top: the payload is authenticated against a pairing secret that travelled in the QR code, not through the server, so a relay that swapped the payload could not produce a matching tag.',
];

/**
 * Storage policy, written for the individual reader.
 *
 * /enterprise covers the operator's half — the variable names, the recipes, the
 * at-rest options — and this page deliberately does not repeat any of it. What
 * a reader wants here is: which mode am I in, who chose it, and what changes.
 */
export const SECURITY_STORAGE: ReadonlyArray<string> = [
    'Everything above describes the default, and the default is not a suggestion the client can talk the server out of. A fresh relay is set to require end-to-end encrypted storage: a plaintext write is refused with a policy error rather than quietly accepted. Clients read the policy from the server’s own features endpoint before they create a session, so the mode a session is in was agreed before its first message.',
    // Two corrections against source. (1) "want server-side search" — docs
    // server/encryption.mdx:8 marks indexing/search as FUTURE work, so it cannot be
    // stated as a present reason. (2) "One lets an account choose" is not true of
    // `optional` alone: encryptionFeature.ts requires plaintextStorageEnabled &&
    // storagePolicy === 'optional' && allowAccountOptOut, and the last defaults false.
    'A server operator has two other settings available. One can allow an account to choose, so encrypted and plaintext sessions coexist on the same relay — it takes both the optional policy and the opt-out allowance, and the allowance is off unless the operator turns it on. The other requires plaintext, for organisations that manage encryption at the infrastructure layer and need the server able to read and process session content. That last one is a real trade and it is worth saying without softening: on a plaintext session the server can read the transcript. That is the point of the setting.',
    'The mode is fixed per session at creation, so one session is never half of each, and changing an account’s mode changes what happens to new sessions rather than reaching back into old ones. Nothing is retroactively decrypted, and nothing is retroactively encrypted either.',
];

/**
 * Notifications. Non-obvious, verifiable, and the one place session content
 * could leak past the model onto a lock screen — so it gets its own section
 * rather than a clause.
 */
export const SECURITY_NOTIFICATIONS: ReadonlyArray<string> = [
    'A push notification is the one thing that leaves the model behind, because it has to arrive at a phone that has nothing open. Happier’s answer is that the server does not send them. It stores your push tokens; the CLI on your own computer reads them back and sends the notification itself, which keeps the relay out of a path it would otherwise have to be told the contents of.',
    'What the payload carries is deliberately thin: the tool or request type, and a short hint where one helps — a file such as src/file.ts, a command name, a count like "3 questions". Raw tool input is not put into it. Enough to decide whether to reach for the phone, on a screen anyone standing behind you can read.',
];

/** The self-host paragraph, and the single link to /enterprise. */
export const SECURITY_SELF_HOST: ReadonlyArray<string> = [
    'All of this holds on a relay you do not run. The reason to run your own is the row above about identifiers and shape: encryption does not hide who is talking to whom, or how often, and on your own relay that ledger is yours too. One command puts the relay on hardware you own, and the path becomes your device, your relay, your computer, with nothing in it you have not deployed.',
];

/**
 * The closing section. Says what is NOT here — a certification — and replaces
 * it with the thing that is: file paths a reader can open. Naming them is the
 * most credible sentence available and costs nothing, because they are real.
 */
export const SECURITY_SOURCE: ReadonlyArray<string> = [
    'There is no certification on this page because there is not one to report, and a security page that gestures at compliance it has not got is worse than one that does not mention it. What is here instead is the code every sentence above was written from, MIT-licensed and readable before you run it: the primitives in packages/protocol/src/crypto, the session encryption in apps/cli/src/api/encryption.ts, the storage policy the server enforces in its features endpoint, and the schema that shows exactly which columns are plaintext.',
    'That is also the honest answer to how you should treat this page: as a map of where to look, not as a promise to be taken on trust. Read the four files, or run the relay yourself and read what it advertises to its clients.',
];

/** The one link this page makes into the docs, labelled as the reference. */
export const SECURITY_DOCS_URL = 'https://docs.happier.dev/security/encryption';
