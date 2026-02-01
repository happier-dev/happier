import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { pathExists } from '../fs/fs.mjs';

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
    .filter((e) => e.isDirectory() && e.name.endsWith('.xcodeproj') && e.name.startsWith('Happy'))
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
