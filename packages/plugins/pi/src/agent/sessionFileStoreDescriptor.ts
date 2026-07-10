import { resolve } from 'node:path';

import type { SessionFileStoreProductDescriptorV1 } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

function encodePiSessionDirectoryCwd(cwd: string): string {
  return resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
}

export const PI_SESSION_FILE_STORE_DESCRIPTOR_V1 = {
  productId: 'pi',
  defaultAgentDirSegments: ['.pi', 'agent'],
  agentDirEnvVar: 'PI_CODING_AGENT_DIR',
  legacySessionDirEnvVars: ['PI_CODING_AGENT_SESSION_DIR'],
  readsSettingsSessionDir: true,
  configDirName: '.pi',
  encodeCwdSubdir: (cwd: string) => `--${encodePiSessionDirectoryCwd(cwd)}--`,
} satisfies SessionFileStoreProductDescriptorV1;
