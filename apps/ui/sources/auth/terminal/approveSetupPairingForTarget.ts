import {
    parseSetupPairingPromptData,
    type SetupPairingPromptPayload,
    type SystemTaskEvent,
} from '@happier-dev/protocol';

import { authApprove, AuthApproveUnsupportedResponseError, type AuthApproveResult } from '@/auth/flows/approve';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { parseToken } from '@/utils/auth/parseToken';

import {
    buildTerminalResponseV2,
    buildTerminalResponseV2TokenOnly,
    resolveTerminalProvisioningContentPrivateKey,
} from './terminalProvisioning';

/**
 * Approval of the desktop setup task's pairing request (plan R4 / INV2 / D3 / D4).
 *
 * This is the ONE helper that turns a `setup.thisComputer.v1` pairing prompt into an approved
 * request. Five binding checks are hard refusals, settled in this order before any credential is
 * read and before any human is asked:
 *
 *   1. the prompt was raised by the active setup task (not a stale or foreign task);
 *   2. the prompt's relay is exactly the relay the app sent the executor;
 *   3. the CLI's own identity for its configured relay is that same relay — the executor reports
 *      the comparable key the CLI ended up with, so an echo of the spec cannot stand in for it;
 *   4. the pairing is for the account this setup run is for — the executor states the
 *      `expectedAccountId` it was started with, and the response seals THAT account's content key,
 *      so a pairing raised for another account (or naming none) is refused before any read;
 *   5. the request does not demand v3 pairing — the prompt carries public material only (the
 *      pairing secret is redacted by design, A2), so a v3 or unknown requirement fails closed.
 *
 * Only after all five hold does install ownership decide HOW the pairing is approved. The
 * executor reports whether the CLI it drove came from this machine's desktop-managed install
 * layout or from an env/repo override. That is an ownership record, not a verified publisher
 * identity: the marker behind it is a plain text file under the user's own home (`current.version`,
 * `packages/cli-common/src/firstPartyRuntime/versionMarkers.ts`), so it says "this app's install
 * path put it there", never "this binary was cryptographically proven to be official Happier".
 * Ownership is still the right signal for choosing between two behaviours:
 *
 *   - **desktop-managed** — approve silently. First-run onboarding stays zero-interaction.
 *   - **anything else** — ask the human once, naming the resolved binary, through
 *     `confirmUnmanagedCli`. Accept approves; decline refuses by name. A caller with nobody to
 *     ask refuses outright. The same account content private key is already released, attended, to
 *     any CLI the user pairs by QR code (`useConnectTerminal`), so the invariant this preserves is
 *     narrower than "only official binaries": the app must not release the key UNATTENDED to a CLI
 *     its own install path did not place.
 *
 * Then, and only then: read the credentials stored for that exact target, verify their token still
 * names the original account, seal a V2 response from
 * the account content private key, post it through `authApprove` addressed at that same relay
 * (`serverFetch` refuses the authenticated write if the relay is not the focused one), and answer
 * the task. The answer carries a boolean and a reason code — never a token, secret or path — and a
 * refusal is always answered so the executor fails with a named error instead of hanging (C6).
 *
 * Not `useConnectTerminal`: that hook switches the focused relay and shows modals unconditionally,
 * which is wrong for the silent managed path.
 */

/**
 * The prompt as this app reads it: the shared wire payload plus the task it belongs to. The shape,
 * the kind and the parsing live in `@happier-dev/protocol`'s setup task contract, which the
 * executor in `apps/bootstrap` builds through — one definition, not a transcription.
 */
export type SetupPairingPrompt = SetupPairingPromptPayload & Readonly<{ taskId: string }>;

/**
 * What the app sent the executor. Deliberately identity only: install ownership comes from the
 * live prompt, which describes the CLI actually asking. An earlier ambient observation would be a
 * second, staler decision-maker for the same fact — and, because a caller could only supply it
 * once that inspection had resolved, a failed inspection used to leave the caller unable to answer
 * its own pairing prompt at all.
 */
export type SetupPairingApprovalTarget = Readonly<{
    expectedRelayUrl: string;
    /** The account this setup run is for. The prompt must name the same one or it is refused. */
    expectedAccountId: string;
    /** The app's own profile id for that relay; scopes the credential read, never compared to the CLI's. */
    serverId?: string;
}>;

export type SetupPairingRefusalReason =
    /** The caller wired no approval target at all (answered by the hook, never by this helper). */
    | 'approval_unavailable'
    | 'task_mismatch'
    | 'relay_mismatch'
    | 'identity_mismatch'
    | 'account_mismatch'
    /** An override CLI asked while nobody could be asked to vouch for it. */
    | 'cli_not_managed'
    /** An override CLI asked and the person at the keyboard declined it. */
    | 'cli_not_approved'
    | 'pairing_requirement_v3'
    | 'pairing_requirement_unsupported'
    | 'credentials_unavailable'
    | 'credentials_unusable'
    | 'v2_unavailable'
    | 'request_not_found'
    | 'approve_failed';

/** The task answer. Deliberately shaped so it can never carry credential material. */
export type SetupPairingApprovalAnswer =
    | Readonly<{ approved: true }>
    | Readonly<{ approved: false; reason: SetupPairingRefusalReason }>;

/**
 * What a human is shown when a CLI this app's install path did not place asks for approval. The
 * binary path comes from the executor for this run, so the person decides about the program that
 * is actually asking. `null` only when the executor named none.
 */
export type SetupUnmanagedCliDecision = Readonly<{
    cliCommand: string | null;
}>;

export type SetupPairingApprovalOutcome =
    | Readonly<{ approved: true; result: Extract<AuthApproveResult, 'approved' | 'already_authorized'> }>
    | Readonly<{ approved: false; reason: SetupPairingRefusalReason }>;

/**
 * Recognizes the setup task's pairing prompt through the shared contract. Anything that is not a
 * prompt of that kind carrying the public material is `null` — a caller must not guess at partial
 * data.
 */
export function readSetupPairingPrompt(event: SystemTaskEvent): SetupPairingPrompt | null {
    if (event.type !== 'prompt') return null;
    const payload = parseSetupPairingPromptData(event.data);
    return payload ? { taskId: event.taskId, ...payload } : null;
}

function resolveRefusal(params: Readonly<{
    prompt: SetupPairingPrompt;
    activeTaskId: string;
    target: SetupPairingApprovalTarget;
}>): SetupPairingRefusalReason | null {
    const { prompt, target } = params;
    if (prompt.taskId !== params.activeTaskId) return 'task_mismatch';
    const expectedKey = createServerUrlComparableKey(target.expectedRelayUrl);
    if (!expectedKey) return 'relay_mismatch';
    // The echoed relay must be the one the app sent…
    if (createServerUrlComparableKey(prompt.relayUrl) !== expectedKey) return 'relay_mismatch';
    // …and the CLI must actually be configured for it: the identity is the CLI's own comparable
    // key for its configured relay, so a CLI pointed elsewhere cannot be approved by an echo.
    if (prompt.serverIdentityKey !== expectedKey) return 'identity_mismatch';
    // …and it must be pairing this computer to the account this run is setting up: the approval
    // below seals that account's content key, so an unstated or foreign account is refused here.
    const expectedAccountId = target.expectedAccountId.trim();
    if (!expectedAccountId || prompt.accountId !== expectedAccountId) return 'account_mismatch';
    if (prompt.pairingRequirement === 'v3') return 'pairing_requirement_v3';
    if (prompt.pairingRequirement !== 'compatible') return 'pairing_requirement_unsupported';
    // Install ownership is deliberately NOT decided here: it is the only check that can be
    // answered by a human, so it must come last. Every binding check above is a hard refusal and
    // none of them may ever be reachable through a dialog.
    return null;
}

export async function approveSetupPairingForTarget(params: Readonly<{
    prompt: SetupPairingPrompt;
    activeTaskId: string;
    target: SetupPairingApprovalTarget;
    /**
     * Asks the person at the keyboard about a CLI this app's install path did not place. Absent
     * means nobody can be asked, so such a CLI is refused rather than approved unattended.
     */
    confirmUnmanagedCli?: (decision: SetupUnmanagedCliDecision) => Promise<boolean>;
    respond: (answer: SetupPairingApprovalAnswer) => Promise<void>;
}>): Promise<SetupPairingApprovalOutcome> {
    const refuse = async (reason: SetupPairingRefusalReason): Promise<SetupPairingApprovalOutcome> => {
        await params.respond({ approved: false, reason });
        return { approved: false, reason };
    };

    const refusal = resolveRefusal(params);
    if (refusal) {
        return await refuse(refusal);
    }

    const { target, prompt } = params;

    if (prompt.cliProvenance !== 'managed') {
        const confirm = params.confirmUnmanagedCli;
        if (!confirm) {
            return await refuse('cli_not_managed');
        }
        const approved = await confirm({ cliCommand: prompt.cliCommand });
        if (!approved) {
            return await refuse('cli_not_approved');
        }
    }

    const credentials = await TokenStorage.getCredentialsForServerUrl(
        target.expectedRelayUrl,
        target.serverId ? { serverId: target.serverId } : {},
    );
    if (!credentials || !credentials.token.trim()) {
        return await refuse('credentials_unavailable');
    }

    // A retained run keeps its original target, but this profile's credentials can change on
    // a later sign-in. Bind the actual token before sealing any account key or contacting relay.
    let credentialAccountId: string;
    try {
        credentialAccountId = parseToken(credentials.token);
    } catch {
        return await refuse('credentials_unusable');
    }
    if (credentialAccountId !== target.expectedAccountId.trim()) {
        return await refuse('account_mismatch');
    }

    let responseV2: Uint8Array;
    let answerTokenOnly: Uint8Array | undefined;
    let terminalPublicKey: Uint8Array;
    try {
        terminalPublicKey = decodeBase64(prompt.publicKeyB64Url, 'base64url');
        const contentPrivateKey = await resolveTerminalProvisioningContentPrivateKey(credentials, { endpointUrl: target.expectedRelayUrl });
        responseV2 = contentPrivateKey ? buildTerminalResponseV2({
            contentPrivateKey,
            terminalEphemeralPublicKey: terminalPublicKey,
        }) : new Uint8Array();
        answerTokenOnly = contentPrivateKey ? undefined : buildTerminalResponseV2TokenOnly({ terminalEphemeralPublicKey: terminalPublicKey });
    } catch {
        return await refuse('credentials_unusable');
    }

    let result: AuthApproveResult;
    try {
        // V1 (legacy secret export) is never offered to an automatic approval.
        result = await authApprove(credentials.token, terminalPublicKey, new Uint8Array(), responseV2, {
            endpointUrl: target.expectedRelayUrl,
            answerTokenOnly,
        });
    } catch (error) {
        return await refuse(error instanceof AuthApproveUnsupportedResponseError ? 'v2_unavailable' : 'approve_failed');
    }

    if (result === 'not_found') {
        return await refuse('request_not_found');
    }

    await params.respond({ approved: true });
    return { approved: true, result };
}
