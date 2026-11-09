import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

import { configuration } from '@/configuration';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeModuleLoadObserver } from '@/testkit/process/moduleLoadObserver';
import { resolveCliTsxTsconfigPath } from '@/utils/spawnHappyCLI';

const cliRoot = fileURLToPath(new URL('../', import.meta.url));
const persistencePath = fileURLToPath(new URL('./persistence.ts', import.meta.url));
const repoRoot = join(cliRoot, '..', '..');

type ColdRead = Readonly<{
  daemonRuntimeModuleLoads: number;
  present: boolean;
  matchesExpected: boolean;
}>;

it('links zero daemon service implementations into the private reader used by a metadata write', async () => {
  let privateReader: string | undefined;
  const staticClosure = async (entryPoint: string) => await build({
    absWorkingDir: cliRoot, entryPoints: [entryPoint], bundle: true,
    format: 'esm', platform: 'node', packages: 'external', write: false, metafile: true,
    logLevel: 'silent', plugins: [{ name: 'static-private-read-closure', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.kind !== 'dynamic-import') return undefined;
        if (args.importer === persistencePath && args.path.startsWith('./daemon/sessionEncryption/')) privateReader = args.path;
        return { path: args.path, external: true };
      });
    } }],
  });
  await staticClosure(persistencePath);
  expect(privateReader).toBeDefined();
  const result = await staticClosure(join(cliRoot, 'src', privateReader!));
  const inputs = Object.entries(result.metafile.inputs);
  const daemonServices = inputs.filter(([path]) => path.startsWith('src/daemon/connectedServices/'));
  console.info(JSON.stringify({ privateReadStaticModules: inputs.length,
    privateReadSourceBytes: inputs.reduce((total, [, input]) => total + input.bytes, 0),
    daemonServiceModules: daemonServices.length }));
  expect(daemonServices.length).toBe(0);
});

async function readInColdRunner(home: string, path: string, expected: string, signal: AbortSignal): Promise<ColdRead> {
  // Observe Node's real module-loader boundary; no internal reader or authority
  // logic is replaced. A new process preserves the cold first metadata write.
  const observer = join(home, 'observe.mjs');
  const observations = join(home, 'loaded.ndjson');
  await writeModuleLoadObserver(observer, observations);
  const source = `
    import { register } from 'node:module';
    import { readFileSync } from 'node:fs';
    register(${JSON.stringify(pathToFileURL(observer).href)}, { data: { output: ${JSON.stringify(observations)} } });
    const { readStoredCredentials } = await import(${JSON.stringify(pathToFileURL(persistencePath).href)});
    readStoredCredentials().then(value => {
      const loaded = new Set(readFileSync(${JSON.stringify(observations)}, 'utf8').trim().split('\\n')
        .filter(line => line.includes('/daemon/connectedServices/')
          || line.includes('/daemon/sessionEncryption/requesterSessionCredentials.ts')));
      process.stdout.write(JSON.stringify({ daemonRuntimeModuleLoads: loaded.size,
        present: value !== null, matchesExpected: value?.token === process.env.HAPPIER_TEST_EXPECTED_BEARER }),
        () => process.exit(0));
    }).catch(() => process.exit(1));
  `;
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--import', pathToFileURL(join(repoRoot, 'packages/cli-common/registerSourceRuntime.mjs')).href,
      '--input-type=module', '--eval', source], {
      cwd: cliRoot,
      signal,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
        HAPPIER_HOME_DIR: home,
        HAPPIER_ACTIVE_SERVER_ID: configuration.activeServerId,
        HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: path,
        HAPPIER_SESSION_REQUESTER_SESSION_ID: 'cold-session',
        HAPPIER_TEST_EXPECTED_BEARER: expected,
      },
    });
  return JSON.parse(stdout.trim()) as ColdRead;
}

it('opens current private Session custody without loading daemon services, and observes rotation and removal', async ({ onTestFinished }) => {
  const lifetime = new AbortController();
  onTestFinished(() => lifetime.abort());
  const { createRequesterSessionCredentialCustody } = await import('@/daemon/sessionEncryption/requesterSessionCredentials');
  await withTempDir('happier-cold-session-read-', async home => {
    const binding = { happyHomeDir: home, sessionId: 'cold-session', attribution: {
      serverId: configuration.activeServerId, accountId: 'requester', machineId: 'machine', installationId: 'installation',
    } };
    const first = randomUUID();
    const custody = await createRequesterSessionCredentialCustody({ ...binding,
      credentials: { token: first, encryption: null } });
    const initial = await readInColdRunner(home, custody.path, first, lifetime.signal);
    expect(initial.present).toBe(true);
    expect(initial.matchesExpected).toBe(true);
    expect(initial.daemonRuntimeModuleLoads).toBe(0);

    const rotated = randomUUID();
    await createRequesterSessionCredentialCustody({ ...binding,
      credentials: { token: rotated, encryption: null } });
    const current = await readInColdRunner(home, custody.path, rotated, lifetime.signal);
    expect(current.matchesExpected).toBe(true);
    expect(current.daemonRuntimeModuleLoads).toBe(0);

    await custody.cleanup();
    const removed = await readInColdRunner(home, custody.path, rotated, lifetime.signal);
    expect(removed.present).toBe(false);
    expect(removed.daemonRuntimeModuleLoads).toBe(0);
  });
// Same cold-source process budget as createCliActionExecutor.coldPorts.test.ts.
}, 120_000);
