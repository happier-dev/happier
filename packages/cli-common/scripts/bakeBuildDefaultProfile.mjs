import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The compiled parser is the same owner used by source, UI, CLI and future policy consumers. */
export async function bakeBuildDefaultProfile({ stageDistDir, env }) {
  const raw = env.EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON ?? env.HAPPIER_BUILD_DEFAULT_PROFILE_JSON;
  if (!raw?.trim()) return;
  const { resolveBuildDefaultProfile } = await import(pathToFileURL(join(stageDistDir, 'happierCloud.js')).href);
  const profile = resolveBuildDefaultProfile(raw);
  await writeFile(join(stageDistDir, 'bakedBuildDefaultProfile.js'),
    `export const BAKED_BUILD_DEFAULT_PROFILE_JSON = ${JSON.stringify(JSON.stringify(profile))};\n`, 'utf8');
}
