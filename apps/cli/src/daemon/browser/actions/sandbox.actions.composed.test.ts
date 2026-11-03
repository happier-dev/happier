import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createDaemonRuntimeActionExecutor } from '../../runtimeActionExecutor';
import { createBrowserRuntimeActionExecutor } from '../../../../../ui/sources/sync/domains/browser/actions/runtimeActionExecutor';
import { CHROMIUM_FOR_TESTING_PRODUCT_SOURCE, resolveChromiumForTestingAssetVersion } from '@happier-dev/protocol/browser/sidecar/chromiumForTesting';
import { ActionsSettingsV1Schema, type ApprovalRequest } from '@happier-dev/protocol';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

// Never invoke sudo: OS authorization is the only simulated effect below the real installer.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: () => {
    environment.osCalls += 1;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 1));
    return child;
  },
}));

// The installed daemon identity is persisted OS state; admission and family dispatch stay real.
vi.mock('@/persistence', () => ({ readSettings: async () => ({ machineId: 'machine' }) }));
const environment = vi.hoisted(() => ({ happyHomeDir: '', osCalls: 0, cancel: undefined as AbortController | undefined }));
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
  environment.osCalls = 0;
});

it.each(['ui', 'agent'] as const)('returns typed OS authorization from the approved %s Browser front door', async surface => {
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
    const proposals: ApprovalRequest[] = [];
    const { executor } = createCliActionExecutorHarness({ token: 'test', sessionId: 'session', mode: 'plain', ctx: null }, {
      runtimeActionExecute: execute,
      approvalsCreate: async ({ request }) => { proposals.push(request); return { artifactId: 'sandbox-approval' }; },
      approvalsGet: async () => null,
    });
    const context = { surface, authority: 'account_automation' as const, defaultSessionId: 'session',
      defaultSessionMachineId: 'machine', serverId: 'home', actionRequestId: 'sandbox-install',
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine' } };
    if (surface === 'agent') {
      expect(await executor.execute('browser.sandbox.install', { machineId: 'machine' }, {
        ...context, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
      })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(proposals).toHaveLength(1);
      expect(environment.osCalls).toBe(0);
    }
    const priorProposals = proposals.length;
    const result = await executor.execute('browser.sandbox.install', { machineId: 'machine' }, {
      ...context, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'browser.sandbox.install': [surface] } }),
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Configured Allow did not reach sandbox installation');
    expect(getActionSpec('browser.sandbox.install').outputSchema!.parse(result.result))
      .toEqual({ status: 'failed', code: 'os_authorization_required' });
    expect(await execute({ actionId: 'browser.sandbox.install', input: { machineId: 'other' },
      context: { surface, authority: 'account_automation',
        externalActionTarget: { kind: 'machine', machineId: 'machine' } } }))
      .toMatchObject({ ok: false, errorCode: 'browser_machine_mismatch' });
    expect(proposals).toHaveLength(priorProposals);
    expect(environment.osCalls).toBe(1);
    expect(await executor.execute('browser.sandbox.install', { machineId: 'machine' }, {
      ...context, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        actions: { 'browser.sandbox.install': { approvalRequiredSurfaces: [surface] } } }),
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(proposals).toHaveLength(priorProposals + 1);
    expect(environment.osCalls).toBe(1);
  } finally { await rm(environment.happyHomeDir, { recursive: true, force: true }); }
});

it('dispatches admitted sandbox recovery without a browser route and preserves Machine targeting', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const execute = createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({}),
    resolveServerFeaturesSnapshot: () => undefined });
  const args = { actionId: 'browser.sandbox.install' as const, input: { machineId: 'machine' },
    context: { authority: 'account_automation' as const } };
  expect(await execute(args))
    .toEqual({ status: 'failed', code: 'platform_unsupported' });
  expect(await execute({ ...args, input: { machineId: 'other' }, context: args.context }))
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
      context: { authority: 'account_automation', signal: environment.cancel.signal } }))
      .toEqual({ status: 'failed', code: 'cancelled' });
  } finally { await rm(environment.happyHomeDir, { recursive: true, force: true }); }
});
