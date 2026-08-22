import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import {
  replaceTestDaemonWithoutStoppingSessions,
  startTestDaemon,
  stopDaemonFromHomeDir,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import {
  assertPidAlive,
  readFakeClaudeRuntimeContinuityEvidence,
  readFakeClaudeSessionId,
  releaseFakeClaudeRuntimeContinuityTurn,
  waitForFakeClaudeRuntimeContinuityEffect,
} from '../../src/testkit/providers/fakeClaudeContinuity';
import {
  enqueueSessionPromptForScenario,
  waitForAssistantMessageContaining,
} from '../../src/testkit/providers/scenarios/sessionRuntime';
import {
  capabilityFingerprint,
  probeTurnContributionsAuthority,
  readTrackedRunnerPid,
  waitForRunnerDaemonServiceAuthority,
} from '../../src/testkit/providers/harness/daemonRunnerContinuity';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { sleep, waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: runner-owned Agent runtime survives daemon A to B to C', () => {
  let server: StartedServer | null = null;
  let daemonA: StartedDaemon | null = null;
  let replacementDaemons: StartedDaemon[] = [];
  let daemonHomeDir: string | null = null;

  afterEach(async () => {
    const cleanupErrors: Error[] = [];
    const cleanup = async (action: () => void | Promise<void>) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const currentReplacement = replacementDaemons.at(-1) ?? null;
    if (currentReplacement) await cleanup(() => currentReplacement.stop());
    for (const retiredReplacement of replacementDaemons.slice(0, -1).reverse()) {
      await cleanup(() => retiredReplacement.proc.stop());
    }
    replacementDaemons = [];
    if (daemonA) {
      await cleanup(() => currentReplacement ? daemonA!.proc.stop() : daemonA!.stop());
    }
    daemonA = null;
    if (daemonHomeDir) await cleanup(() => stopDaemonFromHomeDir(daemonHomeDir!));
    daemonHomeDir = null;
    if (server) await cleanup(() => server!.stop());
    server = null;
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'Daemon continuity teardown failed');
    }
  });

  afterAll(async () => {
    if (daemonHomeDir) {
      await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
    }
    await daemonA?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  it('keeps one runner/runtime/provider child, admits a gap prompt once, and never replays an active provider effect', async () => {
    const testDir = run.testDir(`runner-runtime-continuity-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    const releaseFilePath = resolve(join(testDir, 'release-active-turn'));
    await Promise.all([
      mkdir(daemonHomeDir, { recursive: true }),
      mkdir(workspaceDir, { recursive: true }),
      rm(releaseFilePath, { force: true }),
    ]);

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'legacy',
    });

    const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
      HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
      HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'daemon-runtime-continuity',
      HAPPIER_E2E_FAKE_CLAUDE_RUNTIME_CONTINUITY_RELEASE_FILE: releaseFilePath,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    };

    daemonA = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      cleanupDescendantsOnExit: false,
    });

    const spawn = await daemonControlPostJson<{
      success?: boolean;
      sessionId?: string;
    }>({
      port: daemonA.state.httpPort,
      path: '/spawn-session',
      controlToken: daemonA.state.controlToken,
      body: {
        directory: workspaceDir,
        spawnNonce: `daemon-runtime-continuity:${randomUUID()}`,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        terminal: { mode: 'plain' },
        environmentVariables: daemonEnv,
      },
      timeoutMs: 90_000,
    });
    expect(spawn.status, JSON.stringify(spawn.data)).toBe(200);
    expect(spawn.data.success).toBe(true);
    const sessionId = spawn.data.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing sessionId from daemon spawn-session');
    }

    const baselinePrompt = `DAEMON_RUNTIME_CONTINUITY_BASELINE_${randomUUID()}`;
    await enqueueSessionPromptForScenario({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: baselinePrompt,
    });
    const providerInvocation = await waitForFakeClaudeInvocation(
      fakeLogPath,
      (invocation) => invocation.mode === 'sdk',
      { timeoutMs: 60_000 },
    );
    await waitForAssistantMessageContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      requiredSubstring: 'FAKE_CLAUDE_OK_1',
      timeoutMs: 120_000,
    });
    if (typeof providerInvocation.pid !== 'number') {
      throw new Error('Fake Claude did not record its provider child PID');
    }
    const providerPid = providerInvocation.pid;
    const runnerPid = await readTrackedRunnerPid({
      daemon: daemonA.state,
      sessionId,
    });
    const authorityA = await waitForRunnerDaemonServiceAuthority({
      happyHomeDir: daemonHomeDir,
      sessionId,
    });
    const providerSessionId = await readFakeClaudeSessionId({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
    });
    expect(providerSessionId).toEqual(expect.any(String));
    expect(authorityA.sessionId).toBe(sessionId);
    expect(authorityA.runner.pid).toBe(runnerPid);
    expect(authorityA.httpPort).toBe(daemonA.state.httpPort);
    await expect(
      probeTurnContributionsAuthority(authorityA),
    ).resolves.toMatchObject({
      status: 200,
      ok: true,
      resultKind: 'turn_contributions',
      resultStatus: 'resolved',
    });
    assertPidAlive(runnerPid);
    assertPidAlive(providerPid);
    expect(await readFakeClaudeRuntimeContinuityEvidence(fakeLogPath)).toMatchObject({
      sdkInvocationCount: 1,
      sdkProviderPids: [providerPid],
    });

    const authorityGapPrompt = `DAEMON_RUNTIME_CONTINUITY_GAP_${randomUUID()}`;
    const daemonB = await replaceTestDaemonWithoutStoppingSessions({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      originalDaemon: daemonA,
      stdoutPath: resolve(testDir, 'daemon-b.stdout.log'),
      stderrPath: resolve(testDir, 'daemon-b.stderr.log'),
      afterOriginalDaemonExit: async () => {
        await expect(
          probeTurnContributionsAuthority(authorityA),
        ).resolves.toMatchObject({
          status: 'connection_failed',
          ok: null,
        });
        await enqueueSessionPromptForScenario({
          baseUrl: server!.baseUrl,
          token: auth.token,
          sessionId,
          secret,
          text: authorityGapPrompt,
        });
        await sleep(750);
        const gapEvidence = await readFakeClaudeRuntimeContinuityEvidence(fakeLogPath);
        expect(
          gapEvidence.userPromptPreviews.filter((text) => text.includes(authorityGapPrompt)),
        ).toHaveLength(0);
      },
    });
    replacementDaemons.push(daemonB);
    expect(daemonB.state.pid).not.toBe(daemonA.state.pid);
    expect(await readTrackedRunnerPid({ daemon: daemonB.state, sessionId })).toBe(runnerPid);
    const authorityB = await waitForRunnerDaemonServiceAuthority({
      happyHomeDir: daemonHomeDir,
      sessionId,
    });
    expect(authorityB.path).toBe(authorityA.path);
    expect(authorityB.sessionId).toBe(sessionId);
    expect(authorityB.runner).toEqual(authorityA.runner);
    expect(authorityB.pluginHardRevocationRevision).toBe(
      authorityA.pluginHardRevocationRevision,
    );
    expect(authorityB.retainedAgent).toEqual(authorityA.retainedAgent);
    expect(authorityB.httpPort).toBe(daemonB.state.httpPort);
    expect(capabilityFingerprint(authorityB.capability)).not.toBe(
      capabilityFingerprint(authorityA.capability),
    );
    await expect(
      probeTurnContributionsAuthority({
        ...authorityA,
        httpPort: authorityB.httpPort,
      }),
    ).resolves.toMatchObject({
      status: 403,
      ok: false,
      errorCode: 'agent_runtime_daemon_service_forbidden',
    });
    await expect(
      probeTurnContributionsAuthority(authorityB),
    ).resolves.toMatchObject({
      status: 200,
      ok: true,
      resultKind: 'turn_contributions',
      resultStatus: 'resolved',
    });
    assertPidAlive(runnerPid);
    assertPidAlive(providerPid);

    await waitForAssistantMessageContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      requiredSubstring: 'FAKE_CLAUDE_OK_2',
      timeoutMs: 120_000,
    });
    await waitFor(async () => {
      const evidence = await readFakeClaudeRuntimeContinuityEvidence(fakeLogPath);
      expect(
        evidence.userPromptPreviews.filter((text) => text.includes(authorityGapPrompt)),
      ).toHaveLength(1);
      return true;
    }, {
      timeoutMs: 30_000,
      context: 'authority-gap prompt reaches provider exactly once after daemon B',
    });

    const activePrompt = `DAEMON_RUNTIME_CONTINUITY_HOLD_${randomUUID()}`;
    await enqueueSessionPromptForScenario({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: activePrompt,
    });
    const activeEffect = await waitForFakeClaudeRuntimeContinuityEffect({
      logPath: fakeLogPath,
      promptMarker: activePrompt,
      timeoutMs: 60_000,
    });
    expect(activeEffect).toMatchObject({
      pid: providerPid,
      turn: 3,
    });

    const daemonC = await replaceTestDaemonWithoutStoppingSessions({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      stdoutPath: resolve(testDir, 'daemon-c.stdout.log'),
      stderrPath: resolve(testDir, 'daemon-c.stderr.log'),
    });
    replacementDaemons.push(daemonC);
    await daemonB.proc.stop();
    expect(daemonC.state.pid).not.toBe(daemonB.state.pid);
    expect(await readTrackedRunnerPid({ daemon: daemonC.state, sessionId })).toBe(runnerPid);
    const authorityC = await waitForRunnerDaemonServiceAuthority({
      happyHomeDir: daemonHomeDir,
      sessionId,
    });
    expect(authorityC.path).toBe(authorityA.path);
    expect(authorityC.sessionId).toBe(sessionId);
    expect(authorityC.runner).toEqual(authorityA.runner);
    expect(authorityC.pluginHardRevocationRevision).toBe(
      authorityA.pluginHardRevocationRevision,
    );
    expect(authorityC.retainedAgent).toEqual(authorityA.retainedAgent);
    expect(authorityC.httpPort).toBe(daemonC.state.httpPort);
    expect(capabilityFingerprint(authorityC.capability)).not.toBe(
      capabilityFingerprint(authorityA.capability),
    );
    expect(capabilityFingerprint(authorityC.capability)).not.toBe(
      capabilityFingerprint(authorityB.capability),
    );
    await expect(
      probeTurnContributionsAuthority({
        ...authorityB,
        httpPort: authorityC.httpPort,
      }),
    ).resolves.toMatchObject({
      status: 403,
      ok: false,
      errorCode: 'agent_runtime_daemon_service_forbidden',
    });
    await expect(
      probeTurnContributionsAuthority(authorityC),
    ).resolves.toMatchObject({
      status: 200,
      ok: true,
      resultKind: 'turn_contributions',
      resultStatus: 'resolved',
    });
    assertPidAlive(runnerPid);
    assertPidAlive(providerPid);

    const heldEvidence = await readFakeClaudeRuntimeContinuityEvidence(fakeLogPath);
    expect(heldEvidence.sdkInvocationCount).toBe(1);
    expect(heldEvidence.sdkProviderPids).toEqual([providerPid]);
    expect(
      heldEvidence.providerEffectEntries.filter(
        (entry) => entry.userTextPreview.includes(activePrompt),
      ),
    ).toHaveLength(1);
    expect(
      heldEvidence.userPromptPreviews.filter((text) => text.includes(activePrompt)),
    ).toHaveLength(1);

    await releaseFakeClaudeRuntimeContinuityTurn(releaseFilePath);
    await waitForAssistantMessageContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      requiredSubstring: 'FAKE_CLAUDE_OK_3',
      timeoutMs: 120_000,
    });

    await waitFor(async () => {
      const finalEvidence = await readFakeClaudeRuntimeContinuityEvidence(fakeLogPath);
      expect(finalEvidence.sdkInvocationCount).toBe(1);
      expect(finalEvidence.sdkProviderPids).toEqual([providerPid]);
      expect(
        finalEvidence.providerEffectEntries.filter(
          (entry) => entry.userTextPreview.includes(activePrompt),
        ),
      ).toHaveLength(1);
      expect(
        finalEvidence.userPromptPreviews.filter((text) => text.includes(activePrompt)),
      ).toHaveLength(1);
      expect(await readFakeClaudeSessionId({
        baseUrl: server!.baseUrl,
        token: auth.token,
        sessionId,
        secret,
      })).toBe(providerSessionId);
      return true;
    }, {
      timeoutMs: 30_000,
      context: 'final A to B to C runner/runtime/provider continuity evidence',
    });
  }, 360_000);
});
