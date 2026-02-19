// @ts-check

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseDotenv } from './parse-dotenv.mjs';

/**
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
function loadEnvFileIfExists(filePath) {
  if (!existsSync(filePath)) return {};
  return parseDotenv(readFileSync(filePath, 'utf8'));
}

/**
 * Loads local pipeline env in precedence order:
 * - process.env (highest)
 * - .env.pipeline.<deployEnv>.local
 * - .env.pipeline.local
 *
 * @param {{ repoRoot: string; deployEnvironment?: string }} opts
 * @returns {{ env: Record<string, string>; sources: string[] }}
 */
export function loadPipelineEnv({ repoRoot, deployEnvironment }) {
  const sources = [];

  const baseFile = path.join(repoRoot, '.env.pipeline.local');
  const base = loadEnvFileIfExists(baseFile);
  if (Object.keys(base).length > 0) sources.push('.env.pipeline.local');

  const envFile = deployEnvironment
    ? path.join(repoRoot, `.env.pipeline.${deployEnvironment}.local`)
    : '';
  const deploy = envFile ? loadEnvFileIfExists(envFile) : {};
  if (Object.keys(deploy).length > 0 && deployEnvironment) {
    sources.push(`.env.pipeline.${deployEnvironment}.local`);
  }

  // process.env should override file-based values.
  const env = { ...base, ...deploy, ...process.env };
  return { env, sources };
}

