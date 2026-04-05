import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertExpoWidgetsGeneratedProject,
  DEFAULT_GENERATED_TARGET_NAME,
  DEFAULT_GENERATED_WIDGET_NAMES,
} from './validateExpoWidgetsGeneratedProject.mjs';

async function createGeneratedIosFixture({ appScheme = 'Happierdev' } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'expo-widgets-generated-project-'));
  const iosDir = join(rootDir, 'ios');
  const xcodeprojDir = join(iosDir, `${appScheme}.xcodeproj`);
  const targetDir = join(iosDir, DEFAULT_GENERATED_TARGET_NAME);

  await mkdir(xcodeprojDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });

  await writeFile(
    join(iosDir, 'Podfile'),
    [
      'platform :ios, "16.2"',
      'target "Happierdev" do',
      'end',
      `target "${DEFAULT_GENERATED_TARGET_NAME}" do`,
      '  use_expo_modules_widgets!',
      'end',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(xcodeprojDir, 'project.pbxproj'),
    [
      `name = ${DEFAULT_GENERATED_TARGET_NAME};`,
      `"${DEFAULT_GENERATED_TARGET_NAME}.appex"`,
      'PRODUCT_BUNDLE_IDENTIFIER = "dev.happier.app.dev.internal.ExpoWidgetsTarget";',
      ...DEFAULT_GENERATED_WIDGET_NAMES.map((name) => `${name}.swift`),
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(targetDir, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<dict>',
      '  <key>NSExtension</key>',
      '  <dict>',
      '    <key>NSExtensionPointIdentifier</key>',
      '    <string>com.apple.widgetkit-extension</string>',
      '  </dict>',
      '</dict>',
      '</plist>',
    ].join('\n'),
    'utf8',
  );

  await Promise.all(
    DEFAULT_GENERATED_WIDGET_NAMES.map((name) =>
      writeFile(join(targetDir, `${name}.swift`), `struct ${name} {}`, 'utf8'),
    ),
  );

  return { iosDir, rootDir, xcodeprojDir };
}

test('assertExpoWidgetsGeneratedProject discovers the generated app project name dynamically', async () => {
  const { iosDir, xcodeprojDir } = await createGeneratedIosFixture({ appScheme: 'Happierinternaldev' });

  const summary = await assertExpoWidgetsGeneratedProject({
    iosDir,
    spawnSyncImpl: () => ({
      status: 0,
      stdout: `Targets:\n    Happierinternaldev\n    ${DEFAULT_GENERATED_TARGET_NAME}\nSchemes:\n    Happierinternaldev\n    ${DEFAULT_GENERATED_TARGET_NAME}\n`,
      stderr: '',
      error: undefined,
    }),
  });

  assert.equal(summary.xcodeprojPath, xcodeprojDir);
});

test('assertExpoWidgetsGeneratedProject returns the canonical generated target summary', async () => {
  const { iosDir, xcodeprojDir } = await createGeneratedIosFixture();

  const summary = await assertExpoWidgetsGeneratedProject({
    iosDir,
    spawnSyncImpl: () => ({
      status: 0,
      stdout: `Targets:\n    Happierdev\n    ${DEFAULT_GENERATED_TARGET_NAME}\nSchemes:\n    Happierdev\n    ${DEFAULT_GENERATED_TARGET_NAME}\n`,
      stderr: '',
      error: undefined,
    }),
  });

  assert.equal(summary.targetName, DEFAULT_GENERATED_TARGET_NAME);
  assert.equal(summary.bundleIdentifier, 'dev.happier.app.dev.internal.ExpoWidgetsTarget');
  assert.deepEqual(summary.widgetNames, DEFAULT_GENERATED_WIDGET_NAMES);
  assert.equal(summary.xcodeprojPath, xcodeprojDir);
  assert.equal(summary.usedXcodebuildValidation, true);
});

test('assertExpoWidgetsGeneratedProject rejects missing Podfile widget target integration', async () => {
  const { iosDir } = await createGeneratedIosFixture();
  const podfilePath = join(iosDir, 'Podfile');
  const rawPodfile = await readFile(podfilePath, 'utf8');
  await writeFile(podfilePath, rawPodfile.replace('use_expo_modules_widgets!', ''), 'utf8');

  await assert.rejects(
    () => assertExpoWidgetsGeneratedProject({ iosDir, spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: undefined }) }),
    /use_expo_modules_widgets/i,
  );
});

test('assertExpoWidgetsGeneratedProject tolerates missing xcodebuild when filesystem validation is already green', async () => {
  const { iosDir } = await createGeneratedIosFixture();

  const summary = await assertExpoWidgetsGeneratedProject({
    iosDir,
    spawnSyncImpl: () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawn xcodebuild ENOENT'), { code: 'ENOENT' }),
    }),
  });

  assert.equal(summary.usedXcodebuildValidation, false);
});
