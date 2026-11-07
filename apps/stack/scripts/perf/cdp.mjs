import { createCdpConnection } from '../../../ui/scripts/perf/agentBrowserUiPerfAudit.mjs';
import { readQaBrowserCdpTargets } from '../utils/dev_targets/qa_browser_cdp.mjs';

// Extend the existing UI audit transport with explicit Stack-owned page
// selection. Disconnecting this observer never closes that browser.
export async function connectPage(endpoint, pageId, signal) {
  const url = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('CDP must use the Stack loopback forward');
  const pages = (await readQaBrowserCdpTargets(endpoint, { signal })).filter(target => target.type === 'page');
  const page = pageId ? pages.find(target => target.id === pageId) : pages.length === 1 ? pages[0] : null;
  if (!page) throw new Error('Select exactly one owned page with --page-id');
  return { ...await createCdpConnection(page.webSocketDebuggerUrl), pageId: page.id };
}
