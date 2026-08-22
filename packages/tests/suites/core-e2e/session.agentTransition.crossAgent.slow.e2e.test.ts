import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    RPC_METHODS,
    SessionAgentTransitionResultV1Schema,
    buildSessionAgentTransitionDividerLocalId,
    isSessionAgentTransitionDividerLocalId,
    readSessionAgentTransitionDividerFromStoredRecordV1,
} from '@happier-dev/protocol';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { startTestDaemon, stopDaemonFromHomeDir, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { callEncryptedMachineRpc } from '../../src/testkit/memoryRpc';
import { decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveAcpSdkTestRuntime } from '../../src/testkit/providers/acpSdkTestRuntime';
import { resolveMachineIdsFromSettings } from '../../src/testkit/providers/scenarios/runtimeHelpers';
import {
    enqueueSessionPromptForScenario,
    waitForAssistantMessageContaining,
    waitForSessionActive,
} from '../../src/testkit/providers/scenarios/sessionRuntime';
import { repoRootDir } from '../../src/testkit/paths';
import { createRunDirs } from '../../src/testkit/runDir';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { fetchAllMessages, fetchSessionV2, type SessionMessageRow } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

/**
 * QA-E-01 / QA-E-02 / QA-E-04 — the same-Session cross-Agent transition proven
 * end to end through a real server + daemon + CLI loop with FAKE Agents. No
 * stack, no Agent credentials, no paid traffic.
 *
 * The Agent pair is fake-Claude -> fake-Gemini(ACP) because both already run
 * under one daemon from one spawn environment. The deciding property is
 * Agent-agnostic: the same Session row keeps its identity while its runtime
 * Agent is replaced, exactly one divider is appended, and the submitted localId
 * is admitted exactly once.
 *
 * Strict stop-before-target-effect ORDERING is owned by the coordinator unit
 * test (`sessionAgentTransitionCoordinator.stop.test.ts`); this file proves the
 * composed outcome, including that the source runtime is gone afterwards.
 */

const run = createRunDirs({ runLabel: 'core' });

type ProviderEnvParams = Readonly<{
    daemonHomeDir: string;
    fakeBinDir: string;
    fakeClaudePath: string;
    fakeClaudeLogPath: string;
    fakeGeminiPath: string;
    fakeGeminiLogPath: string;
    serverBaseUrl: string;
}>;

function createProviderEnv(params: ProviderEnvParams): Record<string, string> {
    return {
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: params.daemonHomeDir,
        HAPPIER_SERVER_URL: params.serverBaseUrl,
        HAPPIER_WEBAPP_URL: params.serverBaseUrl,
        HAPPIER_CLAUDE_PATH: params.fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: params.fakeClaudeLogPath,
        HAPPIER_GEMINI_PATH: params.fakeGeminiPath,
        HAPPIER_E2E_GEMINI_LOG: params.fakeGeminiLogPath,
        GEMINI_API_KEY: 'e2e-fake-gemini-api-key',
        PATH: `${params.fakeBinDir}${delimiter}${process.env.PATH ?? ''}`,
    };
}

async function writeFakeGeminiAcpCli(params: Readonly<{
    fakeGeminiLogPath: string;
    fakeGeminiPath: string;
}>): Promise<void> {
    const { sdkEntry: acpSdkEntry, agentAppAdapterEntry } = resolveAcpSdkTestRuntime(repoRootDir());
    await writeFile(
        params.fakeGeminiPath,
        `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";
import { connectAcpTestAgentApp } from ${JSON.stringify(agentAppAdapterEntry)};

if (process.argv.includes("--help")) {
  process.stdout.write("fake gemini usage --acp\\n");
  process.exit(0);
}

function log(line) {
  const p = process.env.HAPPIER_E2E_GEMINI_LOG;
  if (p) appendFileSync(p, JSON.stringify({ ts: Date.now(), ...line }) + "\\n", "utf8");
}

function promptText(blocks) {
  return Array.isArray(blocks)
    ? blocks.map((b) => b && typeof b === "object" && b.type === "text" ? String(b.text || "") : "").join("\\n")
    : "";
}

const acp = await import(pathToFileURL(${JSON.stringify(acpSdkEntry)}).href);

class FakeGeminiAgent {
  connection;
  constructor(connection) { this.connection = connection; }

  async initialize(_params) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: "oauth-personal" }, { id: "gemini-api-key" }],
    };
  }

  async authenticate(_params) { return {}; }

  async newSession(_params) {
    const sessionId = randomUUID();
    log({ kind: "newSession", sessionId });
    return { sessionId };
  }

  async loadSession(params) {
    const sessionId = String(params?.sessionId || "");
    log({ kind: "loadSession", sessionId });
    return {};
  }

  async prompt(params) {
    const text = promptText(params.prompt);
    log({ kind: "prompt", text });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "FAKE_GEMINI_OK_" + Date.now() },
      },
    });
    log({ kind: "promptReturn", marker: "FAKE_GEMINI_OK", stopReason: "end_turn" });
    return { stopReason: "end_turn" };
  }

  async cancel(_params) {}
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = connectAcpTestAgentApp({ acp, stream, createAgent: (client) => new FakeGeminiAgent(client) });
await connection.closed;
`,
        'utf8',
    );
    await chmod(params.fakeGeminiPath, 0o755);
}

function decodeRow(row: SessionMessageRow, secret: Uint8Array): unknown {
    const ciphertext = (row as unknown as { content?: { c?: unknown } }).content?.c;
    if (typeof ciphertext !== 'string') return null;
    try {
        return decryptLegacyBase64(ciphertext, secret);
    } catch {
        return null;
    }
}

async function readJsonlEvents(path: string): Promise<Array<Record<string, unknown>>> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch {
        return [];
    }
    return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .flatMap((line) => {
            try {
                const parsed: unknown = JSON.parse(line);
                return parsed && typeof parsed === 'object' ? [parsed as Record<string, unknown>] : [];
            } catch {
                return [];
            }
        });
}

function readEventTimestamp(event: Record<string, unknown>): number {
    const ts = event.ts;
    return typeof ts === 'number' && Number.isFinite(ts) ? ts : 0;
}

describe('core e2e: same-Session cross-Agent transition', () => {
    let server: StartedServer | null = null;
    let daemon: StartedDaemon | null = null;
    let daemonHomeDir: string | null = null;
    let ui: ReturnType<typeof createUserScopedSocketCollector> | null = null;

    afterEach(async () => {
        ui?.close();
        ui = null;
        if (daemonHomeDir) {
            await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
            daemonHomeDir = null;
        }
        await daemon?.stop().catch(() => {});
        daemon = null;
        await server?.stop().catch(() => {});
        server = null;
    });

    it('keeps the Session, appends exactly one divider, and admits the exact localId once', async () => {
        const testDir = run.testDir(`agent-transition-${randomUUID()}`);
        server = await startServerLight({ testDir, dbProvider: 'sqlite' });
        const auth = await createTestAuth(server.baseUrl);
        const secret = auth.accountSigningSeed;

        daemonHomeDir = resolve(join(testDir, 'daemon-home'));
        const workspaceDir = resolve(join(testDir, 'workspace'));
        const fakeBinDir = resolve(join(testDir, 'fake-bin'));
        await mkdir(daemonHomeDir, { recursive: true });
        await mkdir(workspaceDir, { recursive: true });
        await mkdir(fakeBinDir, { recursive: true });
        await seedCliAuthForTestAccount({
            cliHome: daemonHomeDir,
            serverUrl: server.baseUrl,
            auth,
            mode: 'legacy',
        });

        const fakeClaudePath = fakeClaudeFixturePath();
        const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
        const fakeGeminiPath = resolve(join(fakeBinDir, 'gemini'));
        const fakeGeminiLogPath = resolve(join(testDir, 'fake-gemini.jsonl'));
        await writeFakeGeminiAcpCli({ fakeGeminiPath, fakeGeminiLogPath });

        const providerEnv = createProviderEnv({
            daemonHomeDir,
            fakeBinDir,
            fakeClaudePath,
            fakeClaudeLogPath,
            fakeGeminiPath,
            fakeGeminiLogPath,
            serverBaseUrl: server.baseUrl,
        });
        daemon = await startTestDaemon({
            testDir,
            happyHomeDir: daemonHomeDir,
            env: {
                ...process.env,
                ...providerEnv,
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            },
            snapshotDir: resolve(join(testDir, 'daemon-cli-snapshot')),
        });

        const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
            port: daemon.state.httpPort,
            path: '/spawn-session',
            controlToken: daemon.state.controlToken,
            body: {
                directory: workspaceDir,
                // Required by the current /spawn-session contract: the daemon threads this
                // into the child's env, the child stamps it on its session marker, and the
                // canonical-adoption check rejects the marker without it
                // (`session_marker_canonical_adoption_ownership_mismatch`).
                spawnNonce: randomUUID(),
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                terminal: { mode: 'plain' },
                environmentVariables: providerEnv,
            },
        });
        expect(spawnRes.status).toBe(200);
        expect(spawnRes.data.success).toBe(true);
        const sessionId = spawnRes.data.sessionId;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new Error('Missing sessionId from daemon spawn-session');
        }

        // Drive one real source turn so the transition starts from a Session with
        // history and a live provider runtime, not an empty shell.
        const sourceText = `AGENT_TRANSITION_SOURCE_${randomUUID()}`;
        await enqueueSessionPromptForScenario({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            secret,
            text: sourceText,
        });
        await waitForFakeClaudeInvocation(fakeClaudeLogPath, (invocation) => invocation.mode === 'sdk', {
            timeoutMs: 120_000,
        });
        await waitForAssistantMessageContaining({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            secret,
            requiredSubstring: 'FAKE_CLAUDE_OK_1',
            timeoutMs: 180_000,
        });
        await waitForSessionActive({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            timeoutMs: 60_000,
        });

        const beforeTransition = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
        const messagesBefore = await fetchAllMessages(server.baseUrl, auth.token, sessionId);

        const machineIds = await resolveMachineIdsFromSettings({
            settingsPath: resolve(join(daemonHomeDir, 'settings.json')),
            timeoutMs: 60_000,
        });
        expect(machineIds.length).toBeGreaterThan(0);
        const machineId = machineIds[0]!;

        ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
        ui.connect();

        const submittedLocalId = `transition-${randomUUID()}`;
        const transitionText = `AGENT_TRANSITION_TARGET_${randomUUID()}`;
        const result = await callEncryptedMachineRpc({
            ui,
            machineId,
            method: RPC_METHODS.SESSION_AGENT_TRANSITION,
            req: {
                v: 1,
                sessionId,
                expectedCurrentAgentId: 'claude',
                selection: { v: 1, agentId: 'gemini' },
                input: { text: transitionText, localId: submittedLocalId, meta: {} },
            },
            secret,
            schema: SessionAgentTransitionResultV1Schema,
            timeoutMs: 300_000,
        });

        expect(result).toEqual({ type: 'accepted', localId: submittedLocalId });

        // REQ-PRODUCT-01: the Session row itself is untouched.
        const afterTransition = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
        expect(afterTransition.id).toBe(sessionId);
        expect(afterTransition.createdAt).toBe(beforeTransition.createdAt);

        // `flavor` is the declared current-Agent identity written by
        // `projectCurrentAgentSessionView`, and the transition replaces exactly it.
        //
        // Deliberately NOT `JSON.stringify(metadata).toContain('gemini')`. That form
        // asserts only that the document mentions the target Agent SOMEWHERE, and the
        // same projection also writes `runtimeDescriptorV1.agentId`. A cutover that
        // landed the descriptor but not the declared identity therefore satisfies it
        // while the Session still declares `claude` — checked against the real
        // projector, which is why this asserts the key the transition owns.
        const metadataAfter = decryptLegacyBase64(afterTransition.metadata, secret) as Record<string, unknown>;
        expect(metadataAfter.flavor).toBe('gemini');

        // Exactly one divider, at the deterministic reserved local ID, carrying the sidecar.
        const messagesAfter = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
        const dividerLocalId = buildSessionAgentTransitionDividerLocalId(submittedLocalId);
        const dividers = messagesAfter.filter((row) => isSessionAgentTransitionDividerLocalId(row.localId));
        expect(dividers).toHaveLength(1);
        const divider = dividers[0]!;
        expect(divider.localId).toBe(dividerLocalId);
        // Read through the protocol's canonical stored-record reader — the same
        // function the server's cutover owner and the daemon's divider-evidence
        // path use — rather than re-deriving the `role:'agent'` / `content.type:'event'`
        // wrapper checks here, where the copy could silently drift from the real one.
        const dividerSidecar = readSessionAgentTransitionDividerFromStoredRecordV1({
          localId: divider.localId,
          record: decodeRow(divider, secret),
        });
        expect(dividerSidecar).toEqual({
            v: 1,
            fromAgentId: 'claude',
            toAgentId: 'gemini',
            // The departure seq is part of the sidecar, not an optional extra: it is the
            // ONE input that survives the transition, and the bounded away-delta a
            // returning Agent is seeded with is derived from it. Asserting the payload
            // without it let a divider that had LOST the bound pass this gate.
            sourceCutoffSeqInclusive: expect.any(Number),
        });
        // …and it is the real head of the source, not the `?? 0` fallback: it covers
        // everything the departing Agent saw, and stops below the divider itself so
        // the divider is not inside its own bound.
        expect(dividerSidecar?.sourceCutoffSeqInclusive)
            .toBeGreaterThanOrEqual(Math.max(...messagesBefore.map((row) => row.seq)));
        expect(dividerSidecar?.sourceCutoffSeqInclusive).toBeLessThan(divider.seq);

        // QA-E-04 is deliberately NOT asserted here: by the time this RPC returns
        // `accepted` the user's own message has been admitted, and a user message
        // legitimately moves the activity watermark. The divider's own zero effect
        // is proven precisely where it is isolatable — the server integration spec
        // `applySessionAgentTransitionCutover.sqlite.integration.spec.ts` and the
        // client-side unread/activity fold in
        // `apps/ui/sources/sync/domains/messages/messageUserAttention.test.ts`.

        // Source history is preserved, not rewritten.
        for (const before of messagesBefore) {
            expect(messagesAfter.some((row) => row.seq === before.seq)).toBe(true);
        }

        // The target Agent actually runs the admitted input in the SAME Session.
        await waitForAssistantMessageContaining({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            secret,
            requiredSubstring: 'FAKE_GEMINI_OK_',
            afterSeqStart: divider.seq,
            timeoutMs: 180_000,
        });

        // ---- What the TARGET actually received, and when.
        //
        // A composed run that only checks the target's reply is insufficient: `C3` was a
        // real shipped defect in which dev activated the target with ZERO context, and a
        // reply proves only that something ran. These assertions read the target Agent's
        // own recorded prompts and the two logs' timestamps.

        const targetEvents = await readJsonlEvents(fakeGeminiLogPath);
        const targetPrompts = targetEvents.filter((event) => event.kind === 'prompt');
        expect(targetPrompts.length).toBeGreaterThan(0);
        const targetPromptText = targetPrompts
            .map((event) => (typeof event.text === 'string' ? event.text : ''))
            .join('\n');

        // REQ-INPUT-01 reaches the Agent, not just the Session row: the exact admitted
        // text is what the target was actually prompted with.
        expect(targetPromptText).toContain(transitionText);

        // `C3` regression guard. The target must be able to see the turn the source Agent
        // already ran in this same Session. BOTH halves are required: the coordinator asks
        // the Replay owner with `strategy: 'recent_messages'`, so the brief is the
        // transcript tail rather than a summary, and both roles are rendered into it.
        //
        // Deliberately NOT asserted by length. The ACP prompt always carries the Happier
        // system preamble, so `length > transitionText.length` holds even for a target
        // that received ZERO context — measured, not assumed: under a seed-removal break
        // the observed zero-context prompt was 2 199 chars against 2 711 for the seeded
        // one, so the length comparison passed while these `toContain`s failed.
        expect(targetPromptText).toContain(sourceText);
        expect(targetPromptText).toContain('FAKE_CLAUDE_OK_1');

        // The context is a PREFIX seed, not a trailing artifact: `buildProviderPromptWithReplaySeed`
        // composes `${seedText}\n\n${userText}`, so the source history has to reach the
        // Agent before the input it is context for. (`indexOf` alone would accept an
        // absent seed as -1; the two assertions above already exclude that.)
        expect(targetPromptText.indexOf(sourceText)).toBeLessThan(targetPromptText.indexOf(transitionText));

        // Ordering: the source Agent is finished before the target produces its first
        // effect. §7.2/§7.4 confirm the stop before cutover and activate only after it,
        // so no source activity may be recorded at or after the target's first prompt.
        // (The strict per-step call order is owned by the coordinator unit test; this is
        // the composed, cross-process form of the same invariant.)
        const sourceTimestamps = (await readJsonlEvents(fakeClaudeLogPath))
            .map(readEventTimestamp)
            .filter((value) => value > 0);
        const targetPromptTimestamps = targetPrompts
            .map(readEventTimestamp)
            .filter((value) => value > 0);
        expect(sourceTimestamps.length).toBeGreaterThan(0);
        expect(targetPromptTimestamps.length).toBeGreaterThan(0);
        expect(Math.max(...sourceTimestamps)).toBeLessThan(Math.min(...targetPromptTimestamps));

        // The same ordering has to hold in the durable transcript the user reads: the
        // divider precedes the target's first output.
        const messagesFinal = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
        const targetReplyRow = messagesFinal.find(
            (row) => JSON.stringify(decodeRow(row, secret) ?? '').includes('FAKE_GEMINI_OK_'),
        );
        expect(targetReplyRow).toBeDefined();
        expect(targetReplyRow!.seq).toBeGreaterThan(divider.seq);

        // Still EXACTLY one divider once the target has spoken. The count above is
        // read before activation, so on its own it cannot see a second divider
        // appended by the activation or reconcile path — the same right-claim,
        // wrong-moment shape as the admission assertion below.
        expect(messagesFinal.filter((row) => isSessionAgentTransitionDividerLocalId(row.localId))).toHaveLength(1);

        // REQ-INPUT-01: the exact submitted localId is admitted once, not duplicated.
        //
        // Asserted HERE, not at `accepted`. That arm claims canonical PENDING-QUEUE
        // admission and nothing more — `admitExactInput` calls `sendSessionMessage`
        // with `wait: false`, which enqueues into pending v2; the transcript row only
        // appears once the target drains the queue. Asserted at the RPC boundary this
        // reads an empty transcript. The target has replied by this point, so the row
        // is durable, and it has to land after the boundary the divider drew.
        const admitted = messagesFinal.filter((row) => row.localId === submittedLocalId);
        expect(admitted).toHaveLength(1);
        expect(admitted[0]!.seq).toBeGreaterThan(divider.seq);

        // The source runtime is gone: the daemon tracks only the target child now.
        await waitFor(async () => {
            const list = await daemonControlPostJson<{ children?: Array<{ happySessionId?: string }> }>({
                port: daemon!.state.httpPort,
                path: '/list',
                controlToken: daemon!.state.controlToken,
            });
            const children = list.data.children ?? [];
            return children.filter((child) => child.happySessionId === sessionId).length <= 1;
        }, { timeoutMs: 60_000, context: 'exactly one tracked runtime for the transitioned Session' });
    }, 600_000);
});
