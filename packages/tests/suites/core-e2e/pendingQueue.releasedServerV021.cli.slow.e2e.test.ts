import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import {
  countFakeClaudeEventsAfterCurrentRunSentinel,
  fakeClaudeFixturePath,
  waitForFakeClaudeInvocation,
  waitForFakeClaudeUserText,
} from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { repoRootDir } from '../../src/testkit/paths';
import { ensureCliSharedDepsBuilt } from '../../src/testkit/process/cliDist';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import {
  resolveReleasedServerV021ArtifactPrerequisite,
  startReleasedServerLight,
  type StartedReleasedServerLight,
} from '../../src/testkit/process/releasedServerLight';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSessionWithCiphertexts, fetchAllMessages } from '../../src/testkit/sessions';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const releasedServerArtifact = resolveReleasedServerV021ArtifactPrerequisite({
  defaultArtifactDir: join(repoRootDir(), '.project/tmp/c1-server-v0.2.1'),
});

function encryptedUserMessage(params: Readonly<{
  localId: string;
  text: string;
  secret: Uint8Array;
}>): string {
  return encryptLegacyBase64({
    role: 'user',
    content: { type: 'text', text: params.text },
    localId: params.localId,
    meta: { source: 'ui', sentFrom: 'e2e' },
  }, params.secret);
}

async function postEncryptedTranscriptMessage(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  localId: string;
  ciphertext: string;
}>): Promise<void> {
  const response = await fetchJson<{ didWrite?: boolean }>(
    `${params.baseUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ localId: params.localId, ciphertext: params.ciphertext }),
      timeoutMs: 20_000,
    },
  );
  expect(response.status).toBe(200);
  expect(response.data?.didWrite).toBe(true);
}

function requestUrlsFromServerLog(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line) as { req?: { url?: unknown } };
        return typeof record.req?.url === 'string' ? [record.req.url] : [];
      } catch {
        return [];
      }
    });
}

const describeReleasedServer = releasedServerArtifact.status === 'ready' ? describe : describe.skip;
const releasedServerSuiteName = releasedServerArtifact.status === 'ready'
  ? 'core e2e: current CLI against immutable server-v0.2.1'
  : `core e2e: current CLI against immutable server-v0.2.1 [skipped: ${releasedServerArtifact.reason}]`;

describeReleasedServer(releasedServerSuiteName, () => {
  let server: StartedReleasedServerLight | null = null;
  let cli: SpawnedProcess | null = null;
  let daemon: StartedDaemon | null = null;
  let cliHome: string | null = null;

  afterEach(async () => {
    await cli?.stop().catch(() => {});
    cli = null;
    await daemon?.stop().catch(() => {});
    daemon = null;
    cliHome = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  it('continues only a didWrite:true exact lookup to one provider handoff and keeps didWrite:false at zero effect', async () => {
    if (releasedServerArtifact.status !== 'ready') throw new Error(releasedServerArtifact.reason);
    const testDir = run.testDir('pending-queue-released-server-v0-2-1-cli');
    server = await startReleasedServerLight({
      testDir,
      archivePath: releasedServerArtifact.archivePath,
      manifestPath: releasedServerArtifact.manifestPath,
      expectedArchiveSha256: releasedServerArtifact.expectedArchiveSha256,
    });
    const auth = await createTestAuth(server.baseUrl);

    cliHome = resolve(testDir, 'cli-home');
    const workspaceDir = resolve(testDir, 'workspace');
    const fakeClaudeLogPath = resolve(testDir, 'fake-claude.jsonl');
    await Promise.all([
      mkdir(cliHome, { recursive: true }),
      mkdir(workspaceDir, { recursive: true }),
    ]);

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({
      cliHome,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret,
    });
    const metadataCiphertextBase64 = encryptLegacyBase64({
      path: workspaceDir,
      host: 'e2e',
      name: 'released-server-v0-2-1-current-cli',
      createdAt: Date.now(),
    }, secret);
    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-released-server-v0-2-1-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });
    const attachFile = await writeCliSessionAttachFile({
      cliHome,
      sessionId,
      secret,
      encryptionVariant: 'legacy',
    });

    const collidingLocalId = randomUUID();
    const collidingPendingText = `MUST_NOT_REACH_PROVIDER_PENDING_${randomUUID()}`;
    const collidingTranscriptText = `MUST_NOT_REACH_PROVIDER_TRANSCRIPT_${randomUUID()}`;
    const collidingEnqueue = await enqueuePendingQueueV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      localId: collidingLocalId,
      ciphertext: encryptedUserMessage({ localId: collidingLocalId, text: collidingPendingText, secret }),
    });
    expect(collidingEnqueue.status).toBe(200);
    await postEncryptedTranscriptMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      localId: collidingLocalId,
      ciphertext: encryptedUserMessage({ localId: collidingLocalId, text: collidingTranscriptText, secret }),
    });

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: cliHome,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_SESSION_ATTACH_FILE: attachFile,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };
    await ensureCliSharedDepsBuilt({ testDir, env: cliEnv });
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: cliHome,
      env: cliEnv,
    });
    const cliLaunchSpec = await resolveCliTestLaunchSpec(
      { testDir, env: cliEnv },
      { snapshotDir: resolve(testDir, 'cli-source'), preferSourceEntrypoint: true },
    );
    const providerObservationStartedAt = Date.now();
    cli = spawnLoggedProcess({
      command: cliLaunchSpec.command,
      args: [
        ...cliLaunchSpec.args,
        'claude',
        '--existing-session',
        sessionId,
        '--started-by',
        'terminal',
        '--happy-starting-mode',
        'remote',
      ],
      cwd: repoRootDir(),
      env: {
        ...cliEnv,
        ...(cliLaunchSpec.env ?? {}),
      },
      stdoutPath: resolve(testDir, 'cli.stdout.log'),
      stderrPath: resolve(testDir, 'cli.stderr.log'),
      cleanup: cliLaunchSpec.cleanup,
    });

    await waitForFakeClaudeInvocation(fakeClaudeLogPath, () => true, { timeoutMs: 90_000 });
    await waitFor(async () => {
      const pending = await listPendingQueueV2({
        baseUrl: server!.baseUrl,
        token: auth.token,
        sessionId,
      });
      return pending.status === 200 && pending.data.pending?.length === 0;
    }, {
      timeoutMs: 90_000,
      context: 'released server didWrite:false collision is removed',
    });

    const providerInputsAfterDidWriteFalse = await countFakeClaudeEventsAfterCurrentRunSentinel({
      logPath: fakeClaudeLogPath,
      sinceMs: providerObservationStartedAt,
      sentinelPredicate: (event) => event.type === 'invocation',
      predicate: (event) => event.type === 'sdk_stdin' && event.hasUserText === true,
    });
    expect(providerInputsAfterDidWriteFalse).toBe(0);

    const positiveLocalId = randomUUID();
    const positiveText = `RELEASED_SERVER_EXACT_LOOKUP_${positiveLocalId}`;
    const positiveEnqueue = await enqueuePendingQueueV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      localId: positiveLocalId,
      ciphertext: encryptedUserMessage({ localId: positiveLocalId, text: positiveText, secret }),
    });
    expect(positiveEnqueue.status).toBe(200);

    await waitForFakeClaudeUserText(
      fakeClaudeLogPath,
      (text) => text.includes(positiveText),
      { timeoutMs: 90_000, pollMs: 100 },
    );
    await waitFor(async () => {
      const messages = await fetchAllMessages(server!.baseUrl, auth.token, sessionId);
      return messages.some((message) => {
        const decoded = decryptLegacyBase64(message.content.c, secret);
        return JSON.stringify(decoded).includes('FAKE_CLAUDE');
      });
    }, {
      timeoutMs: 90_000,
      context: 'current CLI output is visible through the released mutation encoding',
    });

    const messages = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
    const positiveRows = messages.filter((message) => message.localId === positiveLocalId);
    expect(positiveRows).toHaveLength(1);
    expect(decryptLegacyBase64(positiveRows[0]!.content.c, secret)).toMatchObject({
      role: 'user',
      content: { type: 'text', text: positiveText },
      localId: positiveLocalId,
    });
    const pendingAfterPositive = await listPendingQueueV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
    });
    expect(pendingAfterPositive.status).toBe(200);
    expect(pendingAfterPositive.data.pending).toEqual([]);

    const providerInputsAfterPositive = await countFakeClaudeEventsAfterCurrentRunSentinel({
      logPath: fakeClaudeLogPath,
      sinceMs: providerObservationStartedAt,
      sentinelPredicate: (event) => event.type === 'invocation',
      predicate: (event) => event.type === 'sdk_stdin' && event.hasUserText === true,
    });
    expect(providerInputsAfterPositive).toBe(1);
    const fakeClaudeRaw = await readFile(fakeClaudeLogPath, 'utf8');
    expect(fakeClaudeRaw).not.toContain(collidingPendingText);
    expect(fakeClaudeRaw).not.toContain(collidingTranscriptText);

    const releasedServerLog = await readFile(
      resolve(testDir, 'released-server-v0.2.1.stdout.log'),
      'utf8',
    );
    const exactLookupUrls = requestUrlsFromServerLog(releasedServerLog);
    const positiveLookupUrl = `/v2/sessions/${sessionId}/messages/by-local-id/${positiveLocalId}`;
    const collidingLookupUrl = `/v2/sessions/${sessionId}/messages/by-local-id/${collidingLocalId}`;
    expect(exactLookupUrls.filter((url) => url === positiveLookupUrl)).toHaveLength(1);
    expect(exactLookupUrls.filter((url) => url === collidingLookupUrl)).toHaveLength(0);
  }, 720_000);
});
