import { resolve } from 'node:path';

import type { SessionFileStoreProductDescriptor as SessionFileStoreProductDescriptorV1 } from '@happier-dev/plugin-sdk/sessions/file-stores';

function encodePiSessionDirectoryCwd(cwd: string): string {
  return resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
}

export const PI_SESSION_FILE_STORE_DESCRIPTOR_V1 = {
  productId: 'pi',
  defaultAgentDirSegments: ['.pi', 'agent'],
  agentDirEnvVar: 'PI_CODING_AGENT_DIR',
  agentDirSettingId: 'piAgentDir',
  legacySessionDirEnvVars: ['PI_CODING_AGENT_SESSION_DIR'],
  readsSettingsSessionDir: true,
  configDirName: '.pi',
  encodeCwdSubdir: (cwd: string) => `--${encodePiSessionDirectoryCwd(cwd)}--`,
} satisfies SessionFileStoreProductDescriptorV1;
