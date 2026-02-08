import { cmd } from '../ui/layout.mjs';

export function validateUiServingConfig({
  serverComponentName,
  serveUiWanted,
  uiRequired,
  uiBuildDir,
  uiBuildDirExists,
  uiIndexExists,
} = {}) {
  const serve = Boolean(serveUiWanted);
  if (!serve) {
    return { serveUi: false, warning: null };
  }

  const dir = String(uiBuildDir ?? '').trim();
  const exists = Boolean(uiBuildDirExists);
  const hasIndex = Boolean(uiIndexExists);
  const required = uiRequired == null ? true : Boolean(uiRequired);

  if (!dir || !exists) {
    if (required || serverComponentName === 'happier-server-light') {
      throw new Error(`[local] UI build directory not found at ${dir || '(unset)'}.\nRun: ${cmd('hstack build')}`);
    }
    return { serveUi: false, warning: dir ? `UI build dir missing at ${dir}; UI serving will be disabled` : 'UI build dir unset; UI serving will be disabled' };
  }

  if (!hasIndex) {
    const indexPath = `${dir.replace(/\/+$/, '')}/index.html`;
    if (required || serverComponentName === 'happier-server-light') {
      throw new Error(`[local] UI build is incomplete (missing ${indexPath}).\nRun: ${cmd('hstack build')}`);
    }
    return { serveUi: false, warning: `UI index.html missing at ${indexPath}; UI serving will be disabled` };
  }

  return { serveUi: true, warning: null };
}
