import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { openSqliteDatabaseSync } from '@/utils/sqlite/sqliteSync';
import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';

describe('existing-state handoff spawn environment', () => {
  it('rechecks native-only indexed state before launch and refuses a disappeared prepared rollout', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'happier-existing-native-spawn-'));
    const codexHome = join(testRoot, 'codex');
    const vendorResumeId = '00000000-0000-4000-8000-000000000043';
    const rolloutPath = join(codexHome, 'sessions', `rollout-2026-10-10T12-00-00-${vendorResumeId}.jsonl`);
    const codexPath = await writeExecutableShim({
      dir: join(testRoot, 'bin'), fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
      contents: process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
    });
    const verify = (resume = vendorResumeId) => resolveSpawnChildEnvironment({
      options: {
        directory: testRoot, backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        resume, handoffStateTransfer: 'existing', codexBackendMode: 'appServer',
      },
      existingSessionMetadata: { machineId: 'source', flavor: 'codex', codexSessionId: vendorResumeId, codexBackendMode: 'appServer' },
      profileEnvironmentVariables: { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: codexHome },
      daemonSpawnHooks: null, processEnv: { HAPPIER_CODEX_PATH: codexPath }, logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
    });
    try {
      expect(await verify()).toMatchObject({ ok: false, errorCode: 'existing_session_state_unavailable' });
      await mkdir(join(codexHome, 'sessions'), { recursive: true });
      await writeFile(rolloutPath, 'already-synced transcript\n');
      const database = openSqliteDatabaseSync(join(codexHome, 'state_5.sqlite'));
      try {
        database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
        database.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(vendorResumeId, rolloutPath);
      } finally {
        database.close();
      }
      expect(await verify()).toMatchObject({ ok: true, extraEnvForChild: { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: codexHome } });
      expect(await verify('different-native-session')).toMatchObject({ ok: false, errorCode: 'SPAWN_VALIDATION_FAILED' });
      expect(await readFile(rolloutPath, 'utf8')).toBe('already-synced transcript\n');
      await rm(rolloutPath);
      expect(await verify()).toMatchObject({ ok: false, errorCode: 'existing_session_state_unavailable' });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});
