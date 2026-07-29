import { spawnSync } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_GENERATED_TARGET_NAME = 'ExpoWidgetsTarget';
export const DEFAULT_GENERATED_WIDGET_NAMES = [
  'HappierFocusWidget',
  'HappierSessionsWidget',
  'HappierFocusLiveActivity',
];

async function assertReadableFile(filePath) {
  await access(filePath, fsConstants.R_OK);
  return filePath;
}

function ensurePattern(text, pattern, message) {
  if (!pattern.test(text)) {
    throw new Error(message);
  }
}

async function resolveGeneratedProjectPaths({
  iosDir,
  targetName = DEFAULT_GENERATED_TARGET_NAME,
}) {
  const entries = await readdir(iosDir, { withFileTypes: true });
  const projectEntry = entries.find(
    (entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj') && entry.name !== 'Pods.xcodeproj',
  );

  if (!projectEntry) {
    throw new Error(`Unable to find generated iOS Xcode project in '${iosDir}'.`);
  }

  const xcodeprojPath = join(iosDir, projectEntry.name);
  const pbxprojPath = join(xcodeprojPath, 'project.pbxproj');
  const podfilePath = join(iosDir, 'Podfile');
  const targetDir = join(iosDir, targetName);
  const infoPlistPath = join(targetDir, 'Info.plist');

  await Promise.all([
    assertReadableFile(pbxprojPath),
    assertReadableFile(podfilePath),
    assertReadableFile(infoPlistPath),
  ]);

  return {
    xcodeprojPath,
    pbxprojPath,
    podfilePath,
    targetDir,
    infoPlistPath,
  };
}

function assertXcodebuildOutput(output, targetName) {
  ensurePattern(
    output,
    new RegExp(`\\b${targetName}\\b`),
    `xcodebuild did not report generated target '${targetName}'.`,
  );
}

function collectProductBundleIdentifiers(pbxprojRaw) {
  return [...pbxprojRaw.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?(?<bundleIdentifier>[^";\n]+)"?;/g)]
    .map((match) => match.groups?.bundleIdentifier?.trim() ?? '')
    .filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectPbxObjects(pbxprojRaw) {
  const lines = pbxprojRaw.split(/\r?\n/);
  const objects = [];

  for (let index = 0; index < lines.length; index += 1) {
    const startMatch = lines[index].match(
      /^\s*(?<id>[A-Fa-f0-9]{24}) \/\* (?<label>.*?) \*\/ = \{(?<rest>.*)$/,
    );
    if (!startMatch?.groups) continue;

    const bodyLines = [startMatch.groups.rest];
    if (!startMatch.groups.rest.trim().endsWith('};')) {
      for (index += 1; index < lines.length; index += 1) {
        bodyLines.push(lines[index]);
        if (/^\s*\};\s*$/.test(lines[index])) break;
      }
    }

    const body = bodyLines.join('\n');
    const isa = body.match(/\bisa\s*=\s*(?<isa>[A-Za-z0-9_]+);/)?.groups?.isa ?? '';
    objects.push({
      id: startMatch.groups.id,
      label: startMatch.groups.label,
      body,
      isa,
    });
  }

  return objects;
}

function pbxFieldEquals(body, fieldName, value) {
  return new RegExp(`\\b${escapeRegExp(fieldName)}\\s*=\\s*"?${escapeRegExp(value)}"?;`).test(body);
}

function assertExactlyOnePbxObject({ objects, isa, description }) {
  if (objects.length !== 1) {
    const ids = objects.map((object) => object.id).join(',') || 'none';
    throw new Error(
      `Generated Xcode project must contain exactly one ${isa} for ${description}; found ${objects.length}: ${ids}.`,
    );
  }
}

function assertUniqueWidgetTargetGraph(pbxprojRaw, targetName) {
  const objects = collectPbxObjects(pbxprojRaw);
  const nativeTargets = objects.filter(
    (object) =>
      object.isa === 'PBXNativeTarget' &&
      pbxFieldEquals(object.body, 'name', targetName) &&
      pbxFieldEquals(object.body, 'productType', 'com.apple.product-type.app-extension'),
  );
  const productReferences = objects.filter(
    (object) =>
      object.isa === 'PBXFileReference' &&
      object.label === `${targetName}.appex` &&
      pbxFieldEquals(object.body, 'path', `${targetName}.appex`) &&
      /wrapper\.app-extension/.test(object.body),
  );
  const embedBuildFiles = objects.filter(
    (object) =>
      object.isa === 'PBXBuildFile' &&
      object.label === `${targetName}.appex in Embed Foundation Extensions`,
  );

  assertExactlyOnePbxObject({
    objects: nativeTargets,
    isa: 'PBXNativeTarget',
    description: `widget target '${targetName}'`,
  });
  assertExactlyOnePbxObject({
    objects: productReferences,
    isa: 'PBXFileReference',
    description: `widget product '${targetName}.appex'`,
  });
  assertExactlyOnePbxObject({
    objects: embedBuildFiles,
    isa: 'PBXBuildFile',
    description: `embedded widget product '${targetName}.appex'`,
  });
}

function resolveWidgetBundleIdentifier(pbxprojRaw, targetName) {
  const bundleIdentifiers = collectProductBundleIdentifiers(pbxprojRaw);
  const widgetBundleIdentifiers = bundleIdentifiers.filter((bundleIdentifier) =>
    bundleIdentifier.endsWith(`.${targetName}`),
  );
  const appBundleIdentifiers = bundleIdentifiers.filter((bundleIdentifier) =>
    !bundleIdentifier.endsWith(`.${targetName}`),
  );

  if (widgetBundleIdentifiers.length === 0) {
    throw new Error(`Generated Xcode project is missing the widget target PRODUCT_BUNDLE_IDENTIFIER for '${targetName}'.`);
  }

  const prefixedWidgetBundleIdentifier = widgetBundleIdentifiers.find((widgetBundleIdentifier) =>
    appBundleIdentifiers.some((appBundleIdentifier) =>
      widgetBundleIdentifier.startsWith(`${appBundleIdentifier}.`),
    ),
  );

  if (!prefixedWidgetBundleIdentifier) {
    throw new Error(
      [
        `Generated widget target bundle identifier must be prefixed with the parent app bundle identifier.`,
        `widgetBundleIdentifier=${widgetBundleIdentifiers.join(',')}`,
        `appBundleIdentifiers=${appBundleIdentifiers.join(',') || 'none'}`,
      ].join('\n'),
    );
  }

  return prefixedWidgetBundleIdentifier;
}

export async function assertExpoWidgetsGeneratedProject({
  cwd,
  iosDir,
  targetName = DEFAULT_GENERATED_TARGET_NAME,
  requiredWidgetNames = DEFAULT_GENERATED_WIDGET_NAMES,
  spawnSyncImpl = spawnSync,
} = {}) {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = cwd ?? dirname(scriptsDir);
  const resolvedIosDir = iosDir ?? join(packageRoot, 'ios');
  const paths = await resolveGeneratedProjectPaths({ iosDir: resolvedIosDir, targetName });

  const [pbxprojRaw, podfileRaw, infoPlistRaw] = await Promise.all([
    readFile(paths.pbxprojPath, 'utf8'),
    readFile(paths.podfilePath, 'utf8'),
    readFile(paths.infoPlistPath, 'utf8'),
  ]);

  ensurePattern(
    podfileRaw,
    new RegExp(`target\\s+["']${targetName}["']`),
    `Podfile is missing generated target '${targetName}'.`,
  );
  ensurePattern(
    podfileRaw,
    /use_expo_modules_widgets!/,
    'Podfile is missing use_expo_modules_widgets! integration.',
  );
  ensurePattern(
    pbxprojRaw,
    new RegExp(`\\b${targetName}\\b`),
    `Generated Xcode project is missing target '${targetName}'.`,
  );
  ensurePattern(
    pbxprojRaw,
    /wrapper\.app-extension|\.appex\b/,
    'Generated Xcode project is missing the widget app extension product reference.',
  );
  ensurePattern(
    infoPlistRaw,
    /com\.apple\.widgetkit-extension/,
    'Generated widget target Info.plist is missing the WidgetKit extension point identifier.',
  );
  assertUniqueWidgetTargetGraph(pbxprojRaw, targetName);

  for (const widgetName of requiredWidgetNames) {
    await assertReadableFile(join(paths.targetDir, `${widgetName}.swift`));
    ensurePattern(
      pbxprojRaw,
      new RegExp(`${widgetName}\\.swift`),
      `Generated Xcode project is missing source reference '${widgetName}.swift'.`,
    );
  }

  const bundleIdentifier = resolveWidgetBundleIdentifier(pbxprojRaw, targetName);

  const xcodebuildResult = spawnSyncImpl(
    'xcodebuild',
    ['-list', '-project', paths.xcodeprojPath],
    {
      cwd: packageRoot,
      encoding: 'utf8',
    },
  );

  let usedXcodebuildValidation = true;
  if (xcodebuildResult.error) {
    if (xcodebuildResult.error?.code !== 'ENOENT') {
      throw xcodebuildResult.error;
    }
    usedXcodebuildValidation = false;
  } else {
    const output = `${xcodebuildResult.stdout ?? ''}${xcodebuildResult.stderr ?? ''}`;
    if (xcodebuildResult.status !== 0) {
      throw new Error(`xcodebuild -list failed for generated widgets project.\n${output}`.trim());
    }
    assertXcodebuildOutput(output, targetName);
  }

  return {
    targetName,
    bundleIdentifier,
    widgetNames: [...requiredWidgetNames],
    xcodeprojPath: paths.xcodeprojPath,
    usedXcodebuildValidation,
  };
}

async function runCli() {
  try {
    const summary = await assertExpoWidgetsGeneratedProject();
    console.log(
      [
        'Expo widgets generated iOS project validated.',
        `target=${summary.targetName}`,
        `bundleIdentifier=${summary.bundleIdentifier}`,
        `widgets=${summary.widgetNames.join(',')}`,
        `xcodebuild=${summary.usedXcodebuildValidation ? 'validated' : 'skipped'}`,
      ].join(' '),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli();
}
