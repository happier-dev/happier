import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolvePackagesTestsRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function resolvePlaywrightUiRunNamespace(env = process.env) {
  const explicitNamespace = String(env?.HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE ?? '').trim();
  if (explicitNamespace) return explicitNamespace;
  return `playwright-ui-${process.pid}`;
}

export function resolvePlaywrightUiArtifactsRootDir(env = process.env) {
  return resolve(
    resolvePackagesTestsRootDir(),
    '.project',
    'logs',
    'e2e',
    'ui-playwright',
    resolvePlaywrightUiRunNamespace(env),
  );
}

export function resolvePlaywrightUiTestResultsDir(env = process.env) {
  return resolve(resolvePlaywrightUiArtifactsRootDir(env), 'test-results');
}

export function resolvePlaywrightUiHtmlReportDir(env = process.env) {
  return resolve(resolvePlaywrightUiArtifactsRootDir(env), 'html-report');
}
