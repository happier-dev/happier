import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const xcode = require('xcode');
const {
  CRYPTO_SOURCE_FILE_NAMES,
  EXTENSION_POINT_IDENTIFIER,
  TARGET_NAME,
  TARGET_SOURCE_FILE_NAMES,
  buildNotificationServiceInfoPlist,
  configureNotificationServiceTarget,
  ensureApplicationAppGroupEntitlement,
  ensureApplicationAppGroupInfoPlist,
  notificationServiceBundleIdentifier,
} = require('../withActivityNotificationsIos.js');

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'minimalApp.pbxproj');

function loadProject() {
  const project = xcode.project(FIXTURE);
  project.parseSync();
  return project;
}

function installedLibsodium(t, { hoisted = true, frameworkPresent = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'happier-notification-ios-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'apps', 'ui');
  const platformProjectRoot = join(projectRoot, 'ios');
  const packageRoot = join(hoisted ? root : projectRoot, 'node_modules', '@more-tech', 'react-native-libsodium');
  const frameworkPath = join(packageRoot, 'libsodium', 'build', 'libsodium-apple', 'Clibsodium.xcframework');
  mkdirSync(platformProjectRoot, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@more-tech/react-native-libsodium', version: '1.5.6' }));
  if (frameworkPresent) mkdirSync(frameworkPath, { recursive: true });
  return { projectRoot, platformProjectRoot, frameworkPath };
}

function nativeTargets(project) {
  return Object.entries(project.hash.project.objects.PBXNativeTarget)
    .filter(([key]) => !key.endsWith('_comment'))
    .map(([uuid, target]) => ({ uuid, target }));
}

function findTarget(project, name) {
  return nativeTargets(project).find(({ target }) => String(target.name).replace(/"/g, '') === name);
}

function buildSettingsFor(project, target) {
  const list = project.pbxXCConfigurationList()[target.buildConfigurationList];
  const configurations = project.pbxXCBuildConfigurationSection();
  return list.buildConfigurations.map((entry) => configurations[entry.value].buildSettings);
}

function phaseOf(project, target, isa) {
  const entry = target.buildPhases
    .map((phase) => ({ phase, object: project.hash.project.objects[isa]?.[phase.value] }))
    .find(({ object }) => object);
  return entry?.object ?? null;
}

test('the alert consumer is built as an app extension the app embeds and depends on', (t) => {
  const project = loadProject();
  configureNotificationServiceTarget(project, { ...installedLibsodium(t), appBundleIdentifier: 'dev.happier.app' });

  const extension = findTarget(project, TARGET_NAME);
  assert.ok(extension, 'missing notification service extension target');
  assert.equal(String(extension.target.productType).replace(/"/g, ''), 'com.apple.product-type.app-extension');

  const sources = phaseOf(project, extension.target, 'PBXSourcesBuildPhase');
  assert.deepEqual(
    sources.files.map((file) => file.comment),
    TARGET_SOURCE_FILE_NAMES.map((name) => `${name} in Sources`),
  );

  // The consumer must stay a Foundation/UserNotifications extension: linking the
  // app's pods here would pull the React runtime into alert presentation.
  const frameworks = phaseOf(project, extension.target, 'PBXFrameworksBuildPhase');
  assert.ok(
    frameworks.files.some((file) => file.comment.startsWith('Clibsodium.xcframework in ')),
    'the extension cannot open the canonical Session envelopes without the existing libsodium binary',
  );
  for (const fileName of CRYPTO_SOURCE_FILE_NAMES) {
    assert.ok(
      sources.files.some((file) => file.comment === `${fileName} in Sources`),
      `missing shared crypto-owner source ${fileName}`,
    );
  }

  const app = findTarget(project, 'HappierApp');
  const copyFiles = phaseOf(project, app.target, 'PBXCopyFilesBuildPhase');
  assert.equal(copyFiles.dstSubfolderSpec, 13);
  assert.ok(copyFiles.files.some((file) => file.comment.startsWith(`${TARGET_NAME}.appex`)));
  assert.equal(app.target.dependencies.length, 1);

  for (const settings of buildSettingsFor(project, extension.target)) {
    assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, '"dev.happier.app.ActivityNotificationService"');
    assert.equal(settings.INFOPLIST_FILE, `"${TARGET_NAME}/${TARGET_NAME}-Info.plist"`);
    assert.equal(settings.SKIP_INSTALL, 'YES');
    // Xcode expands static XCFramework headers under CONFIGURATION_BUILD_DIR/include.
    // Keep that module map out of the app's default header search directory,
    // where CocoaPods already supplies the same Clibsodium module.
    assert.equal(settings.CONFIGURATION_BUILD_DIR, '"$(BUILD_DIR)/$(CONFIGURATION)$(EFFECTIVE_PLATFORM_NAME)/$(TARGET_NAME)"');
  }
  assert.equal(
    project.pbxFileReferenceSection()[extension.target.productReference].path,
    `"${TARGET_NAME}/${TARGET_NAME}.appex"`,
    'the app must embed the extension from its isolated output directory',
  );
  assert.ok(project.writeSync().includes('com.apple.product-type.app-extension'));
});

test('a repeated prebuild converges on one target and refreshes its identity', (t) => {
  const project = loadProject();
  const installation = installedLibsodium(t);
  configureNotificationServiceTarget(project, { ...installation, appBundleIdentifier: 'dev.happier.app' });
  // A project generated before workspace-aware resolution must also converge.
  const sodium = Object.values(project.pbxFileReferenceSection())
    .find((file) => file?.path?.includes('Clibsodium.xcframework'));
  sodium.path = '"../node_modules/@more-tech/react-native-libsodium/libsodium/build/libsodium-apple/Clibsodium.xcframework"';
  configureNotificationServiceTarget(project, { ...installation, appBundleIdentifier: 'dev.happier.app.dev', deploymentTarget: '17.0' });

  assert.equal(nativeTargets(project).length, 2);
  const extension = findTarget(project, TARGET_NAME);
  for (const settings of buildSettingsFor(project, extension.target)) {
    assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, '"dev.happier.app.dev.ActivityNotificationService"');
    assert.equal(settings.IPHONEOS_DEPLOYMENT_TARGET, '17.0');
  }
  const app = findTarget(project, 'HappierApp');
  assert.equal(app.target.dependencies.length, 1);
  const frameworks = phaseOf(project, extension.target, 'PBXFrameworksBuildPhase');
  assert.equal(frameworks.files.length, 1);
  const references = Object.values(project.pbxFileReferenceSection())
    .filter((file) => file?.path?.includes('Clibsodium.xcframework'));
  assert.equal(references.length, 1);
  assert.equal(resolve(installation.platformProjectRoot, references[0].path.replace(/^"|"$/g, '')), installation.frameworkPath);
});

for (const hoisted of [true, false]) {
  test(`the extension links the installed libsodium XCFramework (${hoisted ? 'hoisted' : 'app-local'})`, (t) => {
    const installation = installedLibsodium(t, { hoisted });
    const project = loadProject();
    configureNotificationServiceTarget(project, { ...installation, appBundleIdentifier: 'dev.happier.app' });
    const extension = findTarget(project, TARGET_NAME);
    const frameworks = phaseOf(project, extension.target, 'PBXFrameworksBuildPhase');
    const linkedFrameworks = frameworks.files.map(({ value }) => {
      const buildFile = project.pbxBuildFileSection()[value];
      return project.pbxFileReferenceSection()[buildFile.fileRef];
    });
    const sodium = linkedFrameworks.find((file) => String(file.path).includes('Clibsodium.xcframework'));
    assert.ok(sodium, 'missing libsodium link input');
    assert.equal(sodium.sourceTree, '"<group>"');
    assert.equal(resolve(installation.platformProjectRoot, sodium.path.replace(/^"|"$/g, '')), installation.frameworkPath);
  });
}

test('prebuild fails visibly when the resolved libsodium package has no XCFramework', (t) => {
  const installation = installedLibsodium(t, { frameworkPresent: false });
  assert.throws(
    () => configureNotificationServiceTarget(loadProject(), { ...installation, appBundleIdentifier: 'dev.happier.app' }),
    (error) => error instanceof Error && error.message.includes(installation.frameworkPath),
  );
});

test('a missing app bundle identifier fails the build instead of shipping a misidentified extension', () => {
  assert.throws(() => notificationServiceBundleIdentifier(undefined));
  assert.throws(() => configureNotificationServiceTarget(loadProject(), {}));
});

test('the extension declares the user-notifications service point and the app version', () => {
  const info = buildNotificationServiceInfoPlist({ displayName: 'Happier', version: '3.4.5', buildNumber: '77' });
  assert.equal(info.NSExtension.NSExtensionPointIdentifier, EXTENSION_POINT_IDENTIFIER);
  assert.match(info.NSExtension.NSExtensionPrincipalClass, /HappierActivityNotificationService$/);
  assert.equal(info.CFBundleShortVersionString, '3.4.5');
  assert.equal(info.CFBundleVersion, '77');
});

test('the containing application is entitled to the exact App Group shared with the extension', () => {
  const entitlements = {
    'com.apple.security.application-groups': ['group.existing.shared'],
  };
  ensureApplicationAppGroupEntitlement(entitlements, 'dev.happier.app');
  assert.deepEqual(entitlements['com.apple.security.application-groups'], [
    'group.existing.shared',
    'group.dev.happier.app',
  ]);
  ensureApplicationAppGroupEntitlement(entitlements, 'dev.happier.app');
  assert.equal(entitlements['com.apple.security.application-groups'].length, 2);
  assert.throws(() => ensureApplicationAppGroupEntitlement({}, undefined));
});

test('the containing application publishes the exact App Group used by the narrow prepared projection', () => {
  const info = { Existing: true };
  ensureApplicationAppGroupInfoPlist(info, 'dev.happier.app');
  assert.deepEqual(info, { Existing: true, AppGroup: 'group.dev.happier.app' });
  assert.throws(() => ensureApplicationAppGroupInfoPlist({}, undefined));
});
