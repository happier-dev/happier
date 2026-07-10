import {
  findNewestSessionFileInDir,
  listSessionFileStoreRoots,
  resolveSessionFileStoreDirs,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';
import type { ExternalSessionsSource } from '@happier-dev/plugin-sdk/sessions';

import { OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from '../../../sessionFileStoreDescriptor.js';
import { resolveOhMyPiAgentDir } from './source.js';

export async function listOhMyPiSessionRoots(params: Readonly<{
  source: ExternalSessionsSource;
  env?: NodeJS.ProcessEnv;
}>): Promise<string[]> {
  const agentDir = resolveOhMyPiAgentDir({ source: params.source, env: params.env });
  const resolution = await resolveSessionFileStoreDirs({
    product: OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1,
    env: params.env,
    grantedRoot: {
      v: 1,
      productId: OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1.productId,
      agentDir,
      grantedBy: 'host-config',
    },
  });
  return [...await listSessionFileStoreRoots(resolution)];
}

export async function resolveOhMyPiSessionFile(params: Readonly<{
  source: ExternalSessionsSource;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ filePath: string }> | null> {
  const sessionRoots = await listOhMyPiSessionRoots({
    source: params.source,
    env: params.env,
  });
  for (const sessionRoot of sessionRoots) {
    const found = await findNewestSessionFileInDir({ sessionId: params.remoteSessionId, dir: sessionRoot });
    if (found) return { filePath: found };
  }
  return null;
}
