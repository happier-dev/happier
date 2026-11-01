import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createDaemonRuntimeActionExecutor } from '../../runtimeActionExecutor';
import { createBrowserRuntimeActionExecutor } from '../../../../../ui/sources/sync/domains/browser/actions/runtimeActionExecutor';
import { CHROMIUM_FOR_TESTING_PRODUCT_SOURCE, resolveChromiumForTestingAssetVersion } from '@happier-dev/protocol/browser/sidecar/chromiumForTesting';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

// Never invoke sudo: OS authorization is the only simulated effect below the real installer.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 1));
    return child;
  },
}));

// The installed daemon identity is persisted OS state; admission and family dispatch stay real.
vi.mock('@/persistence', () => ({ readSettings: async () => ({ machineId: 'machine' }) }));
const environment = vi.hoisted(() => ({ happyHomeDir: '', cancel: undefined as AbortController | undefined }));
vi.mock('@/configuration', async importOriginal => {
  const original = await importOriginal<typeof import('@/configuration')>();
  // Configuration is the environment boundary; retain its real defaults and methods.
  const configuration: typeof original.configuration = Object.create(original.configuration);
  Object.defineProperty(configuration, 'happyHomeDir', { get: () => environment.happyHomeDir });
  return { ...original, configuration };
});
// The archive download is the network boundary; real acquisition/verification owners remain in use.
vi.mock('@happier-dev/cli-common/agents', async importOriginal => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/agents')>(),
  downloadGitHubReleaseAsset: async (params: { signal?: AbortSignal }) => {
    if (!params.signal) throw new Error('Acquisition did not receive Action cancellation');
    environment.cancel?.abort();
    params.signal.throwIfAborted();
  },
}));
const originalPlatform = process.platform;
const originalArch = process.arch;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  Object.defineProperty(process, 'arch', { value: originalArch });
});

it.each(['ui', 'agent', 'cli'] as const)('returns typed OS authorization from the approved %s Browser front door', async surface => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  Object.defineProperty(process, 'arch', { value: 'x64' });
  environment.happyHomeDir = await mkdtemp(join(tmpdir(), 'sandbox-front-door-'));
  const asset = CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.assetsByPlatform['linux-x64'];
  if (!asset) throw new Error('Missing managed Linux Chromium contract');
  const current = join(environment.happyHomeDir, 'tools', CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.key, 'current');
  const executable = join(current, asset.executableSubpath);
  const bytes = 'test-only managed executable; never spawned';
  try {
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, bytes);
    await chmod(executable, 0o700);
    await writeFile(join(current, '.happier-managed-version'), resolveChromiumForTestingAssetVersion(asset));
    await writeFile(join(current, '.happier-managed-executable-sha256'), `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    const daemon = createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({}),
      resolveServerFeaturesSnapshot: () => undefined });
    // The Machine RPC boundary delivers to the real daemon family dispatcher and installer.
    const execute = createBrowserRuntimeActionExecutor({ executeOnMachine: daemon });
    const result = await execute({ actionId: 'browser.sandbox.install', input: { machineId: 'machine' },
      context: { surface, authority: 'account_automation', bypassApprovals: true,
        externalActionTarget: { kind: 'machine', machineId: 'machine' } } });
    expect(getActionSpec('browser.sandbox.install').outputSchema!.parse(result))
      .toEqual({ status: 'failed', code: 'os_authorization_required' });
    expect(await execute({ actionId: 'browser.sandbox.install', input: { machineId: 'other' },
      context: { surface, authority: 'account_automation', bypassApprovals: true,
        externalActionTarget: { kind: 'machine', machineId: 'machine' } } }))
      .toMatchObject({ ok: false, errorCode: 'browser_machine_mismatch' });
    expect(await execute({ actionId: 'browser.sandbox.install', input: { machineId: 'machine' },
      context: { surface, authority: 'account_automation',
        externalActionTarget: { kind: 'machine', machineId: 'machine' } } }))
      .toMatchObject({ ok: false, errorCode: 'approval_required' });
  } finally { await rm(environment.happyHomeDir, { recursive: true, force: true }); }
});

it('admits approved sandbox recovery without a browser route, but refuses unapproved and wrong-machine requests', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const execute = createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({}),
    resolveServerFeaturesSnapshot: () => undefined });
  const args = { actionId: 'browser.sandbox.install' as const, input: { machineId: 'machine' },
    context: { authority: 'account_automation' as const } };
  expect(await execute(args)).toMatchObject({ ok: false, errorCode: 'approval_required' });
  expect(await execute({ ...args, context: { ...args.context, bypassApprovals: true } }))
    .toEqual({ status: 'failed', code: 'platform_unsupported' });
  expect(await execute({ ...args, input: { machineId: 'other' }, context: { ...args.context, bypassApprovals: true } }))
    .toMatchObject({ ok: false, errorCode: 'browser_machine_mismatch' });
});

it('cancels managed artifact acquisition through the existing archive owner and returns a typed cancellation', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  Object.defineProperty(process, 'arch', { value: 'x64' });
  environment.happyHomeDir = await mkdtemp(join(tmpdir(), 'sandbox-action-test-'));
  environment.cancel = new AbortController();
  try {
    const execute = createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({}),
      resolveServerFeaturesSnapshot: () => undefined });
    expect(await execute({ actionId: 'browser.sandbox.install', input: { machineId: 'machine' },
      context: { authority: 'account_automation', bypassApprovals: true, signal: environment.cancel.signal } }))
      .toEqual({ status: 'failed', code: 'cancelled' });
  } finally { await rm(environment.happyHomeDir, { recursive: true, force: true }); }
});
