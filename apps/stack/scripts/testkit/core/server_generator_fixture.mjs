import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveServerGeneratedClients } from '../../build/server_generated_clients.mjs';
import { promisify } from 'node:util';

/**
 * The server's Prisma generator (apps/server/scripts/generateClients.ts) is a
 * third-party code generator boundary. This stand-in keeps its file contract:
 * the same schema → client locations, one client module (with its `Machine`
 * declaration) per schema, and the
 * `.happier-source-schema.sha256` stamp of the schema it generated from. Each
 * run appends its server root to `HSTACK_TEST_GENERATOR_LOG` when set.
 */
const GENERATOR = `import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerPrismaInstallLayout } from './prismaInstallLayout.mjs';
const server = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultClient = resolveServerPrismaInstallLayout({ serverRoot: server }).defaultClientDir;
for (const [schema, client] of [['prisma/schema.prisma', defaultClient],
  ['prisma/sqlite/schema.prisma', 'generated/sqlite-client'], ['prisma/mysql/schema.prisma', 'generated/mysql-client']]) {
  const source = await readFile(join(server, schema));
  const fields = [...source.toString().matchAll(/^\\s+(\\w+)\\s+\\w+/gm)].map(match => match[1]);
  const output = client === defaultClient ? client : join(server, client);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'index.js'), 'exports.fields = ' + JSON.stringify(fields) + ';\\n');
  await writeFile(join(output, 'index.d.ts'), 'export type Machine = { ' + fields.map(field => field + ': string;').join(' ') + ' };\\n');
  await writeFile(join(output, 'package.json'), JSON.stringify({ name: '.prisma/client', main: 'index.js', types: 'index.d.ts' }));
  await writeFile(join(output, '.happier-source-schema.sha256'), createHash('sha256').update(source).digest('hex') + '\\n');
}
if (process.env.HSTACK_TEST_GENERATOR_LOG) await appendFile(process.env.HSTACK_TEST_GENERATOR_LOG, server + '\\n');
`;

const SCHEMAS = ['prisma/schema.prisma', 'prisma/sqlite/schema.prisma', 'prisma/mysql/schema.prisma'];

export const FIXTURE_MACHINE_SCHEMA = 'model Machine {\n  id String\n}\n';

/** Writes the generator and the three schemas under `apps/server`. */
export async function installServerGeneratorFixture(repoDir, schema = FIXTURE_MACHINE_SCHEMA) {
  const server = join(repoDir, 'apps/server');
  await mkdir(join(server, 'scripts'), { recursive: true });
  await copyFile(new URL('../../../../server/scripts/prismaInstallLayout.mjs', import.meta.url), join(server, 'scripts/prismaInstallLayout.mjs'));
  // Match atomic installations: package bytes live outside the checkout.
  const installation = await mkdtemp(join(dirname(repoDir), 'prisma-install-'));
  const client = join(installation, '@prisma/client');
  await mkdir(client, { recursive: true });
  await writeFile(join(client, 'package.json'), JSON.stringify({ name: '@prisma/client' }));
  await mkdir(join(server, 'node_modules/@prisma'), { recursive: true });
  await symlink(client, join(server, 'node_modules/@prisma/client'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(server, 'scripts/generateClients.ts'), GENERATOR);
  await writeServerSchemas(repoDir, schema);
}

export async function writeServerSchemas(repoDir, schema) {
  for (const path of SCHEMAS) {
    await mkdir(join(repoDir, 'apps/server', path, '..'), { recursive: true });
    await writeFile(join(repoDir, 'apps/server', path), schema);
  }
}

/** Generates the clients in `repoDir`, as the checkout's own preparation does. */
export async function generateServerClients(repoDir) {
  await promisify(execFile)(process.execPath, [join(repoDir, 'apps/server/scripts/generateClients.ts')]);
}

/** Field names each generated client was generated with. */
export async function readGeneratedClientFields(repoDir) {
  const fields = {};
  for (const [index, { client }] of resolveServerGeneratedClients({ repoDir }).entries()) {
    const name = ['default', 'sqlite', 'mysql'][index];
    const text = await readFile(join(repoDir, client, 'index.js'), 'utf8');
    fields[name] = JSON.parse(text.slice(text.indexOf('=') + 1, text.lastIndexOf(';')));
  }
  return fields;
}
