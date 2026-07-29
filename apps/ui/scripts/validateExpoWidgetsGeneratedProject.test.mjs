import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertExpoWidgetsGeneratedProject,
  DEFAULT_GENERATED_TARGET_NAME,
  DEFAULT_GENERATED_WIDGET_NAMES,
} from './validateExpoWidgetsGeneratedProject.mjs';

async function createGeneratedIosFixture({
  appScheme = 'Happierdev',
  appBundleIdentifier = 'dev.happier.app.dev.internal',
  widgetBundleIdentifier = `${appBundleIdentifier}.${DEFAULT_GENERATED_TARGET_NAME}`,
} = {}) {
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
      `name = ${appScheme};`,
      '/* Begin PBXBuildFile section */',
      `    111111111111111111111111 /* ${DEFAULT_GENERATED_TARGET_NAME}.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = 222222222222222222222222 /* ${DEFAULT_GENERATED_TARGET_NAME}.appex */; };`,
      '/* End PBXBuildFile section */',
      '/* Begin PBXFileReference section */',
      `    222222222222222222222222 /* ${DEFAULT_GENERATED_TARGET_NAME}.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = ${DEFAULT_GENERATED_TARGET_NAME}.appex; sourceTree = BUILT_PRODUCTS_DIR; };`,
      '/* End PBXFileReference section */',
      '/* Begin PBXNativeTarget section */',
      `    333333333333333333333333 /* ${DEFAULT_GENERATED_TARGET_NAME} */ = {`,
      '      isa = PBXNativeTarget;',
      `      name = ${DEFAULT_GENERATED_TARGET_NAME};`,
      `      productName = ${DEFAULT_GENERATED_TARGET_NAME};`,
      `      productReference = 222222222222222222222222 /* ${DEFAULT_GENERATED_TARGET_NAME}.appex */;`,
      '      productType = "com.apple.product-type.app-extension";',
      '    };',
      '/* End PBXNativeTarget section */',
      `PRODUCT_BUNDLE_IDENTIFIER = "${appBundleIdentifier}";`,
      `PRODUCT_BUNDLE_IDENTIFIER = "${widgetBundleIdentifier}";`,
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

async function appendPbxprojEntry({ iosDir, sectionName, entry }) {
  const entries = await readdir(iosDir, { withFileTypes: true });
  const projectEntry = entries.find((candidate) => candidate.isDirectory() && candidate.name.endsWith('.xcodeproj'));
  const pbxprojPath = join(iosDir, projectEntry.name, 'project.pbxproj');
  const rawPbxproj = await readFile(pbxprojPath, 'utf8');

  await writeFile(
    pbxprojPath,
    rawPbxproj.replace(
      `/* End ${sectionName} section */`,
      `${entry}\n/* End ${sectionName} section */`,
    ),
    'utf8',
  );
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

test('assertExpoWidgetsGeneratedProject rejects a widget bundle identifier outside the app prefix', async () => {
  const { iosDir } = await createGeneratedIosFixture({
    appBundleIdentifier: 'dev.happier.app.dev.next-dev.devclient',
    widgetBundleIdentifier: 'dev.happier.app.dev.internal.devclient.ExpoWidgetsTarget',
  });

  await assert.rejects(
    () =>
      assertExpoWidgetsGeneratedProject({
        iosDir,
        spawnSyncImpl: () => ({
          status: 0,
          stdout: `Targets:\n    Happierdev\n    ${DEFAULT_GENERATED_TARGET_NAME}\nSchemes:\n    Happierdev\n    ${DEFAULT_GENERATED_TARGET_NAME}\n`,
          stderr: '',
          error: undefined,
        }),
      }),
    /prefixed with the parent app bundle identifier/i,
  );
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

test('assertExpoWidgetsGeneratedProject rejects duplicate widget native targets', async () => {
  const { iosDir } = await createGeneratedIosFixture();
  await appendPbxprojEntry({
    iosDir,
    sectionName: 'PBXNativeTarget',
    entry: [
      `    444444444444444444444444 /* ${DEFAULT_GENERATED_TARGET_NAME} */ = {`,
      '      isa = PBXNativeTarget;',
      `      name = ${DEFAULT_GENERATED_TARGET_NAME};`,
      `      productName = ${DEFAULT_GENERATED_TARGET_NAME};`,
      `      productReference = 222222222222222222222222 /* ${DEFAULT_GENERATED_TARGET_NAME}.appex */;`,
      '      productType = "com.apple.product-type.app-extension";',
      '    };',
    ].join('\n'),
  });

  await assert.rejects(
    () =>
      assertExpoWidgetsGeneratedProject({
        iosDir,
        spawnSyncImpl: () => ({
          status: 0,
          stdout: `Targets:\n    Happierdev\n    ${DEFAULT_GENERATED_TARGET_NAME}\nSchemes:\n    Happierdev\n    ${DEFAULT_GENERATED_TARGET_NAME}\n`,
          stderr: '',
          error: undefined,
        }),
      }),
    /exactly one PBXNativeTarget/i,
  );
});

test('assertExpoWidgetsGeneratedProject rejects duplicate widget appex product references', async () => {
  const { iosDir } = await createGeneratedIosFixture();
  await appendPbxprojEntry({
    iosDir,
    sectionName: 'PBXFileReference',
    entry: `    555555555555555555555555 /* ${DEFAULT_GENERATED_TARGET_NAME}.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = ${DEFAULT_GENERATED_TARGET_NAME}.appex; sourceTree = BUILT_PRODUCTS_DIR; };`,
  });

  await assert.rejects(
    () =>
      assertExpoWidgetsGeneratedProject({
        iosDir,
        spawnSyncImpl: () => ({
          status: 0,
          stdout: `Targets:\n    Happierdev\n    ${DEFAULT_GENERATED_TARGET_NAME}\nSchemes:\n    Happierdev\n    ${DEFAULT_GENERATED_TARGET_NAME}\n`,
          stderr: '',
          error: undefined,
        }),
      }),
    /exactly one PBXFileReference/i,
  );
});

test('assertExpoWidgetsGeneratedProject rejects duplicate widget appex embed build files', async () => {
  const { iosDir } = await createGeneratedIosFixture();
  await appendPbxprojEntry({
    iosDir,
    sectionName: 'PBXBuildFile',
    entry: `    666666666666666666666666 /* ${DEFAULT_GENERATED_TARGET_NAME}.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = 222222222222222222222222 /* ${DEFAULT_GENERATED_TARGET_NAME}.appex */; };`,
  });

  await assert.rejects(
    () =>
      assertExpoWidgetsGeneratedProject({
        iosDir,
        spawnSyncImpl: () => ({
          status: 0,
          stdout: `Targets:\n    Happierdev\n    ${DEFAULT_GENERATED_TARGET_NAME}\nSchemes:\n    Happierdev\n    ${DEFAULT_GENERATED_TARGET_NAME}\n`,
          stderr: '',
          error: undefined,
        }),
      }),
    /exactly one PBXBuildFile/i,
  );
});
