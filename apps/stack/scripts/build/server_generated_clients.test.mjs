import assert from 'node:assert/strict';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SERVER_GENERATED_CLIENTS } from './server_generated_clients.mjs';
import { SERVER_GENERATED_INPUT_ROOTS } from '../utils/fs/workspaceBuildInputs.mjs';
import { resolveServerPrismaInstallLayout } from '../../../server/scripts/prismaInstallLayout.mjs';

const repoDir = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

test('stack generated-client paths are where the server install layout puts the default client', () => {
  const layout = resolveServerPrismaInstallLayout({ serverRoot: join(repoDir, 'apps/server') });
  assert.equal(layout.ownsInstalledClient, true, 'this checkout installs its own @prisma/client');
  const defaultClient = relative(repoDir, layout.defaultClientDir).split('\\').join('/');
  const clientPackage = relative(repoDir, layout.clientPackageDir).split('\\').join('/');
  assert.equal(SERVER_GENERATED_CLIENTS.find(({ schema }) => schema === 'apps/server/prisma/schema.prisma')?.client, defaultClient);
  assert.ok(SERVER_GENERATED_INPUT_ROOTS.includes(defaultClient), defaultClient);
  assert.ok(SERVER_GENERATED_INPUT_ROOTS.includes(clientPackage), clientPackage);
});
