import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, renderScreen, flushHookEffects } from '@/dev/testkit';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSignedOutAuthForTest } from '@/dev/testkit/fixtures/signedOutAuth';
import { buildFileShareClipboardRequest, resolveFileShareActionScope } from '@/components/workspaces/files/file/fileShareClipboard';

const clipboard = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>());
// The native clipboard is the effect boundary; Action admission and Account custody remain real.
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

describe('UI clipboard Action', () => {
  beforeEach(async () => { await homes.reset(); clipboard.mockReset(); });
  afterEach(() => standardCleanup());

  it.each([undefined, null])('copies a signed-out native pairing link through the clipboard owner before Account binding (%s)', async scope => {
    const restoreAuth = installSignedOutAuthForTest();
    clipboard.mockResolvedValue(true);
    const { useClipboardWrite } = await import('@/hooks/ui/useClipboardWrite');
    const writer = await renderHook(() => useClipboardWrite(scope));
    const link = 'happier:///pair?v=2&payload=opaque-secret';
    try {
      await act(async () => { expect(await writer.getCurrent()(link)).toBe(true); });
      expect(clipboard.mock.calls).toEqual([[link]]);
    } finally { await writer.unmount(); restoreAuth(); }
  });

  it('does not turn an explicitly unavailable Account copy into a signed-out local write', async () => {
    const restoreAuth = installSignedOutAuthForTest();
    clipboard.mockResolvedValue(true);
    const { useClipboardWrite } = await import('@/hooks/ui/useClipboardWrite');
    const writer = await renderHook(() => useClipboardWrite({ serverId: 'unavailable-home', accountId: 'original-account' }));
    try {
      await act(async () => { expect(await writer.getCurrent()('unavailable source')).toBe(false); });
      expect(clipboard).not.toHaveBeenCalled();
    } finally { await writer.unmount(); restoreAuth(); }
  });

  it('copies signed-out native Home diagnostics without inventing an Account binding', async () => {
    const serverId = await homes.addHome({ name: 'Signed-out Home', serverUrl: 'https://signed-out-copy.test', accountId: null });
    const restoreAuth = installSignedOutAuthForTest();
    clipboard.mockResolvedValue(true);
    const { useClipboardWrite } = await import('@/hooks/ui/useClipboardWrite');
    const writer = await renderHook(() => useClipboardWrite(serverId));
    try {
      await act(async () => { expect(await writer.getCurrent()('Home transport diagnostics')).toBe(true); });
      expect(clipboard.mock.calls).toEqual([['Home transport diagnostics']]);
    } finally { await writer.unmount(); restoreAuth(); }
  });

  it('retains an admitted native copy while its menu closes during approval', async () => {
    const serverId = await homes.addHome({ name: 'Copy approval', serverUrl: 'https://copy-approval.test', accountId: 'alice' });
    await homes.requireUiApproval(serverId, 'clipboard.write');
    clipboard.mockResolvedValue(true);
    const { useClipboardWrite } = await import('@/hooks/ui/useClipboardWrite');
    const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');
    const writer = await renderHook(({ open }: { open: boolean }) => useClipboardWrite(serverId, { enabled: open }),
      { initialProps: { open: true } });
    let copied!: Promise<boolean>;
    await act(async () => { copied = writer.getCurrent()('approved Session ID'); });
    await waitForHomeGovernance(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
    const artifactId = homes.artifacts(serverId).list()[0]!.id;
    expect(clipboard).not.toHaveBeenCalled();

    await writer.rerender({ open: false });
    expect(clipboard).not.toHaveBeenCalled();
    await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({ ok: true });
    await act(async () => { expect(await copied).toBe(true); });
    expect(clipboard).toHaveBeenCalledWith('approved Session ID');
  });

  it('cancels a pending native copy when its source disclosure retires', async () => {
    const serverId = await homes.addHome({ name: 'Disclosure', serverUrl: 'https://disclosure-copy.test', accountId: 'alice' });
    await homes.requireUiApproval(serverId, 'clipboard.write');
    clipboard.mockResolvedValue(true);
    const { useClipboardWrite } = await import('@/hooks/ui/useClipboardWrite');
    const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');
    const writer = await renderHook(() => useClipboardWrite(serverId));
    const source = new AbortController();
    let copied!: Promise<boolean>;
    await act(async () => { copied = writer.getCurrent()('retired secret', { signal: source.signal }); });
    await waitForHomeGovernance(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
    const artifactId = homes.artifacts(serverId).list()[0]!.id;
    await act(async () => { source.abort(); expect(await copied).toBe(false); });
    await decideApprovalAsInbox(serverId, artifactId, 'approve');
    await flushHookEffects();
    expect(clipboard).not.toHaveBeenCalled();
  });

  it('never rebinds an explicitly unavailable file Account to the composer Account', () => {
    const composer = { serverId: 'home-a', accountId: 'alice' };
    const original = { serverId: 'home-b', accountId: 'bob' };
    expect(resolveFileShareActionScope(null, composer)).toBeNull();
    expect(resolveFileShareActionScope(undefined, composer)).toBe(composer);
    expect(resolveFileShareActionScope(original, composer)).toBe(original);
  });

  it('preserves exact diagnostic-export text and reports a refused platform copy truthfully', async () => {
    const serverId = await homes.addHome({ name: 'Clipboard', serverUrl: 'https://clipboard.test', accountId: 'alice' });
    const text = '{\n  "diagnosis": "ready 🔐"\n}\n';
    clipboard.mockResolvedValueOnce(true);
    expect(await createDefaultActionExecutor().execute('clipboard.write', { text }, { surface: 'ui', serverId }))
      .toEqual({ ok: true, result: { status: 'copied' } });
    expect(clipboard).toHaveBeenLastCalledWith(text);
    clipboard.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    expect(await createDefaultActionExecutor().execute('clipboard.write', { text }, { surface: 'ui', serverId }))
      .toMatchObject({ ok: false, errorCode: 'clipboard_unavailable' });
  });

  it('copies exact file paths and canonical Session and Project links through the real clipboard Action', async () => {
    const serverId = await homes.addHome({ name: 'Files', serverUrl: 'https://files.test', accountId: 'alice' });
    const { buildWorkspaceFileLink } = await import('@/utils/url/sessionFileDeepLink');
    for (const target of [
      { kind: 'session' as const, sessionId: 'session-a', serverId },
      { kind: 'project' as const, workspaceRefId: 'workspace-a', serverId, machineId: 'machine-a', rootPath: '/repo' },
    ]) {
      const path = 'src/has space.ts';
      const url = buildWorkspaceFileLink({ target, path, anchor: { kind: 'fileLine', startLine: 9 } });
      const source = { relativePath: path, absolutePath: `C:\\Users\\Alice\\repo\\${path}`, link: url };
      for (const { intent, text } of [
        { intent: { kind: 'path' as const }, text: path },
        { intent: { kind: 'path' as const, absolute: true }, text: source.absolutePath },
        { intent: { kind: 'link' as const }, text: url },
      ]) {
        const request = buildFileShareClipboardRequest(source, intent);
        if (!request) throw new Error('Expected a file clipboard request');
        clipboard.mockResolvedValueOnce(true);
        expect(await createDefaultActionExecutor().execute(request.actionId, request.input,
          { surface: 'ui', serverId, expectedAccountId: 'alice' }))
          .toEqual({ ok: true, result: { status: 'copied' } });
        expect(clipboard).toHaveBeenLastCalledWith(text);
      }
      expect(buildFileShareClipboardRequest({ ...source, absolutePath: null }, { kind: 'path', absolute: true })).toBeNull();
      expect(buildFileShareClipboardRequest({ ...source, link: null }, { kind: 'link' })).toBeNull();
    }
  });
});
