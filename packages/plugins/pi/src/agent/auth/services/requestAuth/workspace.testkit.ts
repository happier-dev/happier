import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PI_REQUEST_AUTH_TEST_PACKAGE_DIRECTORY = fileURLToPath(new URL('../../../../../', import.meta.url));
const workspaceParent = join(PI_REQUEST_AUTH_TEST_PACKAGE_DIRECTORY, 'node_modules', '.cache', 'happier-tests', 'pi-request-auth');

/** Keep native ESM resolution while excluding temporary extensions from source synchronization. */
export async function createPiRequestAuthTestWorkspace(prefix: 'composed-' | 'real-owners-'): Promise<string> {
  await mkdir(workspaceParent, { recursive: true });
  return await mkdtemp(join(workspaceParent, prefix));
}
