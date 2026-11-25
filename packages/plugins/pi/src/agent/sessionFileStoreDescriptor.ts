import { createHash } from 'node:crypto';
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

export function resolvePiSessionDirectoryName(cwd: string): Readonly<{
  name: string;
  requiresOverride: boolean;
}> {
  const encoded = PI_SESSION_FILE_STORE_DESCRIPTOR_V1.encodeCwdSubdir(cwd);
  // Pi flattens the entire cwd into one filename. Linux filesystems such as
  // ext4 limit each component to 255 bytes, even when the full cwd fits.
  if (process.platform !== 'linux' || Buffer.byteLength(encoded) <= 255) {
    return { name: encoded, requiresOverride: false };
  }
  const projectKey = createHash('sha256').update(resolve(cwd)).digest('hex');
  return { name: `happier-${projectKey}`, requiresOverride: true };
}
