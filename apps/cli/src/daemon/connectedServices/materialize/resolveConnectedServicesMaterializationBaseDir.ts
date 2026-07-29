import { join } from 'node:path';

export function resolveConnectedServicesMaterializationBaseDir(happyHomeDir: string): string {
  return join(happyHomeDir, 'daemon', 'connected-services', 'materialized');
}
