import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveExistingCodexSessionHandoffState } from '../sessionHandoff/resolveExistingSessionHandoffState';
import { openSqliteDatabaseSync } from '@/utils/sqlite/sqliteSync';
import { resolveCodexSqliteLaunch, resolveConfiguredCodexSqliteHome } from './codexStateFileNames';
import { reconcileCodexResumeRolloutPath } from './reconcileCodexResumeRolloutPath';

const THREAD_ID = '01a1098d-ecd5-7113-b3cc-b365a60bfbbe';
const ROLLOUT_NAME = `rollout-2026-10-05T01-54-18-${THREAD_ID}.jsonl`;
const WINDOWS_PATH = `C:\\Users\\dax\\.codex\\sessions\\2026\\10\\05\\${ROLLOUT_NAME}`;

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function nativeHome(params: Readonly<{ rolloutPath: string; withLocalRollout: boolean }>) {
  const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-native-resume-'));
  roots.push(codexHome);
  const localRollout = join(codexHome, 'sessions', '2026', '10', '05', ROLLOUT_NAME);
  if (params.withLocalRollout) {
    await mkdir(join(codexHome, 'sessions', '2026', '10', '05'), { recursive: true });
    await writeFile(localRollout, `${JSON.stringify({ type: 'session_meta', payload: { id: THREAD_ID, history_mode: 'paginated' } })}\n`);
  }
  const database = openSqliteDatabaseSync(join(codexHome, 'state_5.sqlite'));
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
  database.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(THREAD_ID, params.rolloutPath);
  database.close();
  const readRow = () => {
    const db = openSqliteDatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true });
    try { return (db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(THREAD_ID) as { rollout_path: string }).rollout_path; }
    finally { db.close(); }
  };
  return { env: { CODEX_HOME: codexHome }, localRollout, readRow };
}

describe('reconcileCodexResumeRolloutPath', () => {
  it('admits existing-state handoff when the native index can be repaired on resume', async () => {
    const home = await nativeHome({ rolloutPath: WINDOWS_PATH, withLocalRollout: true });
    await expect(resolveExistingCodexSessionHandoffState({
      metadata: {}, vendorResumeId: THREAD_ID, targetPath: home.env.CODEX_HOME,
      env: home.env, sessionStorageMode: 'direct',
    })).resolves.toMatchObject({ remoteSessionId: THREAD_ID });
    expect(home.readRow()).toBe(WINDOWS_PATH);
  });

  it('expands the persisted launch pin relative to the configured home', async () => {
    const home = await nativeHome({ rolloutPath: WINDOWS_PATH, withLocalRollout: false });
    expect(resolveConfiguredCodexSqliteHome(
      { ...home.env, HOME: home.env.CODEX_HOME, USERPROFILE: home.env.CODEX_HOME },
      dirname(home.env.CODEX_HOME), { launchPin: '~/sqlite' },
    )).toBe(join(home.env.CODEX_HOME, 'sqlite'));
  });

  it('points a thread copied from another machine at the same rollout in this Codex home', async () => {
    const home = await nativeHome({ rolloutPath: WINDOWS_PATH, withLocalRollout: true });
    await expect(reconcileCodexResumeRolloutPath({
      env: { CODEX_HOME: basename(home.env.CODEX_HOME) },
      vendorResumeId: THREAD_ID,
      cwd: dirname(home.env.CODEX_HOME),
      sqliteHome: home.env.CODEX_HOME,
    })).resolves.toBe(true);
    expect(home.readRow()).toBe(home.localRollout);
  });

  it.each(['TOML', 'argv', 'managed', 'managed-auth', 'personal-auth'] as const)('repairs the %s-selected index and preserves the fallback index', async config => {
    const home = await nativeHome({ rolloutPath: WINDOWS_PATH, withLocalRollout: true });
    const sqliteHome = join(home.env.CODEX_HOME, 'configured-sqlite');
    await mkdir(sqliteHome);
    const override = `sqlite_home = ${JSON.stringify(sqliteHome)}`;
    if (config === 'managed') await writeFile(join(home.env.CODEX_HOME, 'cloud-config-bundle-cache.json'), '{}');
    if (config === 'TOML' || config === 'personal-auth') {
      await writeFile(join(home.env.CODEX_HOME, 'config.toml'), override + '\n');
    }
    if (config === 'managed-auth' || config === 'personal-auth') {
      const plan = config === 'managed-auth' ? 'business' : 'plus';
      const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: plan } })).toString('base64url');
      await writeFile(join(home.env.CODEX_HOME, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: `a.${claims}.c` } }));
    }
    const competingRollout = join(home.env.CODEX_HOME, 'sessions', `rollout-2026-10-06T01-54-18-${THREAD_ID}.jsonl`);
    await writeFile(competingRollout, `${JSON.stringify({ type: 'session_meta', payload: { id: THREAD_ID } })}\n`);
    const databasePath = join(sqliteHome, 'state_5.sqlite');
    const db = openSqliteDatabaseSync(databasePath);
    try {
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
      db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(THREAD_ID, WINDOWS_PATH);
      const env = { ...home.env, CODEX_SQLITE_HOME: home.env.CODEX_HOME };
      const store = await resolveCodexSqliteLaunch({ env, cwd: '/project', configOverrides: config === 'argv' ? [override] : undefined });
      const effectiveRoot = config === 'managed' || config === 'managed-auth'
        ? await store.readEffectiveSqliteHome(async method => method === 'configRequirements/read'
          ? { requirements: { sqliteHome } }
          : { config: { sqlite_home: home.env.CODEX_HOME } })
        : store.sqliteHome;
      await reconcileCodexResumeRolloutPath({ env, vendorResumeId: THREAD_ID, cwd: '/project', sqliteHome: effectiveRoot });
      expect(db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(THREAD_ID)).toMatchObject({
        rollout_path: home.localRollout,
      });
      expect(home.readRow()).toBe(WINDOWS_PATH);
    } finally {
      db.close();
    }
  });

  it('leaves the row alone when its rollout still exists or no local rollout can replace it', async () => {
    const intact = await nativeHome({ rolloutPath: '', withLocalRollout: true });
    const db = openSqliteDatabaseSync(join(intact.env.CODEX_HOME, 'state_5.sqlite'));
    db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(intact.localRollout, THREAD_ID);
    db.close();
    await reconcileCodexResumeRolloutPath({ env: intact.env, vendorResumeId: THREAD_ID, cwd: '/project', sqliteHome: intact.env.CODEX_HOME });
    expect(intact.readRow()).toBe(intact.localRollout);

    const missing = await nativeHome({ rolloutPath: WINDOWS_PATH, withLocalRollout: false });
    await expect(reconcileCodexResumeRolloutPath({ env: missing.env, vendorResumeId: THREAD_ID, cwd: '/project', sqliteHome: missing.env.CODEX_HOME }))
      .resolves.toBe(false);
    expect(missing.readRow()).toBe(WINDOWS_PATH);
  });
});
