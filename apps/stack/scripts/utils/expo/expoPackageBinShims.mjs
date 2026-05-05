import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { pathExists } from '../fs/fs.mjs';
import { coerceHappyMonorepoRootFromPath } from '../paths/paths.mjs';

const EXPO_BIN_FILES = {
  cli: [
    '#!/usr/bin/env node',
    '',
    '// Execute the CLI using node module resolution, instead of creating a new process.',
    '// This avoids resolving issues with pnpm and yarn 2+ package managers.',
    "require('@expo/cli');",
    '',
  ].join('\n'),
  autolinking: [
    '#!/usr/bin/env node',
    '',
    '// Executes expo-modules-autolinking CLI directly.',
    "require('expo-modules-autolinking/bin/expo-modules-autolinking');",
    '',
  ].join('\n'),
  fingerprint: [
    '#!/usr/bin/env node',
    '',
    "require('@expo/fingerprint/bin/cli');",
    '',
  ].join('\n'),
};

const EXPO_MODULES_AUTOLINKING_BIN = [
  '#!/usr/bin/env node',
  "'use strict';",
  '',
  "process.env.FORCE_COLOR = 'true';",
  '',
  "require('../build')(process.argv.slice(2));",
  '',
].join('\n');

function uniqueDirs(dirs) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    if (!dir) continue;
    const key = resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function isYarnShellShim(content) {
  return /^#!\/bin\/sh\b/.test(content) || /^#!\/usr\/bin\/env sh\b/.test(content);
}

async function repairKnownPackageBinFile(filePath, expectedContent) {
  if (!(await pathExists(filePath))) {
    return false;
  }

  const raw = await readFile(filePath, 'utf-8');
  if (!isYarnShellShim(raw)) {
    return false;
  }

  await writeFile(filePath, expectedContent, 'utf-8');
  await chmod(filePath, 0o755);
  return true;
}

async function repairExpoPackageBinFiles(packageDir) {
  let repaired = false;
  for (const [name, content] of Object.entries(EXPO_BIN_FILES)) {
    repaired = (await repairKnownPackageBinFile(join(packageDir, 'bin', name), content)) || repaired;
  }
  return repaired;
}

async function repairExpoModulesAutolinkingPackageBinFiles(packageDir) {
  return await repairKnownPackageBinFile(
    join(packageDir, 'bin', 'expo-modules-autolinking.js'),
    EXPO_MODULES_AUTOLINKING_BIN,
  );
}

export async function repairExpoYarnPackageBinShims({ runnerDir, projectDir } = {}) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(projectDir) ?? coerceHappyMonorepoRootFromPath(runnerDir);
  const roots = uniqueDirs([monorepoRoot, runnerDir, projectDir]);

  let repaired = false;
  for (const root of roots) {
    repaired = (await repairExpoPackageBinFiles(join(root, 'node_modules', 'expo'))) || repaired;
    repaired =
      (await repairExpoModulesAutolinkingPackageBinFiles(join(root, 'node_modules', 'expo-modules-autolinking')))
      || repaired;
  }
  return { repaired };
}
