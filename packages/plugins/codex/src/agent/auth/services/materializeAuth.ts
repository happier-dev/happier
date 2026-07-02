import { join } from 'node:path';

import {
  buildCodexCloudAuthFile,
  type CodexCloudAuthFile,
  type CodexCloudAuthFileTokens,
} from './openai/cloud/authFile.js';

export type CodexMaterializedAuthPlan = Readonly<{
  codexHome: string;
  authFilePath: string;
  authFile: CodexCloudAuthFile;
  env: Readonly<Record<'CODEX_HOME', string>>;
}>;

export function buildCodexMaterializedAuthPlan(params: CodexCloudAuthFileTokens & Readonly<{
  rootDir: string;
  lastRefreshIso: string;
}>): CodexMaterializedAuthPlan {
  const codexHome = params.rootDir;
  return {
    codexHome,
    authFilePath: join(codexHome, 'auth.json'),
    authFile: buildCodexCloudAuthFile(params),
    env: { CODEX_HOME: codexHome },
  };
}
