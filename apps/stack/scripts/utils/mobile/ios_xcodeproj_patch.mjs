import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { pathExists } from '../fs/fs.mjs';

const require = createRequire(import.meta.url);

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

function loadXcodeModule({ uiDir, pbxprojPath } = {}) {
  const inferredUiDir = pbxprojPath ? dirname(dirname(dirname(pbxprojPath))) : '';
  const baseDirs = uniqueStrings([uiDir, inferredUiDir, process.cwd()]);

  for (const baseDir of baseDirs) {
    try {
      return createRequire(join(baseDir, 'package.json'))('xcode');
    } catch {
      // Try the next known package root before falling back to this script's module graph.
    }
  }

  return require('xcode');
}

function sanitizeXcodeProductName(name) {
  const raw = (name ?? '').toString().trim();
  const out = raw
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return out || 'Happy';
}

async function listIosAppXcodeprojNames({ iosDir }) {
  let entries = [];
  try {
    entries = await readdir(iosDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const names = entries
    .filter(
      (e) =>
        e.isDirectory() &&
        e.name.endsWith('.xcodeproj') &&
        (e.name.startsWith('Happy') || e.name.startsWith('Happier'))
    )
    .map((e) => e.name);

  // Prefer the common names first to keep behavior stable if multiple projects exist.
  const score = (name) => {
    if (name === 'Happydev.xcodeproj') return 0;
    if (name === 'Happy.xcodeproj') return 1;
    return 2;
  };
  names.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
  return names;
}

export async function resolveIosAppXcodeProjects({ uiDir }) {
  const iosDir = join(uiDir, 'ios');
  const projectNames = await listIosAppXcodeprojNames({ iosDir });

  const projects = [];
  for (const projectName of projectNames) {
    const pbxprojPath = join(iosDir, projectName, 'project.pbxproj');
    if (!(await pathExists(pbxprojPath))) {
      continue;
    }

    const appDirName = projectName.replace(/\.xcodeproj$/, '');
    const infoPlistPath = join(iosDir, appDirName, 'Info.plist');

    projects.push({
      name: appDirName,
      pbxprojPath,
      infoPlistPath: (await pathExists(infoPlistPath)) ? infoPlistPath : null,
    });
  }

  return projects;
}

function sectionObjects(project, sectionName) {
  return project?.hash?.project?.objects?.[sectionName] ?? {};
}

function objectName(object) {
  const raw = object?.name ?? object?.productName;
  return String(raw ?? '').replace(/^"|"$/g, '');
}

function removeEntryValues(entries, valuesToRemove) {
  if (!Array.isArray(entries) || valuesToRemove.size === 0) {
    return false;
  }
  const next = entries.filter((entry) => !valuesToRemove.has(String(entry?.value ?? '')));
  if (next.length === entries.length) {
    return false;
  }
  entries.splice(0, entries.length, ...next);
  return true;
}

function collectConfigurationIds(objects, configurationListId) {
  const ids = new Set();
  const configurationList = objects.XCConfigurationList?.[configurationListId];
  ids.add(configurationListId);
  for (const entry of configurationList?.buildConfigurations ?? []) {
    const value = String(entry?.value ?? '');
    if (value) ids.add(value);
  }
  return ids;
}

function deleteObjectAndComment(section, id) {
  if (!section || !id) {
    return;
  }
  delete section[id];
  delete section[`${id}_comment`];
}

function unquoteXcodeValue(value) {
  return String(value ?? '').replace(/^"|"$/g, '');
}

function setBuildSetting(buildSettings, key, value) {
  if (!buildSettings || buildSettings[key] === value) {
    return false;
  }
  buildSettings[key] = value;
  return true;
}

function deleteBuildSetting(buildSettings, key) {
  if (!buildSettings || !(key in buildSettings)) {
    return false;
  }
  delete buildSettings[key];
  return true;
}

function targetBuildSettings(objects, target) {
  const configurationList = objects.XCConfigurationList?.[target?.buildConfigurationList];
  const settings = [];
  for (const entry of configurationList?.buildConfigurations ?? []) {
    const configurationId = String(entry?.value ?? entry ?? '');
    const buildSettings = objects.XCBuildConfiguration?.[configurationId]?.buildSettings;
    if (buildSettings) {
      settings.push(buildSettings);
    }
  }
  return settings;
}

function isTargetProductType(target, productType) {
  return unquoteXcodeValue(target?.productType) === productType;
}

function patchParsedIosProjectSigning(project) {
  const objects = project?.hash?.project?.objects;
  if (!objects) {
    return false;
  }

  let changed = false;
  for (const projectObject of Object.values(objects.PBXProject ?? {})) {
    if (!projectObject || typeof projectObject !== 'object') continue;
    for (const targetAttributes of Object.values(projectObject.attributes?.TargetAttributes ?? {})) {
      if (targetAttributes && typeof targetAttributes === 'object' && 'DevelopmentTeam' in targetAttributes) {
        delete targetAttributes.DevelopmentTeam;
        changed = true;
      }
    }
  }

  for (const configuration of Object.values(objects.XCBuildConfiguration ?? {})) {
    if (!configuration || typeof configuration !== 'object') continue;
    const buildSettings = configuration.buildSettings;
    changed = deleteBuildSetting(buildSettings, 'DEVELOPMENT_TEAM') || changed;
    changed = deleteBuildSetting(buildSettings, 'PROVISIONING_PROFILE') || changed;
    changed = deleteBuildSetting(buildSettings, 'PROVISIONING_PROFILE_SPECIFIER') || changed;
    changed = deleteBuildSetting(buildSettings, 'CODE_SIGN_IDENTITY') || changed;
    changed = deleteBuildSetting(buildSettings, '"CODE_SIGN_IDENTITY[sdk=iphoneos*]"') || changed;
  }

  return changed;
}

function patchParsedIosAppTargetIdentity(project, { bundleId, productName } = {}) {
  const objects = project?.hash?.project?.objects;
  if (!objects) {
    return false;
  }

  let changed = false;
  for (const target of Object.values(objects.PBXNativeTarget ?? {})) {
    if (!target || typeof target !== 'object') continue;
    if (!isTargetProductType(target, 'com.apple.product-type.application')) continue;
    for (const buildSettings of targetBuildSettings(objects, target)) {
      changed = setBuildSetting(buildSettings, 'PRODUCT_BUNDLE_IDENTIFIER', bundleId) || changed;
      if (productName) {
        changed = setBuildSetting(buildSettings, 'PRODUCT_NAME', productName) || changed;
      }
    }
  }
  return changed;
}

function collectParsedIosAppTargetIdentityValues(project) {
  const objects = project?.hash?.project?.objects;
  const bundleIds = new Set();
  const productNames = new Set();
  if (!objects) {
    return { bundleIds, productNames };
  }

  for (const target of Object.values(objects.PBXNativeTarget ?? {})) {
    if (!target || typeof target !== 'object') continue;
    if (!isTargetProductType(target, 'com.apple.product-type.application')) continue;
    for (const buildSettings of targetBuildSettings(objects, target)) {
      const bundleId = unquoteXcodeValue(buildSettings.PRODUCT_BUNDLE_IDENTIFIER);
      const productName = unquoteXcodeValue(buildSettings.PRODUCT_NAME);
      if (bundleId) bundleIds.add(bundleId);
      if (productName) productNames.add(productName);
    }
  }

  return { bundleIds, productNames };
}

function repairParsedIosAppExtensionTargetIdentity(
  project,
  { appBundleId, appProductName, priorAppBundleIds = new Set(), priorAppProductNames = new Set(), targetName = 'ExpoWidgetsTarget' } = {}
) {
  const objects = project?.hash?.project?.objects;
  if (!objects || !appBundleId) {
    return false;
  }

  let changed = false;
  const defaultExtensionBundleId = `"${appBundleId}.${targetName}"`;
  const suspiciousBundleIds = new Set([appBundleId, ...priorAppBundleIds].filter(Boolean));
  const suspiciousProductNames = new Set([appProductName, ...priorAppProductNames].filter(Boolean));
  for (const target of Object.values(objects.PBXNativeTarget ?? {})) {
    if (!target || typeof target !== 'object') continue;
    if (!isTargetProductType(target, 'com.apple.product-type.app-extension')) continue;
    if (objectName(target) !== targetName) continue;

    for (const buildSettings of targetBuildSettings(objects, target)) {
      if (suspiciousBundleIds.has(unquoteXcodeValue(buildSettings.PRODUCT_BUNDLE_IDENTIFIER))) {
        changed = setBuildSetting(buildSettings, 'PRODUCT_BUNDLE_IDENTIFIER', defaultExtensionBundleId) || changed;
      }
      if (suspiciousProductNames.has(unquoteXcodeValue(buildSettings.PRODUCT_NAME))) {
        changed = setBuildSetting(buildSettings, 'PRODUCT_NAME', '"$(TARGET_NAME)"') || changed;
      }
    }
  }
  return changed;
}

export function repairDuplicateNamedIosTargetsInParsedXcodeProject(project, { targetName = 'ExpoWidgetsTarget' } = {}) {
  const objects = project?.hash?.project?.objects;
  if (!objects) {
    return { repaired: false, removedTargetCount: 0 };
  }

  const nativeTargets = sectionObjects(project, 'PBXNativeTarget');
  const matchingTargetIds = Object.entries(nativeTargets)
    .filter(([id, target]) => !id.endsWith('_comment') && objectName(target) === targetName)
    .map(([id]) => id);

  const scoreTarget = (id) => {
    const target = nativeTargets[id];
    const phaseIds = new Set((target?.buildPhases ?? []).map((entry) => String(entry?.value ?? '')));
    let score = 0;
    for (const phaseId of phaseIds) {
      const shellPhase = objects.PBXShellScriptBuildPhase?.[phaseId];
      const copyPhase = objects.PBXCopyFilesBuildPhase?.[phaseId];
      const sourcesPhase = objects.PBXSourcesBuildPhase?.[phaseId];
      if (shellPhase) score += 10;
      if (copyPhase?.files?.length) score += 6;
      if (sourcesPhase?.files?.length) score += 4;
    }
    if (target?.buildConfigurationList && objects.XCConfigurationList?.[target.buildConfigurationList]) score += 3;
    if (target?.productReference && objects.PBXFileReference?.[target.productReference]) score += 2;
    return score;
  };

  const [keepTargetId, ...removeTargetIds] =
    matchingTargetIds.length > 1
      ? matchingTargetIds
          .map((id, index) => ({ id, index, score: scoreTarget(id) }))
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .map((entry) => entry.id)
      : matchingTargetIds;
  const targetIdsToRemove = new Set(removeTargetIds);
  const keepProductReference = nativeTargets[keepTargetId]?.productReference;

  const phaseIdsToRemove = new Set();
  const productReferenceIdsToRemove = new Set();
  const buildFileIdsToRemove = new Set();
  const configurationIdsToRemove = new Set();

  for (const targetId of targetIdsToRemove) {
    const target = nativeTargets[targetId];
    for (const entry of target?.buildPhases ?? []) {
      const value = String(entry?.value ?? '');
      if (value) phaseIdsToRemove.add(value);
    }
    if (target?.productReference) productReferenceIdsToRemove.add(String(target.productReference));
    if (target?.buildConfigurationList) {
      for (const id of collectConfigurationIds(objects, target.buildConfigurationList)) {
        if (id) configurationIdsToRemove.add(id);
      }
    }
  }

  for (const [phaseId, phase] of Object.entries(objects.PBXCopyFilesBuildPhase ?? {})) {
    if (phaseId.endsWith('_comment')) continue;
    for (const entry of phase?.files ?? []) {
      const buildFileId = String(entry?.value ?? '');
      const buildFile = objects.PBXBuildFile?.[buildFileId];
      const fileRef = String(buildFile?.fileRef ?? '');
      if (productReferenceIdsToRemove.has(fileRef)) {
        buildFileIdsToRemove.add(buildFileId);
      }
    }
  }

  for (const phaseId of phaseIdsToRemove) {
    for (const entry of objects.PBXSourcesBuildPhase?.[phaseId]?.files ?? []) {
      const value = String(entry?.value ?? '');
      if (value) buildFileIdsToRemove.add(value);
    }
    for (const entry of objects.PBXFrameworksBuildPhase?.[phaseId]?.files ?? []) {
      const value = String(entry?.value ?? '');
      if (value) buildFileIdsToRemove.add(value);
    }
    for (const entry of objects.PBXCopyFilesBuildPhase?.[phaseId]?.files ?? []) {
      const value = String(entry?.value ?? '');
      if (value) buildFileIdsToRemove.add(value);
    }
  }

  const dependencyIdsToRemove = new Set();
  const proxyIdsToRemove = new Set();
  for (const [dependencyId, dependency] of Object.entries(objects.PBXTargetDependency ?? {})) {
    if (dependencyId.endsWith('_comment')) continue;
    if (targetIdsToRemove.has(String(dependency?.target ?? ''))) {
      dependencyIdsToRemove.add(dependencyId);
      if (dependency?.targetProxy) proxyIdsToRemove.add(String(dependency.targetProxy));
    }
  }
  for (const [proxyId, proxy] of Object.entries(objects.PBXContainerItemProxy ?? {})) {
    if (proxyId.endsWith('_comment')) continue;
    if (targetIdsToRemove.has(String(proxy?.remoteGlobalIDString ?? ''))) {
      proxyIdsToRemove.add(proxyId);
    }
  }

  for (const projectObject of Object.values(objects.PBXProject ?? {})) {
    if (!projectObject || typeof projectObject !== 'object') continue;
    removeEntryValues(projectObject.targets, targetIdsToRemove);
    for (const targetId of targetIdsToRemove) {
      delete projectObject.attributes?.TargetAttributes?.[targetId];
    }
  }

  const groups = objects.PBXGroup ?? {};
  const targetSourceGroupIds = Object.entries(groups)
    .filter(([id, group]) => !id.endsWith('_comment') && String(group?.path ?? '').replace(/^"|"$/g, '') === targetName)
    .map(([id]) => id);
  const groupIdsToRemove = new Set();
  if (targetSourceGroupIds.length > 1) {
    const [, ...removeGroupIds] = targetSourceGroupIds
      .map((id, index) => ({
        id,
        index,
        score: (groups[id]?.children ?? []).length,
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.id);
    for (const id of removeGroupIds) {
      groupIdsToRemove.add(id);
    }
  }

  for (const target of Object.values(nativeTargets)) {
    if (!target || typeof target !== 'object') continue;
    removeEntryValues(target.dependencies, dependencyIdsToRemove);
    removeEntryValues(target.buildPhases, phaseIdsToRemove);
  }

  for (const phase of Object.values(objects.PBXCopyFilesBuildPhase ?? {})) {
    if (!phase || typeof phase !== 'object') continue;
    removeEntryValues(phase.files, buildFileIdsToRemove);
    if (keepProductReference) {
      const seen = new Set();
      const next = [];
      for (const entry of phase.files ?? []) {
        const buildFileId = String(entry?.value ?? '');
        const fileRef = String(objects.PBXBuildFile?.[buildFileId]?.fileRef ?? '');
        if (fileRef === keepProductReference) {
          if (seen.has(fileRef)) continue;
          seen.add(fileRef);
        }
        next.push(entry);
      }
      phase.files?.splice(0, phase.files.length, ...next);
    }
  }

  for (const [phaseId, phase] of Object.entries(objects.PBXCopyFilesBuildPhase ?? {})) {
    if (phaseId.endsWith('_comment')) continue;
    if (String(phase?.name ?? '') === 'Embed Foundation Extensions' && (phase?.files ?? []).length === 0) {
      phaseIdsToRemove.add(phaseId);
    }
  }

  for (const target of Object.values(nativeTargets)) {
    if (!target || typeof target !== 'object') continue;
    removeEntryValues(target.buildPhases, phaseIdsToRemove);
  }

  for (const group of Object.values(groups)) {
    if (!group || typeof group !== 'object') continue;
    removeEntryValues(group.children, groupIdsToRemove);
  }

  for (const id of targetIdsToRemove) deleteObjectAndComment(objects.PBXNativeTarget, id);
  for (const id of groupIdsToRemove) deleteObjectAndComment(objects.PBXGroup, id);
  for (const id of phaseIdsToRemove) {
    deleteObjectAndComment(objects.PBXSourcesBuildPhase, id);
    deleteObjectAndComment(objects.PBXFrameworksBuildPhase, id);
    deleteObjectAndComment(objects.PBXCopyFilesBuildPhase, id);
    deleteObjectAndComment(objects.PBXShellScriptBuildPhase, id);
  }
  for (const id of buildFileIdsToRemove) deleteObjectAndComment(objects.PBXBuildFile, id);
  for (const id of productReferenceIdsToRemove) deleteObjectAndComment(objects.PBXFileReference, id);
  for (const id of configurationIdsToRemove) {
    deleteObjectAndComment(objects.XCConfigurationList, id);
    deleteObjectAndComment(objects.XCBuildConfiguration, id);
  }
  for (const id of dependencyIdsToRemove) deleteObjectAndComment(objects.PBXTargetDependency, id);
  for (const id of proxyIdsToRemove) deleteObjectAndComment(objects.PBXContainerItemProxy, id);

  return {
    repaired: targetIdsToRemove.size > 0 || groupIdsToRemove.size > 0,
    removedTargetCount: targetIdsToRemove.size,
  };
}

export async function repairDuplicateNamedIosTargetsInXcodeProject({ pbxprojPath, targetName = 'ExpoWidgetsTarget', uiDir } = {}) {
  if (!pbxprojPath || !(await pathExists(pbxprojPath))) {
    return { repaired: false, removedTargetCount: 0 };
  }

  const xcode = loadXcodeModule({ uiDir, pbxprojPath });
  const project = xcode.project(pbxprojPath);
  project.parseSync();
  const result = repairDuplicateNamedIosTargetsInParsedXcodeProject(project, { targetName });
  if (result.repaired) {
    await writeFile(pbxprojPath, project.writeSync(), 'utf-8');
  }
  return result;
}

export async function repairDuplicateNamedIosTargets({ uiDir, targetName = 'ExpoWidgetsTarget' } = {}) {
  const projects = await resolveIosAppXcodeProjects({ uiDir });
  const results = [];
  for (const project of projects) {
    const result = await repairDuplicateNamedIosTargetsInXcodeProject({
      pbxprojPath: project.pbxprojPath,
      targetName,
      uiDir,
    });
    if (result.repaired) {
      results.push({ ...result, project: project.name });
    }
  }
  return results;
}

export async function patchIosXcodeProjectsForSigningAndIdentity({
  uiDir,
  iosBundleId,
  iosAppName = '',
} = {}) {
  const bundleId = (iosBundleId ?? '').toString().trim();
  const appName = (iosAppName ?? '').toString().trim();
  const productName = sanitizeXcodeProductName(appName);

  if (!uiDir || !bundleId) {
    return;
  }

  const projects = await resolveIosAppXcodeProjects({ uiDir });
  if (projects.length === 0) {
    return;
  }

  for (const project of projects) {
    // Patch pbxproj: clear pinned signing fields so Expo can reconfigure and include provisioning update flags,
    // and force a per-stack bundle id + optional PRODUCT_NAME.
    try {
      const xcode = loadXcodeModule({ uiDir, pbxprojPath: project.pbxprojPath });
      const parsedProject = xcode.project(project.pbxprojPath);
      parsedProject.parseSync();
      const priorAppIdentity = collectParsedIosAppTargetIdentityValues(parsedProject);
      let changed = false;
      changed = patchParsedIosProjectSigning(parsedProject) || changed;
      changed = patchParsedIosAppTargetIdentity(parsedProject, { bundleId, productName }) || changed;
      changed =
        repairParsedIosAppExtensionTargetIdentity(parsedProject, {
          appBundleId: bundleId,
          appProductName: productName,
          priorAppBundleIds: priorAppIdentity.bundleIds,
          priorAppProductNames: priorAppIdentity.productNames,
          targetName: 'ExpoWidgetsTarget',
        }) || changed;

      if (changed) {
        await writeFile(project.pbxprojPath, parsedProject.writeSync(), 'utf-8');
      }
    } catch {
      try {
        const raw = await readFile(project.pbxprojPath, 'utf-8');
        let next = raw;

        // Clear team identifiers (both TargetAttributes and build settings variants).
        next = next.replaceAll(/^\s*DevelopmentTeam\s*=\s*[^;]+;\s*$/gm, '');
        next = next.replaceAll(/^\s*DEVELOPMENT_TEAM\s*=\s*[^;]+;\s*$/gm, '');
        // Clear any pinned provisioning profiles/specifiers (manual signing).
        next = next.replaceAll(/^\s*PROVISIONING_PROFILE\s*=\s*[^;]+;\s*$/gm, '');
        next = next.replaceAll(/^\s*PROVISIONING_PROFILE_SPECIFIER\s*=\s*[^;]+;\s*$/gm, '');
        // Some projects pin code signing identity; remove to let Xcode resolve based on the selected team.
        next = next.replaceAll(/^\s*CODE_SIGN_IDENTITY\s*=\s*[^;]+;\s*$/gm, '');
        next = next.replaceAll(/^\s*"CODE_SIGN_IDENTITY\\[sdk=iphoneos\\*\\]"\s*=\s*[^;]+;\s*$/gm, '');

        next = next.replaceAll(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${bundleId};`);

        if (appName) {
          // Expo CLI appears to treat some escaped build paths as literal (e.g. "Happy\\ (stack).app"),
          // so keep PRODUCT_NAME free of spaces to avoid breaking post-build Info.plist parsing.
          next = next.replaceAll(/PRODUCT_NAME = [^;]+;/g, `PRODUCT_NAME = ${productName};`);
        }

        if (next !== raw) {
          await writeFile(project.pbxprojPath, next, 'utf-8');
        }
      } catch {
        // ignore project patch errors; Expo will surface actionable failures if needed
      }
    }

    // Patch Info.plist display name when possible (home screen label).
    if (appName && project.infoPlistPath) {
      try {
        const plistRaw = await readFile(project.infoPlistPath, 'utf-8');
        const escaped = appName.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        const replaced = plistRaw.replace(
          /(<key>CFBundleDisplayName<\/key>\s*<string>)([\s\S]*?)(<\/string>)/m,
          `$1${escaped}$3`
        );
        if (replaced !== plistRaw) {
          await writeFile(project.infoPlistPath, replaced, 'utf-8');
        }
      } catch {
        // ignore
      }
    }
  }
}
