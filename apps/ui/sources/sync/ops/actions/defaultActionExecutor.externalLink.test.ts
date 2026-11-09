import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionIdSchema} from '@happier-dev/protocol/actions/actionIds';
import { ApprovalRequestSchema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { UiActionDispatchRequestV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { PluginUiHostApiRequestEnvelopeV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSignedOutAuthForTest } from '@/dev/testkit/fixtures/signedOutAuth';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Platform: { OS: 'web' },
    Linking: { openURL: async () => { throw new Error('No native opener in this web client'); } } });
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { requestOpenExternalUrl } = await import('@/utils/url/requestOpenExternalUrl');
const { createUiClientActionReverseHandler } = await import('./clientActionReverseDispatch');
const { createPluginSurfaceActionHostApi } = await import('@/components/plugins/surfaces/pluginSurfaceActionDispatch');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { runPublishRemediationAction } = await import('@/components/workspaces/scm/update/PublishRemediationAction');
const { createVoiceToolHandlers } = await import('@/voice/tools/handlers');
const { resolveVoiceActionExecution } = await import('@/voice/tools/voiceActionExecution');
const initialState = storage.getState();

describe('external links through answering-client Action composition', () => {
  const opened = vi.fn();
  beforeEach(async () => {
    await homes.reset();
    storage.setState(initialState, true);
    opened.mockReset();
    vi.stubGlobal('open', opened);
  });
  afterEach(() => { vi.unstubAllGlobals(); standardCleanup(); });

  it('keeps Voice external opens on the answering client behind private egress approval', async () => {
    const serverId = await homes.addHome({ name: 'Voice links', serverUrl: 'https://voice-links.test', accountId: 'alice', currentAccount: true });
    const input = { url: 'https://example.test/pull/17?state=private#fragment' };
    expect(resolveVoiceActionExecution({ actionId: 'links.openExternal', input })?.spec.id).toBe('links.openExternal');
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: serverId });
    const cancellation = new AbortController();
    let announceCreated!: () => void;
    const created = new Promise<void>(resolve => { announceCreated = resolve; });
    homes.artifacts(serverId).afterNextCreate(async () => { announceCreated(); });
    const pending = handlers.action_execute!({ actionId: 'links.openExternal', input }, { serverId, signal: cancellation.signal, effectId: 'voice-external-open' });
    try {
      expect(await Promise.race([
        created.then(() => ({ kind: 'approval' })),
        pending.then(result => ({ kind: 'settled', result: JSON.parse(result) })),
      ])).toEqual({ kind: 'approval' });
      const ask = homes.artifacts(serverId).list()[0]!;
      const request = ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(ask.id) ?? 'null'));
      expect(request).toMatchObject({ actionId: 'links.openExternal', requestedSurface: 'voice', actionArgs: {} });
      expect(JSON.stringify(request)).not.toContain(input.url);
      expect(opened).not.toHaveBeenCalled();
    } finally {
      cancellation.abort();
      await pending;
    }
    const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'links.openExternal': ['voice'] } });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1 } }, version: 2 } });
    storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1 } }));
    expect(JSON.parse(await handlers.action_execute!({ actionId: 'links.openExternal', input }, { serverId })))
      .toEqual({ ok: true, result: { status: 'opened' } });
    expect(opened).toHaveBeenCalledExactlyOnceWith(input.url, '_blank', 'noopener,noreferrer');
  });

  it('keeps an acknowledged open when the invocation is cancelled by the platform effect', async () => {
    const serverId = await homes.addHome({ name: 'Links', serverUrl: 'https://links.test', accountId: 'alice' });
    const lifetime = new AbortController();
    opened.mockImplementationOnce(() => { lifetime.abort(); });
    expect(await createDefaultActionExecutor().execute(ActionIdSchema.parse('links.openExternal'),
      { url: 'https://example.test/docs' }, { surface: 'ui', serverId, signal: lifetime.signal }))
      .toEqual({ ok: true, result: { status: 'opened' } });
    expect(opened).toHaveBeenCalledExactlyOnceWith('https://example.test/docs', '_blank', 'noopener,noreferrer');
  });

  it('returns the typed unavailable result when the platform opener cannot open', async () => {
    const serverId = await homes.addHome({ name: 'Links', serverUrl: 'https://links.test', accountId: 'alice' });
    opened.mockImplementationOnce(() => { throw new Error('Unavailable'); });
    expect(await createDefaultActionExecutor().execute(ActionIdSchema.parse('links.openExternal'),
      { url: 'https://example.test/docs' }, { surface: 'ui', serverId }))
      .toMatchObject({ ok: false, errorCode: 'external_link_unavailable' });
  });

  it('opens a person-clicked documentation link before sign-in through the same local UI authority owner', async () => {
    const restoreAuth = installSignedOutAuthForTest();
    try {
      expect(await requestOpenExternalUrl('https://docs.happier.dev')).toBe(true);
      expect(opened).toHaveBeenCalledExactlyOnceWith('https://docs.happier.dev', '_blank', 'noopener,noreferrer');
    } finally { restoreAuth(); }
  });

  it('refuses local opening with zero popups, then opens an allowed link through the canonical platform effect', async () => {
    const serverId = await homes.addHome({ name: 'Links', serverUrl: 'https://links.test', accountId: 'alice' });
    const id = ActionIdSchema.parse('links.openExternal');
    await storage.getState().activateSettingsScope({ serverId, accountId: 'alice' });
    const disabled = ActionsSettingsV1Schema.parse({ v: 1, actions: { [id]: { enabled: false } } });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1: disabled } }, version: 1 } });
    storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
      actions: { [id]: { enabled: false } } }) } }));
    expect(await requestOpenExternalUrl('https://provider.test/authorize?state=private#fragment', { serverId })).toBe(false);
    expect(opened).not.toHaveBeenCalled();
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 2 } });
    storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }) } }));
    expect(await requestOpenExternalUrl('https://provider.test/authorize?state=private#fragment', { serverId })).toBe(true);
    expect(opened).toHaveBeenCalledExactlyOnceWith('https://provider.test/authorize?state=private#fragment', '_blank', 'noopener,noreferrer');
  });

  it('executes the strict answering-client wire request through the real UI executor', async () => {
    const serverId = await homes.addHome({ name: 'Links', serverUrl: 'https://links.test', accountId: 'alice' });
    const id = ActionIdSchema.parse('links.openExternal');
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'alice', isCurrent: () => true });
    const request = UiActionDispatchRequestV1Schema.parse({ v: 1, actionId: id,
      input: { url: 'https://example.test/docs' }, context: { surface: 'agent', authority: 'account_automation',
        defaultSessionId: 'background-agent' } });
    expect(await receive(JSON.parse(JSON.stringify(request)), { signal: new AbortController().signal }))
      .toEqual({ v: 1, execution: { ok: true, result: { status: 'opened' } } });
    expect(opened).toHaveBeenCalledExactlyOnceWith('https://example.test/docs', '_blank', 'noopener,noreferrer');
  });

  it('refuses an explicit publish-remediation browser link before its platform effect', async () => {
    const restoreAuth = installSignedOutAuthForTest();
    try {
      storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
        actions: { 'links.openExternal': { enabled: false } } }) } }));
      await runPublishRemediationAction({ action: { kind: 'open-browser', disabled: false, followup: {
        kind: 'openUrl', purpose: 'compose', url: 'https://github.com/acme/repo/compare/main...feature',
        allowedBaseUrl: 'https://github.com/acme/repo', urlSafety: { allowedSchemes: ['https:'] },
      } }, setErrorCode: vi.fn() });
      expect(opened).not.toHaveBeenCalled();
    } finally { restoreAuth(); }
  });

  it('applies URL Action policy to the plugin OpenExternal host API without an effect on refusal', async () => {
    const serverId = await homes.addHome({ name: 'Plugin links', serverUrl: 'https://plugin-links.test', accountId: 'alice' });
    await storage.getState().activateSettingsScope({ serverId, accountId: 'alice' });
    let current = true;
    const lifetime = new AbortController();
    const request = PluginUiHostApiRequestEnvelopeV1Schema.parse({ version: 1, requestId: 'plugin-open-link',
      surface: { pluginId: 'acme.links', contributionId: 'links', surfaceId: 'links-1', placement: 'sessionPane',
        platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] },
      method: 'openExternalLink', payload: { url: 'https://example.test/plugin-docs' } });
    const executor = createDefaultActionExecutor();
    const api = createPluginSurfaceActionHostApi({ surfaceContext: request.surface, isCurrent: () => current,
      resourceLifetimeSignal: lifetime.signal,
      callerBinding: { pluginId: 'acme.links', contributionLocalId: 'links', occurrenceId: 'links-current',
        sourceCustody: { kind: 'development', registeredRootId: 'links-fixture' } },
      hostAction: { execute: executor.execute, context: { serverId, expectedAccountId: 'alice', defaultSessionMachineId: 'link-client' } } });
    try {
      const setPolicy = (policy: unknown) => {
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse(policy);
        storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1 } }));
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1 } }, version: 1 } });
      };
      setPolicy({ v: 1, actions: { 'links.openExternal': { disabledSurfaces: ['plugin'] } },
        approvalWaivedSurfaces: { 'links.openExternal': ['ui'] } });
      expect(await api.handleRequest(request)).toMatchObject({ code: 'unavailable' });
      expect(opened).not.toHaveBeenCalled();

      setPolicy({ v: 1 });
      await homes.requireActionApproval(serverId, 'links.openExternal', 'plugin');
      const approvalCancellation = new AbortController();
      const awaitingApproval = api.handleRequest({ ...request, requestId: 'plugin-open-link-approval' }, { signal: approvalCancellation.signal });
      try {
        await vi.waitFor(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
        const artifactId = homes.artifacts(serverId).list()[0]!.id;
        const approval = ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId) ?? 'null'));
        expect(approval).toMatchObject({ requestedSurface: 'plugin', actionArgs: {}, executionOriginV1: {
          authority: 'account_automation', surface: 'plugin', caller: { kind: 'plugin', pluginId: 'acme.links',
            contributionLocalId: 'links' },
        } });
        expect(opened).not.toHaveBeenCalled();
      } finally {
        approvalCancellation.abort();
        await awaitingApproval;
      }
      setPolicy({ v: 1, approvalWaivedSurfaces: { 'links.openExternal': ['plugin'] } });
      expect(await api.handleRequest(request)).toBeNull();
      expect(opened).toHaveBeenCalledExactlyOnceWith('https://example.test/plugin-docs', '_blank', 'noopener,noreferrer');
      opened.mockClear();
      const retiredDuringAdmission = api.handleRequest({ ...request, requestId: 'plugin-open-link-retired' });
      current = false;
      lifetime.abort();
      await expect(retiredDuringAdmission).rejects.toMatchObject({ name: 'AbortError' });
      expect(opened).not.toHaveBeenCalled();
    } finally { lifetime.abort(); api.dispose?.(); }
  });
});
