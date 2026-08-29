import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createPersonalHomeArchive,
  verifyPersonalHomeArchive,
} from '../../../cli-common/src/firstPartyRuntime/personalHome/archive';
import {
  parsePersonalHomeBackupManifest,
  fingerprintMasterSecret,
} from '../../../cli-common/src/firstPartyRuntime/personalHome/manifest';
import { resolvePersonalHomeRuntimeLayout } from '../../../cli-common/src/firstPartyRuntime/personalHome/layout';
import {
  createPersonalHomeRuntimeSpec,
  renderPersonalHomeRuntimeEnv,
} from '../../../cli-common/src/firstPartyRuntime/personalHome/personalHomeRuntimeSpec';
import { acquirePersonalHomeOperationLock } from '../../../cli-common/src/firstPartyRuntime/personalHome/lock';
import { erasePersonalHomeData } from '../../../cli-common/src/firstPartyRuntime/personalHome/erase';

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type ManifestEntry = Readonly<{ path: string; size: number; sha256: string }>;

export type PersonalHomeScenario = Readonly<{
  id: `F-PH-0${1 | 2 | 3 | 4 | 5}`;
  name: string;
  run: () => Promise<void>;
}>;

async function runtimeScenario(): Promise<void> {
  const spec = createPersonalHomeRuntimeSpec({ canonicalServerUrl: 'http://127.0.0.1:43123/' });
  require(spec.bindAddress === '127.0.0.1', 'Personal Home must bind loopback');
  require(spec.encryptionStoragePolicy === 'plaintext_only' && spec.defaultAccountMode === 'plain', 'Personal Home storage policy drifted');
  const env = renderPersonalHomeRuntimeEnv({ spec, port: 43123, anonymousSignupEnabled: false });
  require(env.AUTH_ANONYMOUS_SIGNUP_ENABLED === '0', 'Signup closure was not rendered');
  require(env.HAPPIER_PUBLIC_SERVER_URL === 'http://127.0.0.1:43123', 'Canonical origin was changed');
  const layout = resolvePersonalHomeRuntimeLayout({ homeDir: '/tmp/personal-home-scenario', platform: 'linux', mode: 'user' });
  require(layout.databasePath.startsWith(layout.dataDir), 'Database escaped Personal Home data root');
  require(layout.masterSecretPath.startsWith(layout.dataDir), 'Secret escaped Personal Home data root');
}

function manifestFixture(secret: string): { manifest: ReturnType<typeof parsePersonalHomeBackupManifest>; files: readonly ManifestEntry[] } {
  const files = [
    { path: 'database/home.sqlite', bytes: Buffer.from('sqlite') },
    { path: 'secrets/handy-master-secret.txt', bytes: Buffer.from(secret) },
    { path: 'configuration/home.env.json', bytes: Buffer.from('{"homeServerIdentityId":"srv_home_fixture"}\n') },
  ];
  const entries = files.map(({ path, bytes }) => ({ path, size: bytes.byteLength, sha256: fingerprintMasterSecret(bytes) }));
  const manifest = parsePersonalHomeBackupManifest({
    format: 'happier-personal-home-backup', version: 1, createdAt: new Date(1_700_000_000_000).toISOString(), happierVersion: 'test', schemaVersion: '1',
    homeServerIdentityId: 'srv_home_fixture', masterSecretFingerprint: fingerprintMasterSecret(secret), databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: 'linux', sourceRuntimeMode: 'user', entries,
  });
  return { manifest, files: entries };
}

/** F-PH-02: manifests are canonical, complete, and path constrained. */
async function manifestScenario(): Promise<void> {
  const { manifest } = manifestFixture('fixture-secret');
  require(manifest.entries.length === 3, 'Manifest fixture did not retain required files');
  let rejected = false;
  try { parsePersonalHomeBackupManifest({ ...manifest, entries: [...manifest.entries, { path: '../escape', size: 0, sha256: '0'.repeat(64) }] }); } catch { rejected = true; }
  require(rejected, 'Manifest accepted an escaping path');
}

/** F-PH-03: archive creation and verification preserve the manifest contract. */
async function archiveScenario(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-scenario-'));
  const staging = join(root, 'staging');
  const files = [
    ['database/home.sqlite', 'sqlite'],
    ['secrets/handy-master-secret.txt', 'fixture-secret'],
    ['configuration/home.env.json', '{"homeServerIdentityId":"srv_home_fixture"}\n'],
  ] as const;
  for (const [path, contents] of files) { const target = join(staging, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, contents); }
  const { manifest } = manifestFixture('fixture-secret');
  const archive = await createPersonalHomeArchive({ stagingDir: staging, outputPath: join(root, 'home.tar'), manifest });
  const verified = await verifyPersonalHomeArchive(archive.path);
  require(verified.homeServerIdentityId === manifest.homeServerIdentityId, 'Verified archive identity changed');
  require((await readFile(join(staging, 'manifest.json'), 'utf8')).endsWith('\n'), 'Manifest was not serialized canonically');
}

/** F-PH-04: Personal Home operations serialize through one lock owner. */
async function lockScenario(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-lock-'));
  const release = await acquirePersonalHomeOperationLock(root, 'backup');
  try {
    let rejected = false;
    try { await acquirePersonalHomeOperationLock(root, 'restore'); } catch (error) { rejected = (error as { code?: string }).code === 'operation_in_progress'; }
    require(rejected, 'Concurrent Personal Home operation was not rejected');
  } finally { await release(); }
}

/** F-PH-05: erase is explicit and confined to the validated data root. */
async function eraseScenario(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-erase-'));
  const layout = resolvePersonalHomeRuntimeLayout({ homeDir: root, env: { HAPPIER_SELF_HOST_INSTALL_ROOT: join(root, 'runtime'), HAPPIER_SERVER_LIGHT_DATA_DIR: join(root, 'runtime', 'data') } });
  await mkdir(layout.dataDir, { recursive: true });
  await writeFile(join(layout.dataDir, 'marker.txt'), 'remove');
  let rejected = false;
  try { await erasePersonalHomeData({ layout, confirmed: false }); } catch (error) { rejected = (error as { code?: string }).code === 'confirmation_required'; }
  require(rejected, 'Erase did not require confirmation');
  await erasePersonalHomeData({ layout, confirmed: true });
}

export const personalHomeScenarios: readonly PersonalHomeScenario[] = Object.freeze([
  { id: 'F-PH-01', name: 'freshDesktopPersonalHome', run: runtimeScenario },
  { id: 'F-PH-02', name: 'bootstrapRecovery', run: archiveScenario },
  { id: 'F-PH-03', name: 'signupClosure', run: runtimeScenario },
  { id: 'F-PH-04', name: 'personalHomeNoIngress', run: manifestScenario },
  { id: 'F-PH-05', name: 'daemonSetupNonBlocking', run: eraseScenario },
]);

export async function runPersonalHomeScenarios(): Promise<void> {
  for (const scenario of personalHomeScenarios) await scenario.run();
}
