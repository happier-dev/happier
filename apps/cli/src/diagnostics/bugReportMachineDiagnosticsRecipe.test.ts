import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('bug report selected diagnostics', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'happier-bug-report-selection-'));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    vi.stubEnv('HAPPIER_STACK_STACK', 'selection-test');
    vi.stubEnv('HAPPIER_STACK_ENV_FILE', join(directory, 'stack.env'));
    vi.resetModules();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('collects only structured context when every log kind is excluded', async () => {
    await mkdir(join(directory, 'logs'));
    await writeFile(join(directory, 'logs', 'runner.log'), 'private runner content');
    await writeFile(join(directory, 'stack.runtime.json'), JSON.stringify({ secretBody: 'private runtime content' }));
    const { collectBugReportMachineDiagnosticsSnapshotForBugReport } = await import('./bugReportMachineDiagnosticsRecipe');
    const result = await collectBugReportMachineDiagnosticsSnapshotForBugReport({
      logSelection: { daemon: false, session: false, provider: false },
    });
    expect(result.doctorSnapshot).toBeNull();
    expect(result.stackContext).toBeNull();
    expect(result.daemonLogs).toEqual([]);
    expect(result.sessionDiagnostics?.logs).toEqual([
      { kind: 'daemon', status: 'disabled' },
      { kind: 'session', status: 'disabled' },
      { kind: 'provider', status: 'disabled' },
    ]);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('includes the local daemon log by default without choosing a session runner', async () => {
    const { configuration } = await import('@/configuration');
    const { writeDaemonState } = await import('@/persistence');
    const { collectBugReportMachineDiagnosticsSnapshotForBugReport } = await import('./bugReportMachineDiagnosticsRecipe');
    await mkdir(configuration.logsDir, { recursive: true });
    const daemonLogPath = join(configuration.logsDir, 'selected-daemon.log');
    await writeFile(daemonLogPath, 'daemon diagnostic content');
    await writeFile(join(configuration.logsDir, 'newest-runner.log'), 'unrelated runner content');
    writeDaemonState({ pid: process.pid, httpPort: 12345, startedAt: 1, startedWithCliVersion: 'test', daemonLogPath, controlToken: 'private-control-token' });
    const result = await collectBugReportMachineDiagnosticsSnapshotForBugReport({ logSelection: {} });
    expect(result.sessionDiagnostics?.logs.find((entry) => entry.kind === 'daemon')?.artifact?.content).toBe('daemon diagnostic content');
    expect(result.sessionDiagnostics?.logs.find((entry) => entry.kind === 'session')?.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('unrelated runner content');
    expect(JSON.stringify(result)).not.toContain('private-control-token');
  });

  it('uses the exact local session and includes its provider transcript only with opt in', async () => {
    vi.stubEnv('CODEX_HOME', join(directory, 'codex'));
    const { configuration } = await import('@/configuration');
    const { writeSessionMarker } = await import('@/daemon/sessionRegistry');
    const { collectBugReportMachineDiagnosticsSnapshotForBugReport } = await import('./bugReportMachineDiagnosticsRecipe');
    await mkdir(configuration.logsDir, { recursive: true });
    const logPath = join(configuration.logsDir, 'selected.log');
    await writeFile(logPath, 'selected Happier session content');
    await writeFile(join(configuration.logsDir, 'newest.log'), 'unrelated content');
    const rolloutDirectory = join(directory, 'codex', 'sessions', '2026', '10', '30');
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(join(rolloutDirectory, 'rollout-2026-10-30T10-00-00-selected-native.jsonl'), 'provider conversation content');
    await writeSessionMarker({ pid: 12345, happySessionId: 'selected-session', metadata: {
      flavor: 'codex', sessionLogPath: logPath, codexSessionId: 'selected-native', summary: { text: 'private summary' },
    } });
    const defaults = await collectBugReportMachineDiagnosticsSnapshotForBugReport({ sessionId: 'selected-session' });
    expect(defaults.sessionDiagnostics?.logs.find((entry) => entry.kind === 'session')?.artifact?.content).toBe('selected Happier session content');
    expect(defaults.sessionDiagnostics?.logs.find((entry) => entry.kind === 'provider')?.status).toBe('disabled');
    expect(JSON.stringify(defaults)).not.toContain('private summary');
    expect(JSON.stringify(defaults)).not.toContain('unrelated content');
    const optedIn = await collectBugReportMachineDiagnosticsSnapshotForBugReport({
      sessionId: 'selected-session', logSelection: { provider: true, daemon: false, session: false },
    });
    expect(optedIn.sessionDiagnostics?.logs.find((entry) => entry.kind === 'provider')?.artifact?.content).toBe('provider conversation content');
    const missing = await collectBugReportMachineDiagnosticsSnapshotForBugReport({ sessionId: 'missing-session' });
    expect(missing.sessionDiagnostics?.logs.filter((entry) => entry.status === 'collected')).toEqual([]);
  });

  it('refuses a metadata path or symlink escaping the owned Happier log directory', async () => {
    const { configuration } = await import('@/configuration');
    const { writeSessionMarker } = await import('@/daemon/sessionRegistry');
    const { collectBugReportMachineDiagnosticsSnapshotForBugReport } = await import('./bugReportMachineDiagnosticsRecipe');
    await mkdir(configuration.logsDir, { recursive: true });
    const outside = join(directory, 'outside.log');
    await writeFile(outside, 'outside content');
    const linked = join(configuration.logsDir, 'linked.log');
    await symlink(outside, linked);
    for (const sessionLogPath of [outside, linked]) {
      await writeSessionMarker({ pid: 12345, happySessionId: 'selected-session', metadata: { sessionLogPath } });
      const result = await collectBugReportMachineDiagnosticsSnapshotForBugReport({ sessionId: 'selected-session', logSelection: { daemon: false } });
      expect(result.sessionDiagnostics?.logs.find((entry) => entry.kind === 'session')?.status).toBe('unavailable');
      expect(JSON.stringify(result)).not.toContain('outside content');
    }
  });

  it('resolves Claude transcripts through the provider hook and refuses paths outside its configured projects', async () => {
    const claudeConfig = join(directory, 'claude');
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfig);
    const { writeSessionMarker } = await import('@/daemon/sessionRegistry');
    const { collectBugReportMachineDiagnosticsSnapshotForBugReport } = await import('./bugReportMachineDiagnosticsRecipe');
    const project = join(claudeConfig, 'projects', 'workspace');
    await mkdir(project, { recursive: true });
    const transcript = join(project, 'claude-thread.jsonl');
    await writeFile(transcript, 'Claude conversation body');
    await writeSessionMarker({ pid: 12345, happySessionId: 'claude-session', metadata: {
      flavor: 'claude', claudeSessionId: 'claude-thread', claudeTranscriptPath: transcript,
    } });
    const selection = { daemon: false, session: false, provider: true };
    const result = await collectBugReportMachineDiagnosticsSnapshotForBugReport({ sessionId: 'claude-session', logSelection: selection });
    expect(result.sessionDiagnostics?.logs.find((entry) => entry.kind === 'provider')?.artifact?.content).toBe('Claude conversation body');
    const outside = join(directory, 'claude-thread.jsonl');
    await writeFile(outside, 'unowned file content');
    await writeSessionMarker({ pid: 12345, happySessionId: 'claude-session', metadata: {
      flavor: 'claude', claudeSessionId: 'claude-thread', claudeTranscriptPath: outside,
    } });
    const refused = await collectBugReportMachineDiagnosticsSnapshotForBugReport({ sessionId: 'claude-session', logSelection: selection });
    expect(refused.sessionDiagnostics?.logs.find((entry) => entry.kind === 'provider')?.status).toBe('unavailable');
    expect(JSON.stringify(refused)).not.toContain('unowned file content');
  });

  it.each(['plain', 'e2ee'] as const)('resolves %s selected-session metadata through the real transport/parser and rejects a foreign machine', async (mode) => {
    const { default: axios } = await import('axios');
    const { configuration } = await import('@/configuration');
    const { encodeBase64, encrypt } = await import('@/api/encryption');
    const { collectBugReportMachineDiagnosticsSnapshotForBugReport } = await import('./bugReportMachineDiagnosticsRecipe');
    await mkdir(configuration.logsDir, { recursive: true });
    const logPath = join(configuration.logsDir, 'selected.log');
    await writeFile(logPath, 'exact server-selected session content');
    const key = new Uint8Array(32).fill(7);
    const sessionId = 'c123456789012345678901234';
    const metadata = { machineId: 'machine-a', flavor: 'codex', sessionLogPath: logPath, summary: { text: 'private metadata summary' } };
    // Axios is the HTTP boundary; session lookup, decryption, ownership, and file reads remain real.
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: {
      id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: mode, metadata: mode === 'plain' ? JSON.stringify(metadata) : encodeBase64(encrypt(key, 'legacy', metadata), 'base64'),
      metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
    } } });
    const credentials = { token: 'test-token', encryption: { type: 'legacy' as const, secret: key } };
    const result = await collectBugReportMachineDiagnosticsSnapshotForBugReport({ sessionId, logSelection: { daemon: false } }, { credentials, machineId: 'machine-a' });
    expect(result.sessionDiagnostics?.context.metadataStatus).toBe('available');
    expect(result.sessionDiagnostics?.logs.find((entry) => entry.kind === 'session')?.artifact?.content).toBe('exact server-selected session content');
    expect(JSON.stringify(result)).not.toContain('private metadata summary');
    const foreign = await collectBugReportMachineDiagnosticsSnapshotForBugReport({ sessionId }, { credentials, machineId: 'machine-b' });
    expect(foreign.sessionDiagnostics?.context.metadataStatus).toBe('wrong-machine');
    expect(foreign.sessionDiagnostics?.logs.some((entry) => entry.status === 'collected')).toBe(false);
  });
});
