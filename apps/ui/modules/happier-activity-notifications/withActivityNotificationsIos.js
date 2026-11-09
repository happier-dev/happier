const fs = require('node:fs');
const path = require('node:path');
const plist = require('@expo/plist').default;
const { withDangerousMod, withEntitlementsPlist, withInfoPlist, withXcodeProject } = require('@expo/config-plugins');

const TARGET_NAME = 'HappierActivityNotificationService';
const SOURCE_FILE_NAME = 'HappierActivityNotificationService.swift';
const INFO_PLIST_NAME = `${TARGET_NAME}-Info.plist`;
const PRINCIPAL_CLASS = '$(PRODUCT_MODULE_NAME).HappierActivityNotificationService';
const EXTENSION_POINT_IDENTIFIER = 'com.apple.usernotifications.service';
// The extension links no pods, so the vocabulary it shares with the app module is
// shared by source rather than by a linked framework.
const SHARED_SOURCE_FILE_NAME = 'ActivityNotificationEvents.swift';
const PREPARED_CONTEXT_SOURCE_FILE_NAME = 'ActivityPreparedContext.swift';
const STORAGE_LOCATION_SOURCE_FILE_NAME = 'ActivityNotificationStorageLocation.swift';
const ENRICHER_SOURCE_FILE_NAME = 'ActivityNotificationEnricher.swift';
const CRYPTO_SOURCE_FILE_NAMES = [
  'HappierCryptoWorkerBase64.swift',
  'HappierCryptoWorkerAesGcm.swift',
  'HappierCryptoWorkerDataKeyEnvelope.swift',
  'HappierCryptoWorkerSecretbox.swift',
  'HappierCryptoWorkerSessionCrypto.swift',
];
const TARGET_SOURCE_FILE_NAMES = [SHARED_SOURCE_FILE_NAME, PREPARED_CONTEXT_SOURCE_FILE_NAME, STORAGE_LOCATION_SOURCE_FILE_NAME, ENRICHER_SOURCE_FILE_NAME, ...CRYPTO_SOURCE_FILE_NAMES, SOURCE_FILE_NAME];
const CRYPTO_WORKER_IOS_ROOT = path.join(__dirname, '..', 'happier-crypto-worker', 'ios');
const MODULE_SOURCE_PATHS = {
  [SHARED_SOURCE_FILE_NAME]: path.join(__dirname, 'ios', SHARED_SOURCE_FILE_NAME),
  [PREPARED_CONTEXT_SOURCE_FILE_NAME]: path.join(__dirname, 'ios', PREPARED_CONTEXT_SOURCE_FILE_NAME),
  [STORAGE_LOCATION_SOURCE_FILE_NAME]: path.join(__dirname, 'ios', STORAGE_LOCATION_SOURCE_FILE_NAME),
  [ENRICHER_SOURCE_FILE_NAME]: path.join(__dirname, 'ios', ENRICHER_SOURCE_FILE_NAME),
  ...Object.fromEntries(CRYPTO_SOURCE_FILE_NAMES.map((name) => [name, path.join(CRYPTO_WORKER_IOS_ROOT, name)])),
  [SOURCE_FILE_NAME]: path.join(__dirname, 'ios', 'notificationService', SOURCE_FILE_NAME),
};

function notificationServiceBundleIdentifier(appBundleIdentifier) {
  if (!appBundleIdentifier) throw new Error('Activity notifications require an iOS bundle identifier.');
  return `${appBundleIdentifier}.ActivityNotificationService`;
}

function ensureApplicationAppGroupEntitlement(entitlements, appBundleIdentifier) {
  if (!appBundleIdentifier) throw new Error('Activity notifications require an iOS bundle identifier.');
  const key = 'com.apple.security.application-groups';
  const appGroup = `group.${appBundleIdentifier}`;
  const current = Array.isArray(entitlements[key])
    ? entitlements[key].filter((value) => typeof value === 'string')
    : [];
  entitlements[key] = current.includes(appGroup) ? current : [...current, appGroup];
  return entitlements;
}

function ensureApplicationAppGroupInfoPlist(info, appBundleIdentifier) {
  if (!appBundleIdentifier) throw new Error('Activity notifications require an iOS bundle identifier.');
  info.AppGroup = `group.${appBundleIdentifier}`;
  return info;
}

// The alert consumer runs in its own extension process, so the OS validates its
// version against the app it is embedded in. Both values come from the app's own
// canonical Expo config rather than a second version source.
function buildNotificationServiceInfoPlist({ displayName, version, buildNumber, appGroup }) {
  return {
    CFBundleName: '$(PRODUCT_NAME)',
    CFBundleDisplayName: displayName || TARGET_NAME,
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleExecutable: '$(EXECUTABLE_NAME)',
    CFBundlePackageType: '$(PRODUCT_BUNDLE_PACKAGE_TYPE)',
    CFBundleShortVersionString: version || '1.0.0',
    CFBundleVersion: buildNumber || '1',
    AppGroup: appGroup,
    NSExtension: {
      NSExtensionPointIdentifier: EXTENSION_POINT_IDENTIFIER,
      NSExtensionPrincipalClass: PRINCIPAL_CLASS,
    },
  };
}

function unquote(value) {
  return typeof value === 'string' ? value.replace(/^"|"$/g, '') : value;
}

// `addTarget` stores quoted names, so the incumbent `pbxTargetByName` lookup
// cannot find a target this plugin created on an earlier prebuild. Matching the
// unquoted name is what keeps repeated prebuilds idempotent.
function findTargetByName(project, name) {
  const targets = project.hash.project.objects.PBXNativeTarget || {};
  for (const [key, value] of Object.entries(targets)) {
    if (key.endsWith('_comment') || !value || typeof value !== 'object') continue;
    if (unquote(value.name) === name) return { uuid: key, pbxNativeTarget: value };
  }
  return null;
}

function targetBuildConfigurations(project, target) {
  const lists = project.pbxXCConfigurationList();
  const configurations = project.pbxXCBuildConfigurationSection();
  const list = lists[target.pbxNativeTarget.buildConfigurationList];
  if (!list) return [];
  return list.buildConfigurations
    .map((entry) => configurations[entry.value])
    .filter((configuration) => configuration && configuration.buildSettings);
}

function configureTargetBuild(project, target, settings) {
  for (const configuration of targetBuildConfigurations(project, target)) {
    Object.assign(configuration.buildSettings, settings);
  }
  // The containing app resolves the embedded product from its own products
  // directory, while this extension builds in a target-specific subdirectory.
  project.pbxFileReferenceSection()[target.pbxNativeTarget.productReference].path = `"${TARGET_NAME}/${TARGET_NAME}.appex"`;
}

function addMissingCryptoSources(project, targetUuid) {
  // `addSourceFile` defaults to the legacy Plugins group and crashes for a
  // minimal/generated project without that optional group. The file's PBX
  // group is presentation-only; its owning target remains the Sources phase.
  const group = project.findPBXGroupKey({ name: 'Resources' })
    || project.getFirstProject().firstProject.mainGroup;
  for (const name of CRYPTO_SOURCE_FILE_NAMES) {
    project.addSourceFile(`${TARGET_NAME}/${name}`, { target: targetUuid }, group);
  }
}

function sessionCryptoFrameworkPath(projectRoot, platformProjectRoot) {
  const packageRoot = path.dirname(require.resolve('@more-tech/react-native-libsodium/package.json', { paths: [projectRoot] }));
  const frameworkPath = path.join(packageRoot, 'libsodium', 'build', 'libsodium-apple', 'Clibsodium.xcframework');
  if (!fs.existsSync(frameworkPath)) {
    throw new Error(`Activity notifications require the libsodium XCFramework at ${frameworkPath}. Rebuild @more-tech/react-native-libsodium before iOS prebuild.`);
  }
  // Custom frameworks are project-relative, just like this target's sources.
  // Resolve from the app, not an assumed package-manager node_modules layout.
  return path.relative(platformProjectRoot, frameworkPath).split(path.sep).join('/');
}

function addSessionCryptoFramework(project, targetUuid, frameworkPath) {
  const existing = Object.values(project.pbxFileReferenceSection()).find((file) =>
    file && typeof file === 'object' && path.basename(unquote(file.path) || '') === 'Clibsodium.xcframework');
  if (existing && unquote(existing.path) !== frameworkPath) {
    project.removeFramework(unquote(existing.path), { customFramework: true, embed: false, target: targetUuid });
  }
  project.addFramework(frameworkPath, {
    customFramework: true,
    embed: false,
    lastKnownFileType: 'wrapper.xcframework',
    link: true,
    target: targetUuid,
  });
}

/**
 * Adds the notification service extension target to the generated Xcode project.
 *
 * The extension links no pods: it stays a Foundation/UserNotifications consumer so
 * the app process, its pods and its React runtime are never loaded to present one
 * bounded alert. Repeated prebuilds converge on the same single target.
 */
function configureNotificationServiceTarget(project, options) {
  const {
    appBundleIdentifier,
    deploymentTarget = '16.0',
    swiftVersion = '5.9',
    projectRoot,
    platformProjectRoot,
  } = options;
  const bundleIdentifier = notificationServiceBundleIdentifier(appBundleIdentifier);
  const frameworkPath = sessionCryptoFrameworkPath(projectRoot, platformProjectRoot);
  const appGroup = `group.${appBundleIdentifier}`;
  const settings = {
    PRODUCT_BUNDLE_IDENTIFIER: `"${bundleIdentifier}"`,
    INFOPLIST_FILE: `"${TARGET_NAME}/${INFO_PLIST_NAME}"`,
    IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget,
    SWIFT_VERSION: swiftVersion,
    TARGETED_DEVICE_FAMILY: '"1,2"',
    CODE_SIGN_STYLE: 'Automatic',
    CODE_SIGN_ENTITLEMENTS: `"${TARGET_NAME}/${TARGET_NAME}.entitlements"`,
    CLANG_ENABLE_MODULES: 'YES',
    SKIP_INSTALL: 'YES',
    // Xcode unpacks static XCFramework headers under CONFIGURATION_BUILD_DIR.
    // Keep this copy of Clibsodium out of the app's CocoaPods header search path.
    CONFIGURATION_BUILD_DIR: '"$(BUILD_DIR)/$(CONFIGURATION)$(EFFECTIVE_PLATFORM_NAME)/$(TARGET_NAME)"',
    BUILT_PRODUCTS_DIR: '"$(CONFIGURATION_BUILD_DIR)"',
  };

  const existing = findTargetByName(project, TARGET_NAME);
  if (existing) {
    configureTargetBuild(project, existing, settings);
    addMissingCryptoSources(project, existing.uuid);
    addSessionCryptoFramework(project, existing.uuid, frameworkPath);
    return project;
  }

  // `addTarget` records the app's explicit dependency on the extension only when
  // both sections already exist; without it the extension can be embedded without
  // ever being built.
  for (const section of ['PBXTargetDependency', 'PBXContainerItemProxy']) {
    project.hash.project.objects[section] = project.hash.project.objects[section] || {};
  }
  const target = project.addTarget(TARGET_NAME, 'app_extension', TARGET_NAME, bundleIdentifier);
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
  project.addBuildPhase(
    TARGET_SOURCE_FILE_NAMES.map((name) => `${TARGET_NAME}/${name}`),
    'PBXSourcesBuildPhase',
    'Sources',
    target.uuid,
  );
  addSessionCryptoFramework(project, target.uuid, frameworkPath);
  configureTargetBuild(project, target, settings);
  return project;
}

function withNotificationServiceSources(config) {
  return withDangerousMod(config, ['ios', (mod) => {
    const targetRoot = path.join(mod.modRequest.platformProjectRoot, TARGET_NAME);
    fs.mkdirSync(targetRoot, { recursive: true });
    for (const name of TARGET_SOURCE_FILE_NAMES) {
      fs.copyFileSync(MODULE_SOURCE_PATHS[name], path.join(targetRoot, name));
    }
    fs.writeFileSync(
      path.join(targetRoot, INFO_PLIST_NAME),
      plist.build(buildNotificationServiceInfoPlist({
        displayName: mod.name,
        version: mod.version,
        buildNumber: mod.ios?.buildNumber,
        appGroup: `group.${mod.ios?.bundleIdentifier}`,
      })),
    );
    fs.writeFileSync(
      path.join(targetRoot, `${TARGET_NAME}.entitlements`),
      plist.build({ 'com.apple.security.application-groups': [`group.${mod.ios?.bundleIdentifier}`] }),
    );
    return mod;
  }]);
}

function withActivityNotificationsIos(config) {
  const withAppGroup = withEntitlementsPlist(config, (mod) => {
    ensureApplicationAppGroupEntitlement(mod.modResults, mod.ios?.bundleIdentifier);
    return mod;
  });
  const withAppGroupInfo = withInfoPlist(withAppGroup, (mod) => {
    ensureApplicationAppGroupInfoPlist(mod.modResults, mod.ios?.bundleIdentifier);
    return mod;
  });
  const withSources = withNotificationServiceSources(withAppGroupInfo);
  return withXcodeProject(withSources, (mod) => {
    configureNotificationServiceTarget(mod.modResults, {
      appBundleIdentifier: mod.ios?.bundleIdentifier,
      deploymentTarget: mod.ios?.deploymentTarget,
      projectRoot: mod.modRequest.projectRoot,
      platformProjectRoot: mod.modRequest.platformProjectRoot,
    });
    return mod;
  });
}

module.exports = withActivityNotificationsIos;
module.exports.TARGET_NAME = TARGET_NAME;
module.exports.CRYPTO_SOURCE_FILE_NAMES = CRYPTO_SOURCE_FILE_NAMES;
module.exports.SOURCE_FILE_NAME = SOURCE_FILE_NAME;
module.exports.TARGET_SOURCE_FILE_NAMES = TARGET_SOURCE_FILE_NAMES;
module.exports.INFO_PLIST_NAME = INFO_PLIST_NAME;
module.exports.EXTENSION_POINT_IDENTIFIER = EXTENSION_POINT_IDENTIFIER;
module.exports.buildNotificationServiceInfoPlist = buildNotificationServiceInfoPlist;
module.exports.configureNotificationServiceTarget = configureNotificationServiceTarget;
module.exports.ensureApplicationAppGroupEntitlement = ensureApplicationAppGroupEntitlement;
module.exports.ensureApplicationAppGroupInfoPlist = ensureApplicationAppGroupInfoPlist;
module.exports.notificationServiceBundleIdentifier = notificationServiceBundleIdentifier;
