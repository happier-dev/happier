import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  patchIosXcodeProjectsForSigningAndIdentity,
  repairDuplicateNamedIosTargets,
  repairDuplicateNamedIosTargetsInParsedXcodeProject,
} from './ios_xcodeproj_patch.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

async function withTempUiDir(t) {
  const uiDir = await mkdtemp(join(tmpdir(), 'hstack-mobile-'));
  await mkdir(join(uiDir, 'node_modules'), { recursive: true });
  try {
    await symlink(
      join(repoRoot, 'apps', 'ui', 'node_modules', 'xcode'),
      join(uiDir, 'node_modules', 'xcode'),
      'dir',
    );
  } catch {
    // Tests that exercise parsed Xcode behavior will fail with a clear module-resolution error if xcode is absent.
  }
  t.after(async () => {
    await rm(uiDir, { recursive: true, force: true });
  });
  return uiDir;
}

async function writeMinimalIosProjectWithWidgetTarget({
  uiDir,
  appBundleIdentifier = 'old.app',
  appProductName = 'OldApp',
  widgetBundleIdentifier = 'old.app.ExpoWidgetsTarget',
  widgetProductName = '"$(TARGET_NAME)"',
} = {}) {
  const iosDir = join(uiDir, 'ios');
  await mkdir(join(iosDir, 'HappierPublicDevClient.xcodeproj'), { recursive: true });
  await mkdir(join(iosDir, 'HappierPublicDevClient'), { recursive: true });

  const pbxprojPath = join(iosDir, 'HappierPublicDevClient.xcodeproj', 'project.pbxproj');
  await writeFile(
    pbxprojPath,
    [
      '// !$*UTF8*$!',
      '{',
      '\tarchiveVersion = 1;',
      '\tclasses = {',
      '\t};',
      '\tobjectVersion = 54;',
      '\tobjects = {',
      '/* Begin PBXGroup section */',
      '\t\tMAIN_GROUP = { isa = PBXGroup; children = (); sourceTree = "<group>"; };',
      '\t\tPRODUCTS = { isa = PBXGroup; children = (); name = Products; sourceTree = "<group>"; };',
      '/* End PBXGroup section */',
      '/* Begin PBXNativeTarget section */',
      '\t\tAPP_TARGET /* HappierPublicDevClient */ = {',
      '\t\t\tisa = PBXNativeTarget;',
      '\t\t\tbuildConfigurationList = APP_CONFIG_LIST /* Build configuration list for PBXNativeTarget "HappierPublicDevClient" */;',
      '\t\t\tbuildPhases = ();',
      '\t\t\tbuildRules = ();',
      '\t\t\tdependencies = ();',
      '\t\t\tname = HappierPublicDevClient;',
      '\t\t\tproductName = HappierPublicDevClient;',
      '\t\t\tproductType = "com.apple.product-type.application";',
      '\t\t};',
      '\t\tWIDGET_TARGET /* ExpoWidgetsTarget */ = {',
      '\t\t\tisa = PBXNativeTarget;',
      '\t\t\tbuildConfigurationList = WIDGET_CONFIG_LIST /* Build configuration list for PBXNativeTarget "ExpoWidgetsTarget" */;',
      '\t\t\tbuildPhases = ();',
      '\t\t\tbuildRules = ();',
      '\t\t\tdependencies = ();',
      '\t\t\tname = ExpoWidgetsTarget;',
      '\t\t\tproductName = ExpoWidgetsTarget;',
      '\t\t\tproductType = "com.apple.product-type.app-extension";',
      '\t\t};',
      '/* End PBXNativeTarget section */',
      '/* Begin PBXProject section */',
      '\t\tPROJECT /* Project object */ = {',
      '\t\t\tisa = PBXProject;',
      '\t\t\tattributes = { TargetAttributes = { APP_TARGET = { DevelopmentTeam = OLDTEAM; }; WIDGET_TARGET = { DevelopmentTeam = OLDTEAM; }; }; };',
      '\t\t\tbuildConfigurationList = PROJECT_CONFIG_LIST /* Build configuration list for PBXProject "HappierPublicDevClient" */;',
      '\t\t\tcompatibilityVersion = "Xcode 3.2";',
      '\t\t\tdevelopmentRegion = en;',
      '\t\t\thasScannedForEncodings = 0;',
      '\t\t\tmainGroup = MAIN_GROUP;',
      '\t\t\tproductRefGroup = PRODUCTS;',
      '\t\t\tprojectDirPath = "";',
      '\t\t\tprojectRoot = "";',
      '\t\t\ttargets = ( APP_TARGET /* HappierPublicDevClient */, WIDGET_TARGET /* ExpoWidgetsTarget */, );',
      '\t\t};',
      '/* End PBXProject section */',
      '/* Begin XCBuildConfiguration section */',
      `\t\tAPP_DEBUG = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = ${appBundleIdentifier}; PRODUCT_NAME = ${appProductName}; DEVELOPMENT_TEAM = OLDTEAM; CODE_SIGN_IDENTITY = "Apple Development"; }; name = Debug; };`,
      `\t\tAPP_RELEASE = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = ${appBundleIdentifier}; PRODUCT_NAME = ${appProductName}; DEVELOPMENT_TEAM = OLDTEAM; }; name = Release; };`,
      `\t\tWIDGET_DEBUG = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = ${widgetBundleIdentifier}; PRODUCT_NAME = ${widgetProductName}; DEVELOPMENT_TEAM = OLDTEAM; }; name = Debug; };`,
      `\t\tWIDGET_RELEASE = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = ${widgetBundleIdentifier}; PRODUCT_NAME = ${widgetProductName}; DEVELOPMENT_TEAM = OLDTEAM; }; name = Release; };`,
      '/* End XCBuildConfiguration section */',
      '/* Begin XCConfigurationList section */',
      '\t\tAPP_CONFIG_LIST /* Build configuration list for PBXNativeTarget "HappierPublicDevClient" */ = { isa = XCConfigurationList; buildConfigurations = (APP_DEBUG, APP_RELEASE,); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };',
      '\t\tWIDGET_CONFIG_LIST /* Build configuration list for PBXNativeTarget "ExpoWidgetsTarget" */ = { isa = XCConfigurationList; buildConfigurations = (WIDGET_DEBUG, WIDGET_RELEASE,); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };',
      '\t\tPROJECT_CONFIG_LIST = { isa = XCConfigurationList; buildConfigurations = (); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };',
      '/* End XCConfigurationList section */',
      '\t};',
      '\trootObject = PROJECT /* Project object */;',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await writeFile(
    join(iosDir, 'HappierPublicDevClient', 'Info.plist'),
    '<key>CFBundleDisplayName</key><string>Happier</string>\n',
    'utf-8'
  );

  return pbxprojPath;
}

test('patchIosXcodeProjectsForSigningAndIdentity patches legacy ios/Happy.xcodeproj + ios/Happy/Info.plist', async (t) => {
  const uiDir = await withTempUiDir(t);
  const iosDir = join(uiDir, 'ios');
  await mkdir(join(iosDir, 'Happy.xcodeproj'), { recursive: true });
  await mkdir(join(iosDir, 'Happy'), { recursive: true });

  const pbxprojPath = join(iosDir, 'Happy.xcodeproj', 'project.pbxproj');
  await writeFile(
    pbxprojPath,
    [
      'ProvisioningStyle = Automatic;',
      'DEVELOPMENT_TEAM = 3RSYVV66F6;',
      'CODE_SIGN_IDENTITY = "Apple Development";',
      '"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "iPhone Developer";',
      'PROVISIONING_PROFILE_SPECIFIER = some-profile;',
      'PRODUCT_BUNDLE_IDENTIFIER = dev.happier.app;',
      'PRODUCT_NAME = Happy;',
      '',
    ].join('\n'),
    'utf-8'
  );

  const infoPlistPath = join(iosDir, 'Happy', 'Info.plist');
  await writeFile(
    infoPlistPath,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleDisplayName</key><string>Happy</string>',
      '</dict></plist>',
      '',
    ].join('\n'),
    'utf-8'
  );

  await patchIosXcodeProjectsForSigningAndIdentity({
    uiDir,
    iosBundleId: 'dev.happier.stack.stack.user.pre-pr272',
    iosAppName: 'HAPPY LEGACY',
  });

  const pbxproj = await readFile(pbxprojPath, 'utf-8');
  assert.match(pbxproj, /PRODUCT_BUNDLE_IDENTIFIER = dev\.happier\.stack\.stack\.user\.pre-pr272;/);
  assert.doesNotMatch(pbxproj, /DEVELOPMENT_TEAM\s*=/);
  assert.doesNotMatch(pbxproj, /PROVISIONING_PROFILE_SPECIFIER\s*=/);
  assert.doesNotMatch(pbxproj, /CODE_SIGN_IDENTITY\s*=/);
  assert.match(pbxproj, /PRODUCT_NAME = HAPPY-LEGACY;/);

  const plist = await readFile(infoPlistPath, 'utf-8');
  assert.match(plist, /<key>CFBundleDisplayName<\/key><string>HAPPY LEGACY<\/string>/);
});

test('patchIosXcodeProjectsForSigningAndIdentity patches both Happydev + Happy projects when present', async (t) => {
  const uiDir = await withTempUiDir(t);
  const iosDir = join(uiDir, 'ios');

  await mkdir(join(iosDir, 'Happy.xcodeproj'), { recursive: true });
  await mkdir(join(iosDir, 'Happy'), { recursive: true });
  await writeFile(join(iosDir, 'Happy.xcodeproj', 'project.pbxproj'), 'PRODUCT_BUNDLE_IDENTIFIER = dev.happier.app;\n', 'utf-8');
  await writeFile(join(iosDir, 'Happy', 'Info.plist'), '<key>CFBundleDisplayName</key><string>Happy</string>\n', 'utf-8');

  await mkdir(join(iosDir, 'Happydev.xcodeproj'), { recursive: true });
  await mkdir(join(iosDir, 'Happydev'), { recursive: true });
  await writeFile(join(iosDir, 'Happydev.xcodeproj', 'project.pbxproj'), 'PRODUCT_BUNDLE_IDENTIFIER = dev.happier.app.dev.internal;\n', 'utf-8');
  await writeFile(join(iosDir, 'Happydev', 'Info.plist'), '<key>CFBundleDisplayName</key><string>Happy (dev)</string>\n', 'utf-8');

  await patchIosXcodeProjectsForSigningAndIdentity({
    uiDir,
    iosBundleId: 'dev.happier.stack.stack.user.pre-pr272',
    iosAppName: 'HAPPY LEGACY',
  });

  const pbxprojRelease = await readFile(join(iosDir, 'Happy.xcodeproj', 'project.pbxproj'), 'utf-8');
  assert.match(pbxprojRelease, /PRODUCT_BUNDLE_IDENTIFIER = dev\.happier\.stack\.stack\.user\.pre-pr272;/);

  const pbxprojDev = await readFile(join(iosDir, 'Happydev.xcodeproj', 'project.pbxproj'), 'utf-8');
  assert.match(pbxprojDev, /PRODUCT_BUNDLE_IDENTIFIER = dev\.happier\.stack\.stack\.user\.pre-pr272;/);
});

test('patchIosXcodeProjectsForSigningAndIdentity patches generated Happier app projects', async (t) => {
  const uiDir = await withTempUiDir(t);
  const iosDir = join(uiDir, 'ios');
  await mkdir(join(iosDir, 'Happierinternaldev.xcodeproj'), { recursive: true });
  await mkdir(join(iosDir, 'Happierinternaldev'), { recursive: true });

  const pbxprojPath = join(iosDir, 'Happierinternaldev.xcodeproj', 'project.pbxproj');
  await writeFile(
    pbxprojPath,
    [
      'DevelopmentTeam = L86V3EF623;',
      'ProvisioningStyle = Automatic;',
      'CODE_SIGN_IDENTITY = "Apple Development";',
      'DEVELOPMENT_TEAM = L86V3EF623;',
      'PRODUCT_BUNDLE_IDENTIFIER = "dev.happier.app.dev.internal";',
      'PRODUCT_NAME = Happierinternaldev;',
      '',
    ].join('\n'),
    'utf-8'
  );

  const infoPlistPath = join(iosDir, 'Happierinternaldev', 'Info.plist');
  await writeFile(infoPlistPath, '<key>CFBundleDisplayName</key><string>Happier</string>\n', 'utf-8');

  await patchIosXcodeProjectsForSigningAndIdentity({
    uiDir,
    iosBundleId: 'dev.happier.app.dev.remotedev-devclient',
    iosAppName: 'Happier (remote-dev)',
  });

  const pbxproj = await readFile(pbxprojPath, 'utf-8');
  assert.match(pbxproj, /PRODUCT_BUNDLE_IDENTIFIER = dev\.happier\.app\.dev\.remotedev-devclient;/);
  assert.doesNotMatch(pbxproj, /DevelopmentTeam\s*=/);
  assert.doesNotMatch(pbxproj, /DEVELOPMENT_TEAM\s*=/);
  assert.doesNotMatch(pbxproj, /CODE_SIGN_IDENTITY\s*=/);
  assert.match(pbxproj, /PRODUCT_NAME = Happier-remote-dev;/);

  const plist = await readFile(infoPlistPath, 'utf-8');
  assert.match(plist, /<key>CFBundleDisplayName<\/key><string>Happier \(remote-dev\)<\/string>/);
});

test('patchIosXcodeProjectsForSigningAndIdentity repairs a widget target identity that matches the app target', async (t) => {
  const uiDir = await withTempUiDir(t);
  const pbxprojPath = await writeMinimalIosProjectWithWidgetTarget({
    uiDir,
    widgetBundleIdentifier: 'old.app',
    widgetProductName: 'OldApp',
  });

  await patchIosXcodeProjectsForSigningAndIdentity({
    uiDir,
    iosBundleId: 'dev.happier.app.dev.internal.devclient',
    iosAppName: 'Happier (next dev)',
  });

  const pbxproj = await readFile(pbxprojPath, 'utf-8');
  assert.match(pbxproj, /APP_DEBUG[\s\S]*PRODUCT_BUNDLE_IDENTIFIER = dev\.happier\.app\.dev\.internal\.devclient;/);
  assert.match(pbxproj, /APP_DEBUG[\s\S]*PRODUCT_NAME = Happier-next-dev;/);
  assert.match(pbxproj, /WIDGET_DEBUG[\s\S]*PRODUCT_BUNDLE_IDENTIFIER = "dev\.happier\.app\.dev\.internal\.devclient\.ExpoWidgetsTarget";/);
  assert.match(pbxproj, /WIDGET_DEBUG[\s\S]*PRODUCT_NAME = "\$\(TARGET_NAME\)";/);
  assert.match(pbxproj, /WIDGET_RELEASE[\s\S]*PRODUCT_BUNDLE_IDENTIFIER = "dev\.happier\.app\.dev\.internal\.devclient\.ExpoWidgetsTarget";/);
  assert.match(pbxproj, /WIDGET_RELEASE[\s\S]*PRODUCT_NAME = "\$\(TARGET_NAME\)";/);
});

test('patchIosXcodeProjectsForSigningAndIdentity preserves an already distinct widget target identity', async (t) => {
  const uiDir = await withTempUiDir(t);
  const pbxprojPath = await writeMinimalIosProjectWithWidgetTarget({
    uiDir,
    widgetBundleIdentifier: 'custom.widgets.bundle',
    widgetProductName: 'CustomWidgets',
  });

  await patchIosXcodeProjectsForSigningAndIdentity({
    uiDir,
    iosBundleId: 'dev.happier.app.dev.internal.devclient',
    iosAppName: 'Happier (next dev)',
  });

  const pbxproj = await readFile(pbxprojPath, 'utf-8');
  assert.match(pbxproj, /APP_DEBUG[\s\S]*PRODUCT_BUNDLE_IDENTIFIER = dev\.happier\.app\.dev\.internal\.devclient;/);
  assert.match(pbxproj, /APP_DEBUG[\s\S]*PRODUCT_NAME = Happier-next-dev;/);
  assert.match(pbxproj, /WIDGET_DEBUG[\s\S]*PRODUCT_BUNDLE_IDENTIFIER = custom\.widgets\.bundle;/);
  assert.match(pbxproj, /WIDGET_DEBUG[\s\S]*PRODUCT_NAME = CustomWidgets;/);
  assert.match(pbxproj, /WIDGET_RELEASE[\s\S]*PRODUCT_BUNDLE_IDENTIFIER = custom\.widgets\.bundle;/);
  assert.match(pbxproj, /WIDGET_RELEASE[\s\S]*PRODUCT_NAME = CustomWidgets;/);
});

test('patchIosXcodeProjectsForSigningAndIdentity tolerates missing Info.plist and leaves pre-patched pbxproj unchanged', async (t) => {
  const uiDir = await withTempUiDir(t);
  const iosDir = join(uiDir, 'ios');
  await mkdir(join(iosDir, 'Happy.xcodeproj'), { recursive: true });
  const pbxprojPath = join(iosDir, 'Happy.xcodeproj', 'project.pbxproj');
  const prepatched = [
    'PRODUCT_BUNDLE_IDENTIFIER = dev.happier.stack.already.patched;',
    'PRODUCT_NAME = HAPPY-LEGACY;',
    '',
  ].join('\n');
  await writeFile(pbxprojPath, prepatched, 'utf-8');

  await patchIosXcodeProjectsForSigningAndIdentity({
    uiDir,
    iosBundleId: 'dev.happier.stack.already.patched',
    iosAppName: 'HAPPY LEGACY',
  });

  const next = await readFile(pbxprojPath, 'utf-8');
  assert.equal(next, prepatched);
});

test('patchIosXcodeProjectsForSigningAndIdentity is a no-op when no Happy*.xcodeproj exists', async (t) => {
  const uiDir = await withTempUiDir(t);
  await mkdir(join(uiDir, 'ios', 'Other.xcodeproj'), { recursive: true });
  await writeFile(join(uiDir, 'ios', 'Other.xcodeproj', 'project.pbxproj'), 'PRODUCT_BUNDLE_IDENTIFIER = keep.me;\n', 'utf-8');

  await patchIosXcodeProjectsForSigningAndIdentity({
    uiDir,
    iosBundleId: 'dev.happier.stack.noop',
    iosAppName: 'NOOP',
  });

  const next = await readFile(join(uiDir, 'ios', 'Other.xcodeproj', 'project.pbxproj'), 'utf-8');
  assert.equal(next, 'PRODUCT_BUNDLE_IDENTIFIER = keep.me;\n');
});

test('repairDuplicateNamedIosTargetsInParsedXcodeProject keeps one widget target and removes duplicate object references', () => {
  const project = {
    hash: {
      project: {
        objects: {
          PBXProject: {
            PROJECT: {
              targets: [
                { value: 'APP', comment: 'App' },
                { value: 'WIDGET_KEEP', comment: 'ExpoWidgetsTarget' },
                { value: 'WIDGET_REMOVE', comment: 'ExpoWidgetsTarget' },
              ],
              attributes: {
                TargetAttributes: {
                  WIDGET_KEEP: { ProvisioningStyle: 'Automatic' },
                  WIDGET_REMOVE: { ProvisioningStyle: 'Automatic' },
                },
              },
            },
          },
          PBXNativeTarget: {
            APP: {
              isa: 'PBXNativeTarget',
              name: 'App',
              buildPhases: [
                { value: 'APP_SOURCES', comment: 'Sources' },
                { value: 'EMBED_KEEP', comment: 'Embed Foundation Extensions' },
                { value: 'EMBED_REMOVE', comment: 'Embed Foundation Extensions' },
              ],
              dependencies: [
                { value: 'DEP_KEEP', comment: 'PBXTargetDependency' },
                { value: 'DEP_REMOVE', comment: 'PBXTargetDependency' },
              ],
            },
            WIDGET_KEEP: {
              isa: 'PBXNativeTarget',
              name: 'ExpoWidgetsTarget',
              productReference: 'PRODUCT_KEEP',
              buildConfigurationList: 'CONFIG_KEEP',
              buildPhases: [{ value: 'SOURCES_KEEP', comment: 'Sources' }],
              dependencies: [],
            },
            WIDGET_REMOVE: {
              isa: 'PBXNativeTarget',
              name: 'ExpoWidgetsTarget',
              productReference: 'PRODUCT_REMOVE',
              buildConfigurationList: 'CONFIG_REMOVE',
              buildPhases: [{ value: 'SOURCES_REMOVE', comment: 'Sources' }],
              dependencies: [],
            },
          },
          PBXGroup: {
            MAIN: {
              isa: 'PBXGroup',
              children: [
                { value: 'APP_GROUP', comment: 'App' },
                { value: 'WIDGET_GROUP_KEEP', comment: 'ExpoWidgetsTarget' },
                { value: 'WIDGET_GROUP_REMOVE', comment: 'ExpoWidgetsTarget' },
                { value: 'WIDGET_PROVIDER_GROUP', comment: 'ExpoWidgetsTarget' },
              ],
            },
            APP_GROUP: { isa: 'PBXGroup', name: 'App', children: [] },
            WIDGET_GROUP_KEEP: {
              isa: 'PBXGroup',
              path: 'ExpoWidgetsTarget',
              children: [{ value: 'SOURCE_KEEP', comment: 'index.swift' }],
            },
            WIDGET_GROUP_REMOVE: {
              isa: 'PBXGroup',
              name: 'ExpoWidgetsTarget',
              path: 'ExpoWidgetsTarget',
              children: [{ value: 'SOURCE_KEEP', comment: 'index.swift' }],
            },
            WIDGET_PROVIDER_GROUP: {
              isa: 'PBXGroup',
              name: 'ExpoWidgetsTarget',
              children: [{ value: 'PROVIDER_FILE', comment: 'ExpoModulesProvider.swift' }],
            },
          },
          PBXTargetDependency: {
            DEP_KEEP: { isa: 'PBXTargetDependency', target: 'WIDGET_KEEP', targetProxy: 'PROXY_KEEP' },
            DEP_REMOVE: { isa: 'PBXTargetDependency', target: 'WIDGET_REMOVE', targetProxy: 'PROXY_REMOVE' },
          },
          PBXContainerItemProxy: {
            PROXY_KEEP: { remoteGlobalIDString: 'WIDGET_KEEP' },
            PROXY_REMOVE: { remoteGlobalIDString: 'WIDGET_REMOVE' },
          },
          PBXCopyFilesBuildPhase: {
            EMBED_KEEP: {
              isa: 'PBXCopyFilesBuildPhase',
              name: 'Embed Foundation Extensions',
              files: [
                { value: 'BUILD_PRODUCT_KEEP', comment: 'ExpoWidgetsTarget.appex in Embed Foundation Extensions' },
                { value: 'BUILD_PRODUCT_REMOVE', comment: 'ExpoWidgetsTarget.appex in Embed Foundation Extensions' },
              ],
            },
            EMBED_REMOVE: {
              isa: 'PBXCopyFilesBuildPhase',
              name: 'Embed Foundation Extensions',
              files: [{ value: 'BUILD_PRODUCT_REMOVE', comment: 'ExpoWidgetsTarget.appex in Embed Foundation Extensions' }],
            },
          },
          PBXSourcesBuildPhase: {
            APP_SOURCES: { isa: 'PBXSourcesBuildPhase', files: [] },
            SOURCES_KEEP: { isa: 'PBXSourcesBuildPhase', files: [{ value: 'BUILD_SOURCE_KEEP', comment: 'index.swift in Sources' }] },
            SOURCES_REMOVE: { isa: 'PBXSourcesBuildPhase', files: [{ value: 'BUILD_SOURCE_REMOVE', comment: 'index.swift in Sources' }] },
          },
          PBXBuildFile: {
            BUILD_PRODUCT_KEEP: { isa: 'PBXBuildFile', fileRef: 'PRODUCT_KEEP' },
            BUILD_PRODUCT_REMOVE: { isa: 'PBXBuildFile', fileRef: 'PRODUCT_REMOVE' },
            BUILD_SOURCE_KEEP: { isa: 'PBXBuildFile', fileRef: 'SOURCE_KEEP' },
            BUILD_SOURCE_REMOVE: { isa: 'PBXBuildFile', fileRef: 'SOURCE_REMOVE' },
          },
          PBXFileReference: {
            PRODUCT_KEEP: { path: 'ExpoWidgetsTarget.appex' },
            PRODUCT_REMOVE: { path: 'ExpoWidgetsTarget.appex' },
            SOURCE_KEEP: { path: 'index.swift' },
            PROVIDER_FILE: { path: 'ExpoModulesProvider.swift' },
          },
          XCConfigurationList: {
            CONFIG_KEEP: {
              buildConfigurations: [{ value: 'DEBUG_KEEP', comment: 'Debug' }],
            },
            CONFIG_REMOVE: {
              buildConfigurations: [{ value: 'DEBUG_REMOVE', comment: 'Debug' }],
            },
          },
          XCBuildConfiguration: {
            DEBUG_KEEP: { name: 'Debug' },
            DEBUG_REMOVE: { name: 'Debug' },
          },
        },
      },
    },
  };

  const result = repairDuplicateNamedIosTargetsInParsedXcodeProject(project, {
    targetName: 'ExpoWidgetsTarget',
  });

  assert.equal(result.repaired, true);
  assert.equal(result.removedTargetCount, 1);
  assert.deepEqual(
    project.hash.project.objects.PBXProject.PROJECT.targets.map((entry) => entry.value),
    ['APP', 'WIDGET_KEEP'],
  );
  assert.deepEqual(
    project.hash.project.objects.PBXNativeTarget.APP.dependencies.map((entry) => entry.value),
    ['DEP_KEEP'],
  );
  assert.deepEqual(
    project.hash.project.objects.PBXNativeTarget.APP.buildPhases.map((entry) => entry.value),
    ['APP_SOURCES', 'EMBED_KEEP'],
  );
  assert.deepEqual(
    project.hash.project.objects.PBXCopyFilesBuildPhase.EMBED_KEEP.files.map((entry) => entry.value),
    ['BUILD_PRODUCT_KEEP'],
  );
  assert.deepEqual(
    project.hash.project.objects.PBXGroup.MAIN.children.map((entry) => entry.value),
    ['APP_GROUP', 'WIDGET_GROUP_KEEP', 'WIDGET_PROVIDER_GROUP'],
  );
  assert.equal(project.hash.project.objects.PBXNativeTarget.WIDGET_REMOVE, undefined);
  assert.equal(project.hash.project.objects.PBXGroup.WIDGET_GROUP_REMOVE, undefined);
  assert.equal(project.hash.project.objects.PBXSourcesBuildPhase.SOURCES_REMOVE, undefined);
  assert.equal(project.hash.project.objects.PBXBuildFile.BUILD_PRODUCT_REMOVE, undefined);
  assert.equal(project.hash.project.objects.PBXBuildFile.BUILD_SOURCE_REMOVE, undefined);
  assert.equal(project.hash.project.objects.PBXFileReference.PRODUCT_REMOVE, undefined);
  assert.equal(project.hash.project.objects.XCConfigurationList.CONFIG_REMOVE, undefined);
  assert.equal(project.hash.project.objects.XCBuildConfiguration.DEBUG_REMOVE, undefined);
  assert.equal(project.hash.project.objects.PBXTargetDependency.DEP_REMOVE, undefined);
  assert.equal(project.hash.project.objects.PBXContainerItemProxy.PROXY_REMOVE, undefined);
  assert.equal(project.hash.project.objects.PBXProject.PROJECT.attributes.TargetAttributes.WIDGET_REMOVE, undefined);
});

test('repairDuplicateNamedIosTargets resolves xcode from app-local node_modules', async (t) => {
  const uiDir = await withTempUiDir(t);
  await writeMinimalIosProjectWithWidgetTarget({ uiDir });
  await writeFile(join(uiDir, 'package.json'), '{}\n', 'utf-8');

  const results = await repairDuplicateNamedIosTargets({
    uiDir,
    targetName: 'ExpoWidgetsTarget',
  });

  assert.deepEqual(results, []);
});

test('repairDuplicateNamedIosTargetsInParsedXcodeProject repairs duplicate widget groups when target is already unique', () => {
  const project = {
    hash: {
      project: {
        objects: {
          PBXNativeTarget: {
            WIDGET_KEEP: {
              isa: 'PBXNativeTarget',
              name: 'ExpoWidgetsTarget',
              productReference: 'PRODUCT_KEEP',
              buildPhases: [],
            },
          },
          PBXGroup: {
            MAIN: {
              isa: 'PBXGroup',
              children: [
                { value: 'WIDGET_GROUP_KEEP', comment: 'ExpoWidgetsTarget' },
                { value: 'WIDGET_GROUP_REMOVE', comment: 'ExpoWidgetsTarget' },
              ],
            },
            WIDGET_GROUP_KEEP: {
              isa: 'PBXGroup',
              path: 'ExpoWidgetsTarget',
              children: [{ value: 'SOURCE_KEEP', comment: 'index.swift' }],
            },
            WIDGET_GROUP_REMOVE: {
              isa: 'PBXGroup',
              path: 'ExpoWidgetsTarget',
              children: [{ value: 'SOURCE_KEEP', comment: 'index.swift' }],
            },
          },
        },
      },
    },
  };

  const result = repairDuplicateNamedIosTargetsInParsedXcodeProject(project, {
    targetName: 'ExpoWidgetsTarget',
  });

  assert.equal(result.repaired, true);
  assert.equal(result.removedTargetCount, 0);
  assert.deepEqual(
    project.hash.project.objects.PBXGroup.MAIN.children.map((entry) => entry.value),
    ['WIDGET_GROUP_KEEP'],
  );
  assert.equal(project.hash.project.objects.PBXGroup.WIDGET_GROUP_REMOVE, undefined);
});
