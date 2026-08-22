import { createServerUrlComparableKey } from '@happier-dev/protocol';

import { sanitizeDaemonEnvForSpawn } from '../daemon/daemon';

export type MobilePluginCandidateFakeClaudeFixture = Readonly<{
  executablePath: string;
  scenario: 'voice-current-ui-triage';
  logPath: string;
}>;

type RecordLike = Readonly<Record<string, unknown>>;

function asRecord(value: unknown, label: string): RecordLike {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Mobile candidate daemon preflight omitted ${label}`);
  }
  return value as RecordLike;
}

function requiredString(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`Mobile candidate daemon preflight omitted ${label}`);
  }
  return normalized;
}

export function buildMobilePluginCandidateDaemonEnv(input: Readonly<{
  baseEnv: NodeJS.ProcessEnv;
  happyHomeDir: string;
  serverUrl: string;
  webappUrl: string;
  fakeClaude: MobilePluginCandidateFakeClaudeFixture;
}>): NodeJS.ProcessEnv {
  return sanitizeDaemonEnvForSpawn({
    ...input.baseEnv,
    HAPPIER_HOME_DIR: input.happyHomeDir,
    HAPPIER_SERVER_URL: input.serverUrl,
    HAPPIER_WEBAPP_URL: input.webappUrl,
    HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_CLAUDE_PATH: input.fakeClaude.executablePath,
    HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: input.fakeClaude.scenario,
    HAPPIER_E2E_FAKE_CLAUDE_LOG: input.fakeClaude.logPath,
    HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
  });
}

export function assertMobilePluginCandidateDaemonPreflight(input: Readonly<{
  expectedServerUrl: string;
  status: unknown;
}>): Readonly<{
  activeServerId: string;
  serverUrl: string;
  comparableKey: string;
}> {
  const status = asRecord(input.status, 'status');
  const server = asRecord(status.server, 'server identity');
  const daemon = asRecord(status.daemon, 'daemon state');
  const service = asRecord(status.service, 'service state');
  const serverUrl = requiredString(server.serverUrl, 'server URL');
  const expectedComparableKey = createServerUrlComparableKey(input.expectedServerUrl);
  const actualComparableKey = createServerUrlComparableKey(serverUrl);
  if (actualComparableKey !== expectedComparableKey) {
    throw new Error(
      `Mobile candidate daemon preflight resolved a non-isolated server identity: expected ${expectedComparableKey}, received ${actualComparableKey}`,
    );
  }
  if (daemon.running !== false) {
    throw new Error('Mobile candidate daemon preflight found an already-running daemon');
  }
  if (service.running !== false) {
    throw new Error('Mobile candidate daemon preflight found an already-running background service');
  }

  return {
    activeServerId: requiredString(server.activeServerId, 'active server id'),
    serverUrl,
    comparableKey: requiredString(server.comparableKey, 'comparable server key'),
  };
}
