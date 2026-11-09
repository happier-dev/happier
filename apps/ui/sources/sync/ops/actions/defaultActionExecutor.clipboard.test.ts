import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, renderScreen, flushHookEffects } from '@/dev/testkit';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSignedOutAuthForTest } from '@/dev/testkit/fixtures/signedOutAuth';
import { buildFileShareClipboardRequest, resolveFileShareActionScope } from '@/components/workspaces/files/file/fileShareClipboard';

const clipboard = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>());
// The native clipboard is the effect boundary; Action admission and Account custody remain real.
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard, getStringAsync: async () => 'local 日本' }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { useAskSelection } = await import('@/components/ui/code/selection/useAskSelection');
const { Platform } = await import('react-native');

describe('UI clipboard Action', () => {
  beforeEach(async () => { await homes.reset(); clipboard.mockReset(); });
  afterEach(() => standardCleanup());

  it.each(['copy', 'cut'] as const)('applies native clipboard Off and Ask to a remote viewer %s without publishing its content', async action => {
    const serverId = await homes.addHome({ name: 'Remote viewer', serverUrl: `https://viewer-${action}.test`, accountId: 'alice', currentAccount: true });
    await homes.setActionPolicy(serverId, 'clipboard.write', 'ui', 'off');
    clipboard.mockResolvedValue(true);
    const { useClipboardWrite } = await import('@/hooks/ui/useClipboardWrite');
    const { transferRemoteViewerClipboard, createRemoteViewerClipboardShortcut } = await import('@/components/stream/remoteViewerClipboard');
    const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const writer = await renderHook(() => ({ write: useClipboardWrite(serverId),
      resolution: useServerCredentialAccountScopeBinding(serverId).resolution }));
    await waitForHomeGovernance(() => expect(writer.getCurrent().resolution.kind).toBe('bound'));
    const text = 'private remote 👋\n日本';
    let remote = text;
    const transport = { read: async () => remote, write: async (value: string) => { remote = value; } };
    try {
      await act(async () => {
        await expect(transferRemoteViewerClipboard(action, transport, writer.getCurrent().write)).rejects.toThrow('clipboard_unavailable');
      });
      expect(clipboard).not.toHaveBeenCalled();
      await homes.requireUiApproval(serverId, 'clipboard.write');
      const shortcut = createRemoteViewerClipboardShortcut(transport, writer.getCurrent().write);
      for (const decision of ['reject', 'approve'] as const) {
        let copied!: ReturnType<typeof shortcut>;
        const previousArtifacts = new Set(homes.artifacts(serverId).list().map(artifact => artifact.id));
        await act(async () => { copied = shortcut(action); });
        const artifact = await waitForHomeGovernance(() => {
          const pending = homes.artifacts(serverId).list().find(candidate => !previousArtifacts.has(candidate.id));
          expect(pending).toBeDefined();
          return pending!;
        });
        expect(homes.artifacts(serverId).readPlainBody(artifact.id)).not.toContain('private remote');
        expect(clipboard).not.toHaveBeenCalled();
        expect(await decideApprovalAsInbox(serverId, artifact.id, decision)).toMatchObject({ ok: true });
        await act(async () => { expect(await copied).toMatchObject({ ok: decision === 'approve' }); });
      }
      expect(clipboard.mock.calls).toEqual([[text]]);
      await transferRemoteViewerClipboard('paste', transport, writer.getCurrent().write);
      expect(remote).toBe('local 日本');
      await expect(transferRemoteViewerClipboard(action, { ...transport, read: async () => { throw new Error('clipboard_not_supported'); } }, writer.getCurrent().write))
        .rejects.toThrow('clipboard_not_supported');
      expect(clipboard.mock.calls).toEqual([[text]]);
    } finally { await writer.unmount(); }
  });

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

  it('copies a native Home pairing panel link through its bound clipboard writer', async () => {
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const { tryWriteServerEnabledBitInPlace} = await import('@happier-dev/protocol/features/serverEnabledBit');
    const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
    const { parseHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
    const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { HomePairingPanel } = await import('@/components/auth/pairing/HomePairingPanel');
    const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
    const { createElement } = await import('react');
    const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_pairing_copy',
      canonicalServerUrl: 'https://pairing-copy.test', revision: 1,
      endpoints: [{ kind: 'https' as const, url: 'https://pairing-copy.test' }] };
    const serverId = await homes.addHome({ name: 'Pairing copy', serverUrl: descriptor.canonicalServerUrl,
      serverIdentityId: descriptor.homeServerIdentityId, accountId: 'alice', active: false });
    await adoptHomeProfile({ descriptor, source: 'qr', descriptorAuthority: 'current_connection_observation' });
    const features = { ...createRootLayoutFeaturesResponse(), homeConnectionDescriptor: descriptor };
    features.capabilities.serverIdentity.serverIdentityId = descriptor.homeServerIdentityId;
    features.capabilities.server.canonicalServerUrl = descriptor.canonicalServerUrl;
    expect(tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', true)).toBe(true);
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    homes.answer(serverId, 'POST /v1/auth/pairing/start', { body: { pairId: 'pair-copy', expiresAt } });
    homes.answer(serverId, 'GET /v1/auth/pairing/status', { body: { state: 'pending', pairId: 'pair-copy', expiresAt } });
    homes.answer(serverId, 'POST /v1/auth/pairing/consume', { body: { success: true } });
    await homes.setActionPolicy(serverId, 'clipboard.write', 'ui', 'allowed');
    const { captureActiveServerRuntimeTarget, publishActiveServerRuntimeOrigin, releaseActiveServerRuntimeOrigin } = await import('@/sync/domains/server/serverRuntime');
    const runtimeTarget = captureActiveServerRuntimeTarget();
    // The first saved Home is focused implicitly; native requests require its admitted transport publication.
    expect(publishActiveServerRuntimeOrigin({ target: runtimeTarget, leaseId: 'native-pairing-copy',
      runtimeOrigin: descriptor.canonicalServerUrl, carrier: 'https' })).toBe(true);
    clipboard.mockResolvedValue(true);
    const screen = await renderScreen(createElement(InjectedAuthProvider, { credentials: null,
      children: createElement(HomePairingPanel, { purpose: 'computer', layout: 'section', testIDPrefix: 'pairing-copy', targetProfileId: serverId }) }));
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('pairing-copy-copy-link')?.props.disabled,
        JSON.stringify({ text: screen.getTextContent(), requests: homes.requests.map(({ method, path }) => ({ method, path })) })).toBe(false));
      expect(clipboard).not.toHaveBeenCalled();
      const button = screen.findAllByType(RoundButton).find(node => node.props.testID === 'pairing-copy-copy-link');
      expect(button).toBeDefined();
      await act(async () => { await button!.props.action(); });
      expect(clipboard).toHaveBeenCalledOnce();
      expect(parseHomeQrInviteDeepLink(clipboard.mock.calls[0]![0])?.invite).toMatchObject({
        pairId: 'pair-copy', home: { homeServerIdentityId: descriptor.homeServerIdentityId },
      });
    } finally {
      await screen.unmount();
      releaseActiveServerRuntimeOrigin({ target: runtimeTarget, leaseId: 'native-pairing-copy' });
    }
  });

  it.each(['header', 'item', 'icon', 'embed'] as const)('honors native clipboard admission from the shared %s copy control', async control => {
    const serverId = await homes.addHome({ name: 'Copy control', serverUrl: `https://copy-${control}.test`, accountId: 'alice' });
    await homes.setActionPolicy(serverId, 'clipboard.write', 'ui', 'off');
    clipboard.mockResolvedValue(true);
    const { createElement } = await import('react');
    const { PageHeader } = await import('@/components/ui/layout/PageHeader');
    const { Item } = await import('@/components/ui/lists/Item');
    const { CopyIconButton } = await import('@/components/ui/copy/CopyIconButton');
    const { EmbedRevealEnvironmentCopy } = await import('@/components/settings/embeds/EmbedRevealEnvironmentCopy');
    const acknowledged = vi.fn();
    const value = 'whole-native-id-α';
    const screen = await renderScreen(control === 'header'
      ? createElement(PageHeader, { title: 'Build box', meta: [{ key: 'id', text: value, mono: true, testID: 'copy-control' }] })
      : control === 'item' ? createElement(Item, { title: 'ID', copy: value, testID: 'copy-control' })
        : control === 'icon' ? createElement(CopyIconButton, { text: value, testID: 'copy-control' })
          : createElement(EmbedRevealEnvironmentCopy, { token: value, scope: { serverId, accountId: 'alice' }, onCopied: acknowledged }));
    try {
      const invoke = async () => {
        const event = control === 'item' ? 'onLongPress' : 'onPress';
        const root = screen.findByTestId(control === 'embed' ? 'settings-embed-reveal-env' : 'copy-control')!;
        const target = typeof root.props[event] === 'function' ? root
          : root.findAll(node => typeof node.props[event] === 'function')[0]!;
        await act(async () => { await target.props[event](); });
        await flushHookEffects();
      };
      await invoke();
      expect(clipboard).not.toHaveBeenCalled();
      expect(acknowledged).not.toHaveBeenCalled();
      await homes.setActionPolicy(serverId, 'clipboard.write', 'ui', 'allowed');
      await invoke();
      expect(clipboard.mock.calls).toEqual([[control === 'embed' ? `HAPPIER_EMBED_KEY=${value}` : value]]);
      if (control === 'embed') expect(acknowledged).toHaveBeenCalledOnce();
    } finally { await screen.unmount(); }
  });

  it('honors clipboard Action admission when copying the current code selection', async () => {
    const serverId = await homes.addHome({ name: 'Selection', serverUrl: 'https://selection.test', accountId: 'alice' });
    await homes.setActionPolicy(serverId, 'clipboard.write', 'ui', 'off');
    clipboard.mockResolvedValue(true);
    const selected = { startLine: 2, endLine: 3, text: '' };
    const hook = await renderHook(() => useAskSelection({ scopeId: 'selection', workspaceScope: null,
      source: 'transcript', getSelection: () => selected, getLinesText: () => 'before\nexact α\nsecond line\nafter',
      sessionTarget: null, openDetailsTab: () => undefined,
    }));
    await act(async () => { expect(await hook.getCurrent().copy()).toBe(false); });
    expect(clipboard).not.toHaveBeenCalled();
    await homes.setActionPolicy(serverId, 'clipboard.write', 'ui', 'allowed');
    await act(async () => { expect(await hook.getCurrent().copy()).toBe(true); });
    expect(clipboard).toHaveBeenLastCalledWith('exact α\nsecond line');
  });

  it('admits native plugin Host API copies through the same clipboard Action', async () => {
    const serverId = await homes.addHome({ name: 'Plugin copy', serverUrl: 'https://plugin-copy.test', accountId: 'alice' });
    await homes.setActionPolicy(serverId, 'clipboard.write', 'plugin', 'off');
    clipboard.mockResolvedValue(true);
    const { createPluginSurfaceActionHostApi } = await import('@/components/plugins/surfaces/pluginSurfaceActionDispatch');
    const { PluginUiSurfaceContextV1Schema } = await import('@happier-dev/protocol/plugins/ui');
    const surface = PluginUiSurfaceContextV1Schema.parse({ pluginId: 'com.acme.copy', contributionId: 'copy', surfaceId: 'copy-surface',
      placement: 'appSurface', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] });
    const api = createPluginSurfaceActionHostApi({ surfaceContext: surface,
      callerBinding: { pluginId: surface.pluginId, contributionLocalId: surface.contributionId, occurrenceId: 'copy-current',
        materializationRef: { pluginId: surface.pluginId, machineId: 'copy-machine', materializationId: 'copy-materialization' } },
      hostAction: { execute: createDefaultActionExecutor().execute, context: { serverId, runtimeAccountId: 'alice' } },
    });
    const request = { version: 1 as const, requestId: 'plugin-copy', surface, method: 'writeClipboard' as const, payload: { value: 'plugin value' } };
    try {
      const denied = await api.handleRequest(request);
      expect(denied).not.toBeNull();
      expect(clipboard).not.toHaveBeenCalled();
      await homes.setActionPolicy(serverId, 'clipboard.write', 'plugin', 'allowed');
      expect(await api.handleRequest(request)).toBeNull();
      expect(clipboard).toHaveBeenCalledWith('plugin value');
    } finally { api.dispose?.(); }
  });

  it('honors the source Home clipboard policy when copying Session IDs', async () => {
    const sourceHomeId = await homes.addHome({ name: 'Session source', serverUrl: 'https://session-source.test', accountId: 'alice' });
    const focusedHomeId = await homes.addHome({ name: 'Focused Home', serverUrl: 'https://focused-home.test', accountId: 'bob' });
    await homes.setActionPolicy(sourceHomeId, 'clipboard.write', 'ui', 'off');
    await homes.setActionPolicy(focusedHomeId, 'clipboard.write', 'ui', 'allowed');
    clipboard.mockResolvedValue(true);
    const { useClipboardWrite } = await import('@/hooks/ui/useClipboardWrite');
    const { buildSessionDebugInformation } = await import('@/components/sessions/debug/sessionDebugInformation');
    const { copySessionDebugInformationToClipboard, SESSION_COPY_ID_MENU_ITEM_ID, SESSION_COPY_PROVIDER_ID_MENU_ITEM_ID } =
      await import('@/components/sessions/debug/sessionDebugClipboard');
    const information = buildSessionDebugInformation({ session: { id: 'source-session' },
      providerDisplayName: 'Claude', providerSessionId: 'native-session' });
    const writer = await renderHook(() => useClipboardWrite(sourceHomeId));

    await act(async () => {
      expect(await copySessionDebugInformationToClipboard(information, SESSION_COPY_ID_MENU_ITEM_ID, writer.getCurrent())).toBe(false);
    });
    expect(clipboard).not.toHaveBeenCalled();

    await homes.setActionPolicy(sourceHomeId, 'clipboard.write', 'ui', 'allowed');
    await homes.setActionPolicy(focusedHomeId, 'clipboard.write', 'ui', 'off');
    for (const [actionId, expected] of [
      [SESSION_COPY_ID_MENU_ITEM_ID, 'source-session'],
      [SESSION_COPY_PROVIDER_ID_MENU_ITEM_ID, 'native-session'],
    ] as const) {
      await act(async () => {
        expect(await copySessionDebugInformationToClipboard(information, actionId, writer.getCurrent())).toBe(true);
      });
      expect(clipboard).toHaveBeenLastCalledWith(expected);
    }
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

  it('starts a web selection copy inside the gesture before any asynchronous Action admission', async () => {
    const serverId = await homes.addHome({ name: 'Web selection', serverUrl: 'https://web-selection.test', accountId: 'alice' });
    await homes.setActionPolicy(serverId, 'clipboard.write', 'ui', 'off');
    const selected = { startLine: 1, endLine: 1, text: 'gesture-bound selection' };
    const previous = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    try {
      const hook = await renderHook(() => useAskSelection({ scopeId: 'web-selection', workspaceScope: null,
        source: 'transcript', getSelection: () => selected, sessionTarget: null, openDetailsTab: () => undefined,
      }));
      let gestureActive = true;
      const writeText = vi.fn(async () => {
        if (!gestureActive) throw new DOMException('', 'NotAllowedError');
      });
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const result = hook.getCurrent().copy();
      expect(writeText).toHaveBeenCalledWith(selected.text);
      expect(clipboard).not.toHaveBeenCalled();
      gestureActive = false;
      expect(await result).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(Platform, 'OS', previous);
    }
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
