import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function collectExpectedUiInstallScopeWorkspaces() {
  const uiPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', 'ui', 'package.json'), 'utf8'));
  const internalDeps = Object.keys(uiPackage?.dependencies ?? {})
    .filter((name) => name.startsWith('@happier-dev/'))
    .map((name) => name.split('/')[1])
    .filter(Boolean);

  const requiresBuiltDist = internalDeps.filter((workspace) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', workspace, 'package.json'), 'utf8'));
    const candidates = [];
    for (const key of ['main', 'module', 'types']) {
      if (typeof pkg?.[key] === 'string') candidates.push(pkg[key]);
    }
    const visit = (value) => {
      if (!value) return;
      if (typeof value === 'string') {
        candidates.push(value);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value === 'object') {
        Object.values(value).forEach(visit);
      }
    };
    visit(pkg?.exports);

    return candidates.some((candidate) => /^\.?\/?dist\//.test(String(candidate)));
  });

  return new Set(['ui', ...requiresBuiltDist]);
}

test('apps/ui/eas.json defines internaldev profiles for OTA-native debug dev-client validation', () => {
  const easPath = path.join(repoRoot, 'apps', 'ui', 'eas.json');
  const raw = fs.readFileSync(easPath, 'utf8');
  const eas = JSON.parse(raw);

  const build = eas?.build ?? null;
  assert.equal(typeof build, 'object');

  const baseInstallScope = String(build?.base?.env?.HAPPIER_INSTALL_SCOPE ?? '');
  const installScopeTokens = new Set(
    baseInstallScope
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean),
  );
  for (const workspace of collectExpectedUiInstallScopeWorkspaces()) {
    assert.equal(
      installScopeTokens.has(workspace),
      true,
      `base HAPPIER_INSTALL_SCOPE should include ${workspace} because apps/ui depends on it via dist-based workspace exports`,
    );
  }

  const internaldev = build?.internaldev ?? null;
  assert.equal(typeof internaldev, 'object');
  assert.equal(internaldev.extends, 'base');
  assert.equal(internaldev.environment, 'development');
  assert.equal(internaldev.developmentClient, true);
  assert.equal(internaldev.distribution, 'internal');
  assert.equal(internaldev.channel, 'internaldev');
  assert.equal(internaldev?.env?.APP_ENV, 'internaldev');
  assert.equal(internaldev?.env?.EXPO_UPDATES_CHANNEL, 'internaldev');
  assert.equal(internaldev?.env?.EXPO_APP_NAME, 'Happier (internal dev)');
  assert.equal(internaldev?.env?.EXPO_APP_BUNDLE_ID, 'dev.happier.app.dev.internal');
  assert.equal(internaldev?.env?.EXPO_ANDROID_PACKAGE, 'dev.happier.app.internaldev');
  assert.equal(internaldev?.env?.EXPO_APP_SCHEME, 'happier-internaldev');
  assert.equal(internaldev?.env?.HAPPIER_EXPO_DEVCLIENT_LAUNCH_MODE, 'most-recent');
  assert.equal(internaldev?.env?.HAPPIER_EXPO_DEVCLIENT_SILENT_LAUNCH, 'true');
  assert.equal(internaldev?.env?.HAPPIER_EXPO_USE_NATIVE_DEBUG, 'true');
  assert.equal(internaldev?.env?.EX_UPDATES_NATIVE_DEBUG, '1');

  const internaldevStore = build?.['internaldev-store'] ?? null;
  assert.equal(typeof internaldevStore, 'object');
  assert.equal(internaldevStore.extends, 'base');
  assert.equal(internaldevStore.environment, 'development');
  assert.equal(internaldevStore.developmentClient, true);
  assert.equal(internaldevStore.distribution, 'store');
  assert.equal(internaldevStore.channel, 'internaldev');
  assert.equal(internaldevStore?.env?.APP_ENV, 'internaldev');
  assert.equal(internaldevStore?.env?.EXPO_UPDATES_CHANNEL, 'internaldev');
  assert.equal(internaldevStore?.env?.EXPO_APP_NAME, 'Happier (internal dev)');
  assert.equal(internaldevStore?.env?.EXPO_APP_BUNDLE_ID, 'dev.happier.app.dev.internal');
  assert.equal(internaldevStore?.env?.EXPO_ANDROID_PACKAGE, 'dev.happier.app.internaldev');
  assert.equal(internaldevStore?.env?.EXPO_APP_SCHEME, 'happier-internaldev');
});
