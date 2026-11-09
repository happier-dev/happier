import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SkillFoundListResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { prepareWarmCacheEncryptionKey } from '../state/warmCacheEncryptionKey';

installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
// The machine is the system boundary. The Action executor, warm cache and hook stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport }));
const { storage } = await import('@/sync/domains/state/storage');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { useFoundSkills, useFoundSkillsCount, useFoundSkillsCache } = await import('./useFoundSkills');
const { saveFoundWarmCacheEntry } = await import('../state/warmCachePersistence');

afterEach(() => { standardCleanup(); resetPromptLibraryCatalogEngineForTests(); resetPromptLibraryCatalogSnapshotsForTests(); });

const found = SkillFoundListResultV1Schema.parse({ scannedAt: 1_700_000_000_000, roots: [], items: [
  { name: 'held', description: null, path: '/skills/held', digest: 'a', agents: ['claude'], scope: 'user',
    inLibrary: 'held', masksLibrary: false, happierInstalled: true, pluginOwned: null },
  { name: 'native', description: 'A native skill.', path: '/skills/native', digest: 'b', agents: ['claude', 'codex'], scope: 'user',
    inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: null },
] });

async function openHome() {
  const catalog = createPromptLibraryCatalogBoundary();
  await createPlainArtifactHomeFixture('https://skills-found.test', {
    serverFeatures: createRootLayoutFeaturesResponse(),
    handleRequest: async (path, init) => path === '/v2/account/settings/history' ? Response.json({ snapshots: [] }) : catalog.handle(path, init),
  });
  await prepareWarmCacheEncryptionKey();
  storage.setState({ isDataReady: true, artifactsLoaded: true });
}

it('reads the requested Account cache rather than the active Account cache', async () => {
  await openHome();
  const scope = { serverId: 'sheet-home', accountId: 'sheet-owner' };
  const other = { serverId: 'other-home', accountId: 'other-owner' };
  saveFoundWarmCacheEntry(scope.serverId, scope.accountId, { kind: 'skill', machineId: 'm1', observedAt: found.scannedAt, result: found });
  const hook = await renderHook((target: typeof scope) => useFoundSkillsCache(['m1'], target), { initialProps: scope });
  expect(hook.getCurrent().m1?.items.map(item => item.name)).toEqual(['held', 'native']);
  await hook.rerender(other);
  expect(hook.getCurrent().m1).toBeNull();
  await hook.unmount();
});

it('reads a machine through the Action, shows it from the device cache, and counts what is not in the library yet', async () => {
  await openHome();
  transport.mockReset();
  transport.mockResolvedValue(found);
  const hook = await renderHook(() => ({ page: useFoundSkills(['m1', 'm2']), count: useFoundSkillsCount(['m1', 'm2']) }));
  try {
    await vi.waitFor(() => expect(hook.getCurrent().page.ready).toBe(true));
    expect(hook.getCurrent().page.scans.map((scan) => scan.result)).toEqual([null, null]);
    await act(async () => { await hook.getCurrent().page.scan('m1'); });
    await vi.waitFor(() => expect(hook.getCurrent().page.scans[0]).toMatchObject({ machineId: 'm1', failure: null, scanning: false }));
    expect(hook.getCurrent().page.scans[0]!.result?.items.map((entry) => entry.name)).toEqual(['held', 'native']);
    expect(hook.getCurrent().page.scans[1]!.result).toBeNull();
    // One item is already in the library, so the rail's count is the other one.
    expect(hook.getCurrent().count).toBe(1);
    // Reconnecting/re-reading the same machine replaces its observation; another
    // machine holding the same named skill is another place, not another skill.
    await act(async () => { await hook.getCurrent().page.scan('m1'); });
    expect(hook.getCurrent().count).toBe(1);
    await act(async () => { await hook.getCurrent().page.scan('m2'); });
    expect(hook.getCurrent().count).toBe(1);
    transport.mockResolvedValueOnce({ ...found, items: [...found.items,
      { ...found.items[1]!, name: 'other', path: '/skills/other' }],
    });
    await act(async () => { await hook.getCurrent().page.scan('m2'); });
    expect(hook.getCurrent().count).toBe(2);
  } finally { await hook.unmount(); }
});

it('keeps the last known list when a later read fails, and says an older machine is older, not offline', async () => {
  await openHome();
  transport.mockReset();
  transport.mockResolvedValueOnce(found);
  const hook = await renderHook(() => useFoundSkills(['m1']));
  try {
    await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
    await act(async () => { await hook.getCurrent().scan('m1'); });
    await vi.waitFor(() => expect(hook.getCurrent().scans[0]!.result).not.toBeNull());
    transport.mockRejectedValueOnce(new Error('machine went away'));
    await act(async () => { await hook.getCurrent().scan('m1'); });
    expect(hook.getCurrent().scans[0]).toMatchObject({ failure: 'failed', scanning: false });
    expect(hook.getCurrent().scans[0]!.result?.items).toHaveLength(2);
    transport.mockRejectedValueOnce(Object.assign(new Error('RPC_METHOD_NOT_AVAILABLE'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }));
    await act(async () => { await hook.getCurrent().scan('m1'); });
    expect(hook.getCurrent().scans[0]!.failure).toBe('older_machine');
  } finally { await hook.unmount(); }
});
