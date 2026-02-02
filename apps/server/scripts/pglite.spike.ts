import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

function run(cmd: string, args: string[], options?: { cwd?: string; env?: Record<string, string | undefined> }) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
    });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(__dirname, '..', '..', '..');

  // Keep the spike workspace under the repo root so Prisma can resolve package.json and won't
  // attempt auto-installing a different Prisma version.
  const workDir = join(repoRoot, 'packages', 'happy-server', '.not-committed', `pglite-spike-${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  const prismaBin = resolve(repoRoot, 'node_modules', '.bin', 'prisma');
  const schemaPath = join(workDir, 'schema.prisma');
  const generatedOut = join(workDir, 'generated', 'client');
  const dbDir = join(workDir, 'pglite');

  const schema = `
generator client {
  provider        = "prisma-client-js"
  output          = "${generatedOut.replaceAll('"', '\\"')}"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Foo {
  id   String @id @default(uuid())
  name String
}
`.trimStart();

  let pglite: PGlite | null = null;
  let server: PGLiteSocketServer | null = null;
  let prisma: any | null = null;

  try {
    await mkdir(dbDir, { recursive: true });
    await writeFile(schemaPath, schema, 'utf8');

    pglite = new PGlite(dbDir);
    await (pglite as any).waitReady;
    server = new PGLiteSocketServer({ db: pglite, host: '127.0.0.1', port: 0 });
    await server.start();

    const url = (() => {
      const raw = server.getServerConn();
      try {
        return new URL(raw);
      } catch {
        return new URL(`postgresql://postgres@${raw}/postgres?sslmode=disable`);
      }
    })();
    url.searchParams.set('connection_limit', '1');
    process.env.DATABASE_URL = url.toString();

    // Create schema in the pglite-backed database and generate client.
    await run(prismaBin, ['db', 'push', '--schema', schemaPath, '--skip-generate'], { cwd: repoRoot });
    await run(prismaBin, ['generate', '--schema', schemaPath], { cwd: repoRoot });

    const clientEntry = pathToFileURL(join(generatedOut, 'index.js')).href;
    const { PrismaClient } = await import(clientEntry);
    prisma = new PrismaClient();

    await prisma.$connect();
    const created = await prisma.foo.create({ data: { name: 'hello' } });
    const count = await prisma.foo.count();
    if (count !== 1) {
      throw new Error(`Expected count=1, got ${count}`);
    }
    console.log('PASS: prisma-pglite adapter works (create + count). Created:', created.id);
  } finally {
    if (prisma) {
      await prisma.$disconnect();
    }
    if (server) {
      await server.stop();
    }
    if (pglite) {
      await pglite.close();
    }
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
