import { runQaBrowserSigninPage } from './qa_browser_signin_page.mjs';
import { formatDevAuthKeyBackup, normalizeDevAuthKeyInputToBytes } from '../auth/dev_key.mjs';
import { requireSessionName } from './qa_browser_retirement.mjs';

/** Normalize stdin once; Stack-info owns endpoint discovery, the page driver owns CDP. */
export async function runQaBrowserSignin({ sessionName, stackName, rootDir, cdpHttpUrl, confirmHomeAliasUrl, input = process.stdin }, boundaries = {}) {
  let key = '';
  try {
    requireSessionName(sessionName);
    if (input.isTTY) return { ok: false, reason: 'stdin_required' };
    for await (const chunk of input) key += chunk;
    const bytes = normalizeDevAuthKeyInputToBytes(key);
    key = '';
    if (!bytes) return { ok: false, reason: 'invalid_key' };
    key = formatDevAuthKeyBackup(Buffer.from(bytes).toString('base64url'));
    if (!cdpHttpUrl) return { ok: false, reason: 'cdp_required' };
    const { readStackInfoSnapshot } = await import('../../stack/stack_info_snapshot.mjs');
    const info = await readStackInfoSnapshot({ rootDir, stackName });
    const pending = runQaBrowserSigninPage({ urls: info.urls, cdpHttpUrl, key, confirmHomeAliasUrl }, boundaries);
    key = '';
    return await pending;
  } catch {
    // Discovery errors must never export exception text or credential input.
    return { ok: false, reason: 'browser_unavailable' };
  } finally { key = ''; }
}
