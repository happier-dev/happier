import { authApproveAtEndpoint } from '@/auth/flows/approve';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import type { SystemTaskEvent } from '@happier-dev/protocol/system/tasks/spec';
import { parseToken } from '@/utils/auth/parseToken';

/**
 * Explicit-target approval configuration for system-task token-only pairing prompts. The target
 * endpoint and identity are supplied by the caller; the focused Home is never consulted.
 */
export type SystemTaskAuthRequestApproval = Readonly<{
    /** Explicit target Home endpoint; never resolved from the focused Home. */
    expectedRelayUrl: string;
    serverId?: string;
    /** Account the initiating setup promised to connect; checked before issuing an approval. */
    expectedAccountId?: string;
}>;

export type SystemTaskTokenOnlyAuthRequestPrompt = Readonly<{
    publicKey: string;
    response: string;
    relayUrl: string;
    /** How the executor acquired the CLI raising this request; absent on a prompt that omits it. */
    cliProvenance: string | null;
    /**
     * The command the executor actually resolved and is driving. Shown verbatim to the person
     * asked to vouch for a CLI the managed install path did not place, so the decision is about
     * the program that is really asking. A local filesystem path, never a credential; `null` when
     * the executor named none.
     */
    cliCommand: string | null;
}>;

/**
 * Every way this owner can refuse to approve. Each one travels back to the executor in the task
 * answer, so a run that stops says *why* instead of reading as a human decline (R8).
 */
export type SystemTaskAuthRequestRefusalReason =
    | 'relay_mismatch'
    /** A non-managed CLI asked and the person at the keyboard declined it. */
    | 'cli_not_approved'
    | 'credentials_unavailable'
    | 'approve_failed'
    | 'request_not_found';

/**
 * What a human is shown when a CLI the managed install path did not place asks for approval. The
 * command comes from the executor for this run; `null` only when it named none.
 */
export type SystemTaskUnmanagedCliDecision = Readonly<{
    cliCommand: string | null;
}>;

export type SystemTaskAuthRequestApprovalOutcome =
    | Readonly<{ approved: true }>
    | Readonly<{ approved: false; reason: SystemTaskAuthRequestRefusalReason }>;

/**
 * Recognizes the blocking token-only approval prompt emitted by `setup.thisComputer.v1`.
 * Legacy non-blocking `authRequest` prompts (no response material) are ignored.
 */
export function readTokenOnlyAuthRequestPrompt(event: Pick<SystemTaskEvent, 'type' | 'data'>): SystemTaskTokenOnlyAuthRequestPrompt | null {
    if (event.type !== 'prompt') {
        return null;
    }
    const data = event.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return null;
    }
    const record = data as Record<string, unknown>;
    if (record.kind !== 'authRequest' || record.responseKind !== 'tokenOnly') {
        return null;
    }
    const publicKey = typeof record.publicKey === 'string' ? record.publicKey.trim() : '';
    const response = typeof record.response === 'string' ? record.response : '';
    const relayUrl = typeof record.relayUrl === 'string' ? record.relayUrl.trim() : '';
    const cliProvenance = typeof record.cliProvenance === 'string' ? record.cliProvenance.trim() : '';
    const cliCommand = typeof record.cliCommand === 'string' ? record.cliCommand.trim() : '';
    if (!publicKey || !response || !relayUrl) {
        return null;
    }
    return {
        publicKey,
        response,
        relayUrl,
        cliProvenance: cliProvenance || null,
        cliCommand: cliCommand || null,
    };
}

function matchesExpectedRelayUrl(promptRelayUrl: string, expectedRelayUrl: string): boolean {
    const promptKey = createServerUrlComparableKey(promptRelayUrl);
    const expectedKey = createServerUrlComparableKey(expectedRelayUrl);
    if (promptKey && expectedKey) {
        return promptKey === expectedKey;
    }
    return promptRelayUrl.trim() === expectedRelayUrl.trim();
}

/**
 * Answers one token-only system-task approval prompt through the explicit endpoint. It reads only
 * the Home-scoped credential for that explicit target, posts the opaque response via
 * `authApproveAtEndpoint`, and answers the task with `{ approved: boolean }`. No bearer, pairing
 * secret, claim material, or state path is ever placed in the answer, and every refusal is
 * answered so the task fails by name instead of waiting for a timeout.
 *
 * The relay check is a **hard refusal settled before** anything else: a prompt whose Home is not
 * the one the caller is setting up is never approved, and never reachable through a dialog.
 *
 * Only then does install ownership decide *how* the pairing is approved. That ownership is a
 * record, not verified publisher provenance — `managed` means this machine's managed release path
 * installed the binary, derived from a plain text marker under the user's own home — so it says
 * "this app's install path put it there", never "this binary is cryptographically official":
 *
 *   - **managed** — approve silently, so ordinary first-run onboarding stays zero-interaction.
 *   - **anything else, including a prompt that names no provenance** — ask the human exactly once,
 *     naming the resolved command. Accepting approves; declining refuses by name.
 *
 * Asking is what makes a repo/override build usable at all: refusing outright left every
 * developer and fork with a failure whose only affordance was a Retry that failed identically.
 * The narrower invariant this preserves is that the app must not release account authority
 * **unattended** to a CLI its own install path did not place.
 */
export async function respondToTokenOnlyAuthRequestPrompt(params: Readonly<{
    prompt: SystemTaskTokenOnlyAuthRequestPrompt;
    approval: SystemTaskAuthRequestApproval;
    /** Asks the person at the keyboard about a CLI the managed install path did not place. */
    confirmUnmanagedCli: (decision: SystemTaskUnmanagedCliDecision) => Promise<boolean>;
    respond: (answer: Readonly<{ approved: boolean; reason?: SystemTaskAuthRequestRefusalReason }>) => void | Promise<void>;
}>): Promise<SystemTaskAuthRequestApprovalOutcome> {
    const decline = async (reason: SystemTaskAuthRequestRefusalReason): Promise<SystemTaskAuthRequestApprovalOutcome> => {
        // The reason goes back with the answer: without it every refusal — a relay mismatch, an
        // unreadable credential, a failed POST — reaches the user as "this computer was not
        // approved", which is only true for the one case the human actually decided.
        await params.respond({ approved: false, reason });
        return { approved: false, reason };
    };

    if (!matchesExpectedRelayUrl(params.prompt.relayUrl, params.approval.expectedRelayUrl)) {
        return await decline('relay_mismatch');
    }

    // Silent approval is offered only to a CLI this machine's managed release path installed.
    // Anything else — env override, repo checkout, or a prompt that names no provenance at all —
    // is a decision for the person at the keyboard, who is shown the command that is asking.
    if (params.prompt.cliProvenance !== 'managed') {
        const confirmed = await params.confirmUnmanagedCli({ cliCommand: params.prompt.cliCommand });
        if (!confirmed) {
            return await decline('cli_not_approved');
        }
    }

    let token: string | null = null;
    try {
        const credentials = await TokenStorage.getCredentialsForServerUrl(
            params.approval.expectedRelayUrl,
            params.approval.serverId ? { serverId: params.approval.serverId } : {},
        );
        token = typeof credentials?.token === 'string' && credentials.token.trim()
            ? credentials.token
            : null;
    } catch {
        token = null;
    }
    if (!token) {
        return await decline('credentials_unavailable');
    }
    if (params.approval.expectedAccountId) {
        let accountId: string;
        try {
            accountId = parseToken(token);
        } catch {
            return await decline('credentials_unavailable');
        }
        if (accountId !== params.approval.expectedAccountId) {
            return await decline('credentials_unavailable');
        }
    }

    try {
        const result = await authApproveAtEndpoint({
            endpointUrl: params.approval.expectedRelayUrl,
            ...(params.approval.serverId ? { serverId: params.approval.serverId } : {}),
            token,
            publicKeyBase64: params.prompt.publicKey,
            responseBase64: params.prompt.response,
            responseKind: 'tokenOnly',
        });
        // `already_authorized` still releases the waiting terminal; only an expired/unknown
        // request declines back to the legacy surface.
        if (result === 'not_found') {
            return await decline('request_not_found');
        }
        await params.respond({ approved: true });
        return { approved: true };
    } catch {
        return await decline('approve_failed');
    }
}
