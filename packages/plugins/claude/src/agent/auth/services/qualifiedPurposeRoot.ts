import { mkdir } from 'node:fs/promises';

import { projectClaudeWorkspaceTrust } from './workspaceTrust.js';

export async function prepareClaudeQualifiedPurposeRoot(input: Readonly<{
  rootDir: string;
  processEnv: NodeJS.ProcessEnv;
  sessionDirectory: string | null;
}>): Promise<void> {
  await mkdir(input.rootDir, { recursive: true, mode: 0o700 });
  await projectClaudeWorkspaceTrust({
    sourceEnv: input.processEnv,
    targetDir: input.rootDir,
    sessionDirectory: input.sessionDirectory,
  });
}
