import { join } from 'node:path';

import { configuration } from '@/configuration';

export function resolveManagedPetRoot(happyHomeDir: string = configuration.happyHomeDir): string {
  return join(happyHomeDir, 'pets', 'imports');
}
