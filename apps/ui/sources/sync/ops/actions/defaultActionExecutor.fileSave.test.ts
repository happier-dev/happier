import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiActionDispatchRequestV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { buildLogIndexV1 } from '@happier-dev/forge-ci/runtime';
import { createExpoFileSystemFileMock } from '@/dev/testkit/mocks/expoFileSystem';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const native = vi.hoisted(() => ({
  fileSystem: null as ReturnType<typeof createExpoFileSystemFileMock> | null,
  handoff: vi.fn<(input: { fileUri: string }) => Promise<{ canceled: boolean }>>(),
}));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'android' }));
vi.mock('expo-file-system', async () => {
  native.fileSystem = (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock();
  return native.fileSystem.module;
});
// Only the OS chooser is replaced; Home, admission, log projection and file custody remain real.
vi.mock('@/sync/runtime/files/nativeFileActions', () => ({ performAndroidFileAction: native.handoff }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { exportMachineServiceLogIndex } = await import('@/components/machines/services/exportMachineServiceLogIndex');
const { createUiClientActionReverseHandler } = await import('./clientActionReverseDispatch');
const initialState = storage.getState();

describe('file exports through answering-client Action composition', () => {
  beforeEach(async () => {
    await homes.reset();
    storage.setState(initialState, true);
    await import('expo-file-system');
    native.fileSystem!.files.clear();
    native.handoff.mockReset().mockResolvedValue({ canceled: false });
  });
  afterEach(() => standardCleanup());

  it('saves the same masked bytes for the native log UI and an admitted agent request', async () => {
    const serverId = await homes.addHome({ name: 'Files', serverUrl: 'https://file-actions.test', accountId: 'alice', currentAccount: true });
    const text = 'redacted token=***\r\npart 🌍\n';
    const index = buildLogIndexV1({ sourceKey: 'machine/worker/generation', positionBasis: 'page',
      log: { logId: 'native-source', text, startLine: 1, startByte: 0,
        complete: false, continuation: { sourceRevision: 'native-source', token: 'next-page' } } });
    const handedOff: number[][] = [];
    native.handoff.mockImplementation(async ({ fileUri }) => {
      handedOff.push([...native.fileSystem!.files.get(fileUri)!]);
      return { canceled: false };
    });
    expect(await exportMachineServiceLogIndex({ index, fileName: 'worker.log',
      scope: { serverId, accountId: 'alice' }, isCurrent: () => true })).toBe('saved');
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'alice', isCurrent: () => true });
    const request = UiActionDispatchRequestV1Schema.parse({ v: 1, actionId: 'files.save',
      input: { fileName: 'agent.log', source: { kind: 'text', text } },
      context: { surface: 'agent', authority: 'account_automation', defaultSessionId: 'background-agent' } });
    expect(await receive(JSON.parse(JSON.stringify(request)), { signal: new AbortController().signal }))
      .toEqual({ v: 1, execution: { ok: true, result: { status: 'saved' } } });
    expect(handedOff).toEqual([[...new TextEncoder().encode(text)], [...new TextEncoder().encode(text)]]);
    expect(native.fileSystem!.files.size).toBe(0);
  });

  it('refuses disabled UI file exports before writing any native file', async () => {
    const serverId = await homes.addHome({ name: 'Files', serverUrl: 'https://file-policy.test', accountId: 'alice', currentAccount: true });
    await storage.getState().activateSettingsScope({ serverId, accountId: 'alice' });
    const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'files.save': { enabled: false } } });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1 } }, version: 1 } });
    storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1 } }));
    const index = buildLogIndexV1({ sourceKey: 'log', positionBasis: 'page',
      log: { logId: 'source', text: '***', startLine: 1, startByte: 0, complete: true, continuation: null } });
    expect(await exportMachineServiceLogIndex({ index, fileName: 'worker.log',
      scope: { serverId, accountId: 'alice' }, isCurrent: () => true })).toBe('failed');
    expect(native.handoff).not.toHaveBeenCalled();
    expect(native.fileSystem!.files.size).toBe(0);
  });
});
