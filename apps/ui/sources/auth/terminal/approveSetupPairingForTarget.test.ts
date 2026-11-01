import { beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    createSetupPairingPromptData,
    SYSTEM_TASK_PROTOCOL_VERSION,
    openTerminalProvisioningV2Payload,
    type SystemTaskEvent,
    type SystemTaskJsonValue,
} from '@happier-dev/protocol';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';

const mocks = vi.hoisted(() => ({
    serverFetch: vi.fn(),
    accountMode: vi.fn(),
    accountProfile: vi.fn(),
    getCredentialsForServerUrl: vi.fn(),
}));

// Network boundary: `serverFetch` is the only outward write in the flow.
vi.mock('@/sync/http/client', () => ({
    serverFetch: (path: string, init?: RequestInit, options?: unknown) => {
        if (path.endsWith('/v1/account/encryption')) return mocks.accountMode(path, init, options);
        if (path.includes('/v1/user/')) return mocks.accountProfile(path, init, options);
        return mocks.serverFetch(path, init, options);
    },
}));

// Secure-storage boundary. Everything else in the module (credential shape checks, key
// derivation) stays real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getCredentialsForServerUrl: mocks.getCredentialsForServerUrl,
        },
    };
});

import {
    approveSetupPairingForTarget,
    readSetupPairingPrompt,
    type SetupPairingApprovalAnswer,
    type SetupPairingApprovalTarget,
    type SetupUnmanagedCliDecision,
} from './approveSetupPairingForTarget';

const RELAY_URL = 'https://relay.example.test';
const RELAY_KEY = createServerUrlComparableKey(RELAY_URL);
const SERVER_ID = 'custom-2';
const ACCOUNT_ID = 'acct_app';
const APP_TOKEN = `header.${Buffer.from(JSON.stringify({ sub: ACCOUNT_ID })).toString('base64')}.signature`;
const TASK_ID = 'task_1';
const CLI_COMMAND = '/home/dev/happier-stack/apps/cli/bin/happier.mjs';

const terminalSecretKey = new Uint8Array(32).fill(4);
const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;
const contentPrivateKey = new Uint8Array(32).fill(9);

const SENSITIVE_KEY_PATTERN = /secret|token|password|statefile/i;

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * The prompt event the hsetup executor produces, built through the shared wire contract so a
 * change to that payload breaks this fixture instead of silently passing. An override of
 * `undefined` removes the field, standing in for an executor that did not state it.
 */
function buildPromptEvent(
    overrides: Readonly<Record<string, SystemTaskJsonValue | undefined>> = {},
): SystemTaskEvent {
    const data: Record<string, SystemTaskJsonValue> = {
        ...createSetupPairingPromptData({
            publicKeyB64Url: encodeBase64(terminalPublicKey, 'base64url'),
            relayUrl: RELAY_URL,
            serverIdentityKey: RELAY_KEY,
            accountId: ACCOUNT_ID,
            pairingRequirement: 'compatible',
            cliProvenance: 'managed',
            cliCommand: CLI_COMMAND,
        }),
    };
    for (const [key, value] of Object.entries(overrides)) {
        if (typeof value === 'undefined') {
            delete data[key];
            continue;
        }
        data[key] = value;
    }
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        taskId: TASK_ID,
        tsMs: 10,
        type: 'prompt',
        stepId: 'setup.thisComputer.auth.request',
        message: 'Approve this computer in Happier to continue',
        data,
    };
}

function buildTarget(overrides: Partial<SetupPairingApprovalTarget> = {}): SetupPairingApprovalTarget {
    return {
        expectedRelayUrl: RELAY_URL,
        expectedAccountId: ACCOUNT_ID,
        serverId: SERVER_ID,
        ...overrides,
    };
}

function readPrompt(event: SystemTaskEvent) {
    const prompt = readSetupPairingPrompt(event);
    if (!prompt) throw new Error('fixture did not parse as a setup pairing prompt');
    return prompt;
}

async function run(params: Readonly<{
    event?: SystemTaskEvent;
    target?: SetupPairingApprovalTarget;
    activeTaskId?: string;
    confirmUnmanagedCli?: (details: SetupUnmanagedCliDecision) => Promise<boolean>;
}>) {
    const answers: SetupPairingApprovalAnswer[] = [];
    const outcome = await approveSetupPairingForTarget({
        prompt: readPrompt(params.event ?? buildPromptEvent()),
        activeTaskId: params.activeTaskId ?? TASK_ID,
        target: params.target ?? buildTarget(),
        ...(params.confirmUnmanagedCli ? { confirmUnmanagedCli: params.confirmUnmanagedCli } : {}),
        respond: async (answer) => {
            answers.push(answer);
        },
    });
    return { outcome, answers };
}

beforeEach(() => {
    mocks.serverFetch.mockReset();
    mocks.accountMode.mockReset();
    mocks.accountProfile.mockReset();
    mocks.accountMode.mockResolvedValue(jsonResponse({ mode: 'plain', updatedAt: 1 }));
    mocks.getCredentialsForServerUrl.mockReset();
    mocks.getCredentialsForServerUrl.mockResolvedValue({
        token: APP_TOKEN,
        encryption: {
            publicKey: encodeBase64(new Uint8Array(32).fill(1)),
            machineKey: encodeBase64(contentPrivateKey),
        },
    });
});

describe('approveSetupPairingForTarget refusals (INV2)', () => {
    it.each([9, 11])('checks retained same-Account data-key custody against the first published E2EE key (%s)', async (currentKeyByte) => {
        const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(6));
        const currentContent = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(currentKeyByte)).publicKey;
        const prefix = new TextEncoder().encode('Happy content key v1\u0000');
        const binding = new Uint8Array(prefix.length + currentContent.length);
        binding.set(prefix); binding.set(currentContent, prefix.length);
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/v1/account/encryption')) return jsonResponse({ mode: 'e2ee', updatedAt: 1 });
            if (path.endsWith(`/v1/user/${ACCOUNT_ID}`)) return jsonResponse({ user: {
                id: ACCOUNT_ID, firstName: '', lastName: null, avatar: null, username: '', bio: null,
                status: 'none', publicKey: Buffer.from(signing.publicKey).toString('hex'),
                contentPublicKey: encodeBase64(currentContent),
                contentPublicKeySig: encodeBase64(tweetnacl.sign.detached(binding, signing.secretKey)),
            } });
            if (path.includes('/v1/auth/request/status')) return jsonResponse({ status: 'pending', supportsV2: true });
            if (path.endsWith('/v1/auth/response') && init?.method === 'POST') return jsonResponse({ success: true });
            throw new Error(`Unexpected request ${path}`);
        });
        mocks.accountMode.mockImplementation((...args) => mocks.serverFetch(...args));
        mocks.accountProfile.mockImplementation((...args) => mocks.serverFetch(...args));
        const { outcome, answers } = await run({});
        if (currentKeyByte === 11) {
            expect(outcome).toEqual({ approved: false, reason: 'credentials_unusable' });
            expect(answers).toEqual([{ approved: false, reason: 'credentials_unusable' }]);
            expect(mocks.serverFetch.mock.calls.some((call) => call[0].endsWith('/v1/auth/response'))).toBe(false);
        } else {
            expect(outcome).toEqual({ approved: true, result: 'approved' });
            const posted = mocks.serverFetch.mock.calls.find((call) => call[0].endsWith('/v1/auth/response'));
            if (!posted) throw new Error('Missing pairing response');
            const body = JSON.parse(String(posted[1]?.body));
            expect(openTerminalProvisioningV2Payload({ payload: decodeBase64(body.response), recipientSecretKeyOrSeed: terminalSecretKey })).toEqual(contentPrivateKey);
        }
    });

    it.each([
        { token: `header.${Buffer.from(JSON.stringify({ sub: 'acct_after_sign_in' })).toString('base64')}.signature`, reason: 'account_mismatch' },
        { token: 'unusable-token', reason: 'credentials_unusable' },
    ] as const)('refuses retained pairing when the current target credentials cannot bind the original account: $reason', async ({ token, reason }) => {
        // The delayed prompt still names the original account; the secure-storage read now
        // returns credentials replaced by a later sign-in on this same relay profile.
        mocks.getCredentialsForServerUrl.mockResolvedValue({
            token,
            encryption: {
                publicKey: encodeBase64(new Uint8Array(32).fill(1)),
                machineKey: encodeBase64(new Uint8Array(32).fill(12)),
            },
        });
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: true }));
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

        const { outcome, answers } = await run({});

        expect(outcome).toEqual({ approved: false, reason });
        expect(answers).toEqual([{ approved: false, reason }]);
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('refuses when the prompt relay differs from the relay the app sent', async () => {
        const { outcome, answers } = await run({
            event: buildPromptEvent({ relayUrl: 'https://other.example.test' }),
        });

        expect(outcome).toEqual({ approved: false, reason: 'relay_mismatch' });
        expect(answers).toEqual([{ approved: false, reason: 'relay_mismatch' }]);
        expect(mocks.getCredentialsForServerUrl).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('refuses when the CLI is configured for a relay other than the one the app sent, even if the echo matches', async () => {
        const { outcome } = await run({
            event: buildPromptEvent({
                serverIdentityKey: createServerUrlComparableKey('https://other.example.test'),
            }),
        });

        expect(outcome).toEqual({ approved: false, reason: 'identity_mismatch' });
        expect(mocks.getCredentialsForServerUrl).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('refuses a prompt that does not belong to the active setup task', async () => {
        const { outcome } = await run({ activeTaskId: 'task_9' });

        expect(outcome).toEqual({ approved: false, reason: 'task_mismatch' });
        expect(mocks.getCredentialsForServerUrl).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('refuses an override CLI outright when no human can be asked', async () => {
        const override = await run({ event: buildPromptEvent({ cliProvenance: 'override' }) });
        expect(override.outcome).toEqual({ approved: false, reason: 'cli_not_managed' });

        const silent = await run({ event: buildPromptEvent({ cliProvenance: undefined }) });
        expect(silent.outcome).toEqual({ approved: false, reason: 'cli_not_managed' });

        expect(mocks.getCredentialsForServerUrl).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('refuses a pairing raised for an account other than the one this run is setting up', async () => {
        // Approval seals THIS account's content key. A prompt pairing the computer to another
        // account must never receive it, even though the task, relay and CLI all check out.
        const { outcome, answers } = await run({
            event: buildPromptEvent({ accountId: 'acct_other' }),
        });

        expect(outcome).toEqual({ approved: false, reason: 'account_mismatch' });
        expect(answers).toEqual([{ approved: false, reason: 'account_mismatch' }]);
        expect(mocks.getCredentialsForServerUrl).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('refuses when the prompt names no account at all, rather than approving an unbound pairing', async () => {
        const { outcome } = await run({ event: buildPromptEvent({ accountId: undefined }) });

        expect(outcome).toEqual({ approved: false, reason: 'account_mismatch' });
        expect(mocks.getCredentialsForServerUrl).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('fails closed with a named reason when the request requires v3 pairing', async () => {
        const { outcome } = await run({ event: buildPromptEvent({ pairingRequirement: 'v3' }) });

        expect(outcome).toEqual({ approved: false, reason: 'pairing_requirement_v3' });
        expect(mocks.getCredentialsForServerUrl).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('refuses when no credentials exist for the exact target', async () => {
        mocks.getCredentialsForServerUrl.mockResolvedValue(null);

        const { outcome } = await run({});

        expect(outcome).toEqual({ approved: false, reason: 'credentials_unavailable' });
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('refuses when the relay cannot accept a v2 response', async () => {
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: false }));

        const { outcome } = await run({});

        expect(outcome).toEqual({ approved: false, reason: 'v2_unavailable' });
        // Only the status probe ran; nothing was posted.
        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
    });

    it('does not parse a prompt that lacks the public pairing material or the CLI identity', () => {
        expect(readSetupPairingPrompt(buildPromptEvent({ publicKeyB64Url: '' }))).toBeNull();
        expect(readSetupPairingPrompt(buildPromptEvent({ serverIdentityKey: '' }))).toBeNull();
        expect(readSetupPairingPrompt(buildPromptEvent({ kind: 'somethingElse' }))).toBeNull();
        expect(readSetupPairingPrompt({ ...buildPromptEvent(), type: 'progress' })).toBeNull();
    });

    it('refuses an unknown pairing requirement rather than guessing', async () => {
        const { outcome } = await run({ event: buildPromptEvent({ pairingRequirement: 'v9' }) });
        expect(outcome).toEqual({ approved: false, reason: 'pairing_requirement_unsupported' });
    });
});

describe('approveSetupPairingForTarget approval (R4)', () => {
    it('seals a v2 response from credentials read for the exact target and responds approved', async () => {
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: true }));
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

        const { outcome, answers } = await run({});

        expect(outcome).toEqual({ approved: true, result: 'approved' });
        expect(answers).toEqual([{ approved: true }]);

        // Credentials were read for that exact relay + identity, never the focused one, and only
        // because the prompt named the account this run is setting up.
        expect(mocks.getCredentialsForServerUrl).toHaveBeenCalledWith(RELAY_URL, { serverId: SERVER_ID });

        // Both requests were addressed at the explicit relay.
        const [statusCall, responseCall] = mocks.serverFetch.mock.calls;
        expect(String(statusCall?.[0])).toMatch(/^https:\/\/relay\.example\.test\/v1\/auth\/request\/status\?publicKey=/);
        expect(String(responseCall?.[0])).toBe(`${RELAY_URL}/v1/auth/response`);

        // The posted payload is a real v2 envelope the terminal can open with its ephemeral key.
        const init = responseCall?.[1] as RequestInit | undefined;
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${APP_TOKEN}`);
        const body = JSON.parse(String(init?.body)) as { publicKey: string; response: string };
        expect(body.publicKey).toBe(encodeBase64(terminalPublicKey));
        const opened = openTerminalProvisioningV2Payload({
            payload: decodeBase64(body.response, 'base64'),
            recipientSecretKeyOrSeed: terminalSecretKey,
        });
        expect(opened).not.toBeNull();
        expect(Array.from(opened!)).toEqual(Array.from(contentPrivateKey));
    });

    it('still approves when the app relay carries credentials the prompt no longer echoes', async () => {
        // The builder strips userinfo from the prompt's relay, so the approver's comparison must
        // keep matching the app's own (credential-bearing) relay — otherwise the redaction would
        // silently break pairing.
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: true }));
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
        const credentialRelayUrl = 'https://relay-user:relay-pass@relay.example.test';

        const { outcome } = await run({
            event: buildPromptEvent({ relayUrl: 'https://relay.example.test/' }),
            target: buildTarget({ expectedRelayUrl: credentialRelayUrl }),
        });

        expect(outcome).toEqual({ approved: true, result: 'approved' });
        expect(mocks.getCredentialsForServerUrl).toHaveBeenCalledWith(credentialRelayUrl, { serverId: SERVER_ID });
    });

    it('treats an already-authorized request as approved so the waiting CLI is released', async () => {
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'authorized', supportsV2: true }));

        const { outcome, answers } = await run({});

        expect(outcome).toEqual({ approved: true, result: 'already_authorized' });
        expect(answers).toEqual([{ approved: true }]);
    });

    it('never places credential or secret material in the task answer', async () => {
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: true }));
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

        const { answers } = await run({});
        const refused = await run({ event: buildPromptEvent({ relayUrl: 'https://other.example.test' }) });
        expect(refused.outcome).toEqual({ approved: false, reason: 'relay_mismatch' });

        for (const answer of [...answers, ...refused.answers]) {
            for (const key of Object.keys(answer)) {
                expect(key).not.toMatch(SENSITIVE_KEY_PATTERN);
            }
            expect(JSON.stringify(answer)).not.toContain(APP_TOKEN);
        }
    });
});

describe('approveSetupPairingForTarget attended override decision (A1)', () => {
    it('approves a managed CLI silently — no human is ever asked', async () => {
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: true }));
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
        const confirm = vi.fn(async (_decision: SetupUnmanagedCliDecision) => true);

        const { outcome } = await run({ confirmUnmanagedCli: confirm });

        expect(outcome).toEqual({ approved: true, result: 'approved' });
        expect(confirm).not.toHaveBeenCalled();
    });

    it('asks exactly once, naming the resolved binary, and approves when the human accepts', async () => {
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: true }));
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
        const confirm = vi.fn(async (_decision: SetupUnmanagedCliDecision) => true);

        const { outcome, answers } = await run({
            event: buildPromptEvent({ cliProvenance: 'override' }),
            confirmUnmanagedCli: confirm,
        });

        expect(outcome).toEqual({ approved: true, result: 'approved' });
        expect(answers).toEqual([{ approved: true }]);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm.mock.calls[0]?.[0]).toEqual({ cliCommand: CLI_COMMAND });
    });

    it('declines by name when the human refuses, and reads no credentials', async () => {
        const confirm = vi.fn(async (_decision: SetupUnmanagedCliDecision) => false);

        const { outcome, answers } = await run({
            event: buildPromptEvent({ cliProvenance: 'override' }),
            confirmUnmanagedCli: confirm,
        });

        expect(outcome).toEqual({ approved: false, reason: 'cli_not_approved' });
        expect(answers).toEqual([{ approved: false, reason: 'cli_not_approved' }]);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(mocks.getCredentialsForServerUrl).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('still asks when the executor could not name the binary', async () => {
        const confirm = vi.fn(async (_decision: SetupUnmanagedCliDecision) => false);

        await run({
            event: buildPromptEvent({ cliProvenance: 'override', cliCommand: undefined }),
            confirmUnmanagedCli: confirm,
        });

        expect(confirm.mock.calls[0]?.[0]).toEqual({ cliCommand: null });
    });

    it('never reaches the human above a binding refusal, whatever the provenance', async () => {
        // The order is load-bearing: task, relay, CLI identity, account and the pairing
        // requirement are hard refusals and must all be settled BEFORE an override CLI can be
        // offered to a human. Reordering the confirmation above any of them would let a
        // mismatched prompt be talked past by a user.
        const cases: ReadonlyArray<Readonly<{ run: Parameters<typeof run>[0]; reason: string }>> = [
            { run: { activeTaskId: 'task_9' }, reason: 'task_mismatch' },
            { run: { event: buildPromptEvent({ cliProvenance: 'override', relayUrl: 'https://other.example.test' }) }, reason: 'relay_mismatch' },
            {
                run: {
                    event: buildPromptEvent({
                        cliProvenance: 'override',
                        serverIdentityKey: createServerUrlComparableKey('https://other.example.test'),
                    }),
                },
                reason: 'identity_mismatch',
            },
            { run: { event: buildPromptEvent({ cliProvenance: 'override', accountId: 'acct_other' }) }, reason: 'account_mismatch' },
            { run: { event: buildPromptEvent({ cliProvenance: 'override', accountId: undefined }) }, reason: 'account_mismatch' },
            { run: { event: buildPromptEvent({ cliProvenance: 'override', pairingRequirement: 'v3' }) }, reason: 'pairing_requirement_v3' },
            { run: { event: buildPromptEvent({ cliProvenance: 'override', pairingRequirement: 'v9' }) }, reason: 'pairing_requirement_unsupported' },
        ];

        for (const testCase of cases) {
            const confirm = vi.fn(async (_decision: SetupUnmanagedCliDecision) => true);
            const { outcome } = await run({
                ...testCase.run,
                event: testCase.run.event ?? buildPromptEvent({ cliProvenance: 'override' }),
                confirmUnmanagedCli: confirm,
            });
            expect(outcome).toEqual({ approved: false, reason: testCase.reason });
            expect(confirm).not.toHaveBeenCalled();
        }
        expect(mocks.getCredentialsForServerUrl).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });
});
