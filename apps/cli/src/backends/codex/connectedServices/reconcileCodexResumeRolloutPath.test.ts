import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteDatabaseSync } from '@/utils/sqlite/sqliteSync';
import { reconcileNativeCodexResumeRolloutPath } from './reconcileCodexResumeRolloutPath';

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

describe('reconcileNativeCodexResumeRolloutPath', () => {
  it('points a thread copied from another machine at the same rollout in this Codex home', async () => {
    const home = await nativeHome({ rolloutPath: WINDOWS_PATH, withLocalRollout: true });
    await expect(reconcileNativeCodexResumeRolloutPath({ env: home.env, vendorResumeId: THREAD_ID, cwd: '/project' }))
      .resolves.toBe(true);
    expect(home.readRow()).toBe(home.localRollout);
  });

  it('leaves the row alone when its rollout still exists or no local rollout can replace it', async () => {
    const intact = await nativeHome({ rolloutPath: '', withLocalRollout: true });
    const db = openSqliteDatabaseSync(join(intact.env.CODEX_HOME, 'state_5.sqlite'));
    db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(intact.localRollout, THREAD_ID);
    db.close();
    await reconcileNativeCodexResumeRolloutPath({ env: intact.env, vendorResumeId: THREAD_ID, cwd: '/project' });
    expect(intact.readRow()).toBe(intact.localRollout);

    const missing = await nativeHome({ rolloutPath: WINDOWS_PATH, withLocalRollout: false });
    await expect(reconcileNativeCodexResumeRolloutPath({ env: missing.env, vendorResumeId: THREAD_ID, cwd: '/project' }))
      .resolves.toBe(false);
    expect(missing.readRow()).toBe(WINDOWS_PATH);
  });
});
