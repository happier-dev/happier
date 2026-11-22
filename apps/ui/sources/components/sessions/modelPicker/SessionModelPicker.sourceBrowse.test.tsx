import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { ConnectedAccountSessionModelRefV2Schema } from '@happier-dev/protocol/providers/selection/v2';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import {
  createProviderModelProjectionFixture,
  createProviderModelProjectionGroupFixture,
  createProviderSettingsAccountHarness,
  createProviderSettingsHarness,
  installProviderSettingsRpcBoundary,
  installBundledProviderDeclarationsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { t } from '@/text';
import { sessionModelSelectionKey } from './sessionModelSelectionKey';
import type { SessionModelSourceBrowseHandoff } from './SessionModelSourceBrowseHandoff';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';

const { describeProviderModels, projectionRequests } = vi.hoisted(() => ({
  describeProviderModels: vi.fn(),
  projectionRequests: [] as Readonly<{
    serverId: string | null;
    payload: unknown;
  }>[],
}));
// Substitute only Socket delivery; Account admission and neighboring registry
// requests retain their real owners and canonical boundary responses.
const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);

const AGENT = 'agent:happier.agent.codex/codex';
const CUSTOM_PROVIDER_MACHINE = '6a37defb-c9fd-46bd-8b59-5a341cf630a9';
const GATEWAY = ProviderConnectionIdSchema.parse('pc_gateway');
const account = createProviderSettingsAccountHarness();
const { SelectionList } = await import('@/components/ui/selectionList/SelectionList');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
let serverId = '';

function gatewayRow(modelId: string, name: string) {
  return {
    ref: { agentTargetKey: AGENT, providerConnectionId: GATEWAY, modelId },
    descriptor: { id: modelId, name },
    sources: { manual: false, static: true, probe: false },
    confidence: 'verified_static',
    compatibility: {
      result: {
        status: 'verified',
        selectedProtocol: 'openai-responses',
        evidence: {
          sourceUrls: ['https://example.test'],
          verifiedAt: '2026-10-09',
        },
      },
      compatibilityFingerprint: 'compatibility:v1:gateway',
      confirmed: true,
    },
    endpointHealth: 'available',
    catalog: { stale: false },
    loadState: 'unknown',
    visibility: 'visible',
  };
}

const { SessionModelPicker } = await import('./SessionModelPicker');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { SessionModelSourceBrowseHandoffContext } = await import('./SessionModelSourceBrowseHandoff');
const { NewSessionConnectedServicesSelectionContent } = await import('@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent');
await loadSyncSingletonForTests();

afterEach(async () => {
  standardCleanup();
  await account.reset();
  rpc.reset();
  describeProviderModels.mockReset();
  projectionRequests.length = 0;
});
beforeEach(async () => {
  rpc.state.machines.push(createMachineFixture({ id: CUSTOM_PROVIDER_MACHINE, activeAt: Date.now() }));
  installBundledProviderDeclarationsRpcBoundary(rpc);
  rpc.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, request => {
    projectionRequests.push(request);
    return describeProviderModels(request.payload);
  });
  serverId = (
    await account.restore({ waivedActions: ['providers.models.refresh'] })
  ).serverId;
});

describe('SessionModelPicker source browsing', () => {
  it.each([
    ['pi', 'openai-responses'], ['opencode', 'openai-responses'], ['codex', 'openai-responses'], ['claude', 'anthropic'],
  ] as const)('selects a managed Muse model from the CLIProxyAPI purpose for %s', async (agentId, protocol) => {
    const agentTargetKey = `agent:happier.agent.${agentId}/${agentId}`;
    const selected = ConnectedAccountSessionModelRefV2Schema.parse({ source: 'connected_account', agentTargetKey,
      modelId: 'muse-spark-1.3-contributor', endpointTemplateId: `cliproxyapi-${protocol}`,
      purpose: { consumer: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' }, purpose: 'meta-upstream' },
    });
    const binding = { purpose: selected.purpose, target: { kind: 'account', account: {
      service: { pluginId: 'happier.agent.muse', localId: 'muse-account' }, accountId: 'my-muse',
    } } } as const;
    const row = gatewayRow(selected.modelId, 'Muse Spark');
    describeProviderModels.mockImplementation((payload: { connectedServices?: unknown }) => createProviderModelProjectionFixture({
      agentTargetKey, groups: payload.connectedServices ? [createProviderModelProjectionGroupFixture({
        connectionId: 'connected-source:muse', providerName: 'CLIProxyAPI', connectionName: 'My Muse account',
        connectedAccountTarget: binding.target, rows: [{ ...row, ref: selected, gatewaySlots: [binding],
          compatibility: { ...row.compatibility, result: { ...row.compatibility.result, selectedProtocol: protocol } } }],
      })] : [],
    }));
    const choose = vi.fn();
    const screen = await renderScreen(<SessionModelPicker agentTargetKey={agentTargetKey}
      declarationContext={{ kind: 'account' }} nativeModels={[]} providerGroups={[]}
      providerProjectionAuthoritative selected={null} onSelect={choose} includeProviderConnectedAccounts
      sourceBrowse={{ machineId: CUSTOM_PROVIDER_MACHINE, serverId }} />);
    const optionId = `model-picker-overlay-option:${sessionModelSelectionKey(selected)}`;
    await waitForHomeGovernance(() => expect(screen.findByTestId(optionId)).not.toBeNull());
    await screen.pressByTestIdAsync(optionId);
    expect(choose).toHaveBeenCalledWith(selected, binding);
  });
  it('reselects an unavailable intermediate tuple as the typed Provider-purpose model and binding', async () => {
    const modelId = 'openai/gpt-5';
    const legacy = { agentTargetKey: AGENT, providerConnectionId: ProviderConnectionIdSchema.parse('connected-source:previous-release'), modelId };
    const exact = ConnectedAccountSessionModelRefV2Schema.parse({ source: 'connected_account', agentTargetKey: AGENT, modelId,
      purpose: { consumer: { pluginId: 'happier.provider.vercel-ai-gateway', localId: 'vercel-ai-gateway' }, purpose: 'model-inference' },
      endpointTemplateId: 'vercel-responses',
    });
    const binding = { purpose: exact.purpose, target: { kind: 'account', account: {
      service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'work',
    } } } as const;
    describeProviderModels.mockImplementation((payload: { connectedServices?: unknown }) => createProviderModelProjectionFixture({
      agentTargetKey: AGENT, groups: payload.connectedServices ? [createProviderModelProjectionGroupFixture({
        connectionId: 'connected-source:vercel-work', providerName: 'Vercel AI Gateway', connectionName: 'Vercel work',
        connectedAccountTarget: binding.target,
        rows: [{ ...gatewayRow(modelId, 'Vercel model'), ref: exact, gatewaySlots: [binding] }],
      })] : [],
    }));
    const choose = vi.fn();
    const screen = await renderScreen(<SessionModelPicker agentTargetKey={AGENT}
      declarationContext={{ kind: 'account' }} nativeModels={[]} providerGroups={[]}
      providerProjectionAuthoritative selected={legacy} onSelect={choose} includeProviderConnectedAccounts
      sourceBrowse={{ machineId: CUSTOM_PROVIDER_MACHINE, serverId }} />);
    await waitForHomeGovernance(() => {
      expect(screen.findByType(SelectionList).props.selectedOptionId).toBe(sessionModelSelectionKey(legacy));
      expect(screen.findByTestId(`model-picker-overlay-option:${sessionModelSelectionKey(exact)}`)).not.toBeNull();
    });
    expect(choose).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync(`model-picker-overlay-option:${sessionModelSelectionKey(exact)}`);
    expect(choose).toHaveBeenCalledWith(exact, binding);
  });
  it.each(['authorization', 'action'] as const)('shows the typed %s refusal instead of declaring the scoped Provider empty', async (source) => {
    const connectionId = 'pc_ca67d5e0-7dda-481e-a394-a5351ae770b9';
    const machineId = CUSTOM_PROVIDER_MACHINE;
    const error = createProviderErrorV1('provider_not_enabled_on_machine', { connectionId, machineId,
      ...(source === 'action' ? { requestId: 'custom-models-request' } : {}) });
    describeProviderModels.mockResolvedValue(source === 'action' ? { status: 'error', error }
      : createProviderModelProjectionFixture({ agentTargetKey: AGENT, groups: [createProviderModelProjectionGroupFixture({
        connectionId, providerName: 'Custom Responses', connectionName: 'Custom Responses',
        authorization: { authorized: false, error }, rows: [],
      })] }));
    const onSelect = vi.fn();
    const screen = await renderScreen(<SessionModelSourceBrowseHandoffContext.Provider value={{
      request: { agentTargetKey: AGENT, scope: { connectionId, label: 'Custom Responses' }, key: 1 }, browse: () => {},
    }}><SessionModelPicker agentTargetKey={AGENT} nativeModels={[]} providerGroups={[]}
      providerProjectionAuthoritative selected={null} sourceBrowse={{ machineId, serverId }} onSelect={onSelect} />
    </SessionModelSourceBrowseHandoffContext.Provider>);
    await flushHookEffects();
    await waitForHomeGovernance(() => {
      expect(projectionRequests.at(-1)?.payload).toMatchObject({ machineId, sourceConnectionId: connectionId });
      const failure = screen.findAllByType(SurfaceStateCard).find(card => card.props.diagnosticCode === error.code);
      expect(failure?.props.diagnosticCode).toBe('provider_not_enabled_on_machine');
      expect(failure?.props.diagnosticDetail).toBe(source === 'action' ? 'custom-models-request' : null);
      expect(failure?.props.action?.testID).toBe(`provider-error-action:${error.code}`);
    });
    expect(screen.findByTestId('model-picker-overlay-empty')).toBeNull();
    expect(screen.findByTestId('model-picker-source-scope-back')).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('commits its own sign-in when a native model is picked, including the already selected model', async () => {
    const serviceId = 'happier.agent.codex/openai-codex';
    function Composer() {
      const [bindings, setBindings] = React.useState<Record<string, ConnectedServicesServiceBinding>>({
        [serviceId]: { source: 'connected', selection: 'group', groupId: 'codex-pool' },
      });
      const [request, setRequest] = React.useState<SessionModelSourceBrowseHandoff['request']>(null);
      return <SessionModelSourceBrowseHandoffContext.Provider value={{
        request,
        browse: (agentTargetKey, scope, onSelect?: () => void) => setRequest({ agentTargetKey, scope, key: 1, onSelect }),
      }}>
        <NewSessionConnectedServicesSelectionContent nativeAgentTargetKey={AGENT}
          appliedRoute={{ kind: 'native', sourceLabel: 'Codex pool', authSource: 'connected', connectedCount: 1, modelId: 'gpt-6.1-sol' }}
          supportedServiceIds={[serviceId]} profileOptionsByServiceId={{}} groupOptionsByServiceId={{}}
          bindingsByServiceId={bindings}
          setBindingForService={(key, value) => setBindings(current => ({ ...current, [key]: value }))}
          onOpenSettings={() => {}} maxHeight={420} />
        {request ? <SessionModelPicker agentTargetKey={AGENT}
          nativeModels={[{ value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }]}
          providerGroups={[]} providerProjectionAuthoritative
          selected={{ agentTargetKey: AGENT, providerConnectionId: null, modelId: 'gpt-6.1-sol' }}
          onSelect={() => setRequest(null)} /> : null}
      </SessionModelSourceBrowseHandoffContext.Provider>;
    }
    const token = account.home.findByServerUrl('https://provider-settings-account.test')?.token;
    if (!token) throw new Error('Expected the admitted synthetic Account credentials');
    const screen = await renderScreen(<InjectedAuthProvider credentials={{ token }}><Composer /></InjectedAuthProvider>);
    const sourceList = () => screen.findAllByType(SelectionList).find(list => list.props.testID === 'new-session.connected-services.selection-list')!;
    const nativeRow = sourceList().props.rootStep.sections.flatMap((section: { options: { id: string; onSelect: () => void }[] }) => section.options)
      .find((option: { id: string }) => option.id.startsWith('route-source:native:'));
    expect(sourceList().props.selectedOptionId).not.toBe(nativeRow.id);
    await act(async () => nativeRow.onSelect());
    expect(sourceList().props.selectedOptionId).not.toBe(nativeRow.id);
    const modelList = screen.findAllByType(SelectionList).find(list => list.props.testID !== 'new-session.connected-services.selection-list')!;
    const modelRow = modelList.props.rootStep.sections.flatMap((section: { options: { id: string }[] }) => section.options)[0];
    await act(async () => modelList.props.onSelect(modelRow.id));
    expect(screen.findByTestId('model-picker-source-scope-back')).toBeNull();
    expect(sourceList().props.selectedOptionId).toBe(nativeRow.id);
  });

  it('hands off the composer native row once for its exact Agent without changing service bindings', async () => {
    const browse = vi.fn();
    const setBindingForService = vi.fn();
    const nativeAgentTargetKey = 'agent:acme.agent/reviewer';
    const token = account.home.findByServerUrl('https://provider-settings-account.test')?.token;
    if (!token) throw new Error('Expected the admitted synthetic Account credentials');
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={{ token }}>
      <SessionModelSourceBrowseHandoffContext.Provider value={{ request: null, browse }}>
        <NewSessionConnectedServicesSelectionContent
          nativeAgentTargetKey={nativeAgentTargetKey}
          appliedRoute={{ kind: 'native', sourceLabel: 'Own sign-in', authSource: 'native', connectedCount: 0, modelId: null }}
          supportedServiceIds={['acme.service/subscription', 'acme.service/api-key']}
          profileOptionsByServiceId={{}}
          groupOptionsByServiceId={{}}
          bindingsByServiceId={{}}
          setBindingForService={setBindingForService}
          onOpenSettings={() => {}}
          maxHeight={420}
        />
      </SessionModelSourceBrowseHandoffContext.Provider>
      </InjectedAuthProvider>,
    );
    const list = screen.findByType(SelectionList);
    const options = list.props.rootStep.sections.flatMap((section: { options: { id: string; onSelect?: () => void }[] }) => section.options);
    const nativeRows = options.filter((option: { id: string }) => option.id.startsWith('route-source:native:'));
    expect(nativeRows).toHaveLength(1);
    expect(list.props.selectedOptionId).toBe(nativeRows[0].id);
    await act(async () => { nativeRows[0].onSelect(); });
    expect(browse).toHaveBeenCalledWith(nativeAgentTargetKey, {
      connectionId: null, label: t('connectedServices.authModal.nativeAuthTitle'),
    }, expect.any(Function));
    expect(setBindingForService).not.toHaveBeenCalled();
  });

  it.each([true, false])('browses the exact Agent native models without a Provider request or committing until a model is picked (Provider browsing %s)', async (providerBrowsing) => {
    const onSelect = vi.fn();
    const nativeRef = { agentTargetKey: AGENT, providerConnectionId: null, modelId: 'gpt-6.1-sol' };
    const screen = await renderScreen(
      <SessionModelSourceBrowseHandoffContext.Provider value={{
        request: { agentTargetKey: AGENT, scope: { connectionId: null, label: 'Codex' }, key: 1 },
        browse: () => {},
      }}>
        <SessionModelPicker
          agentTargetKey={AGENT}
          nativeModels={[{ value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }]}
          providerGroups={[createProviderModelProjectionGroupFixture({
            connectionId: 'pc_gateway', rows: [gatewayRow('fable-5.1', 'Fable 5.1')],
          })]}
          providerProjectionAuthoritative
          selected={{ agentTargetKey: AGENT, providerConnectionId: GATEWAY, modelId: 'fable-5.1' }}
          sourceBrowse={providerBrowsing ? { machineId: 'machine-a', serverId } : undefined}
          favoriteEntries={[{ ref: { agentTargetKey: AGENT, providerConnectionId: GATEWAY, modelId: 'fable-5.1' }, label: 'Fable 5.1' }]}
          onSelect={onSelect}
        />
      </SessionModelSourceBrowseHandoffContext.Provider>,
    );
    await flushHookEffects();
    expect(projectionRequests).toHaveLength(0);
    expect(screen.findByTestId('model-picker-source-scope-back')).not.toBeNull();
    const list = screen.findByType(SelectionList);
    const options = list.props.rootStep.sections.flatMap((section: { options: { id: string; label: string }[] }) => section.options);
    expect(options.map((option: { label: string }) => option.label)).toEqual(['GPT-6.1 Sol']);
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => { list.props.onSelect(options[0].id); });
    expect(onSelect).toHaveBeenCalledWith(nativeRef);
    await act(async () => { screen.findByTestId('model-picker-source-scope-back')!.props.onPress(); });
    expect(screen.findByTestId('model-picker-source-scope-back')).toBeNull();
    expect(screen.getTextContent()).toContain('Fable 5.1');
  });

  it('reaches a source hidden from the picker, browses it in place, and commits only a picked model', async () => {
    describeProviderModels.mockResolvedValue(
      createProviderModelProjectionFixture({
        agentTargetKey: AGENT,
        groups: [
          createProviderModelProjectionGroupFixture({
            connectionId: 'pc_gateway',
            providerName: 'Main gateway',
            connectionName: 'Main gateway',
            rows: [gatewayRow('fable-5.1', 'Fable 5.1'), gatewayRow('fable-5.2', 'Fable 5.2')],
          }),
        ],
      }),
    );
    const selected = {
      agentTargetKey: AGENT,
      providerConnectionId: null,
      modelId: 'gpt-6.1-sol',
    };
    const onSelect = vi.fn();
    const onToggleFavorite = vi.fn();
    const favoriteRef = { agentTargetKey: AGENT, providerConnectionId: GATEWAY, modelId: 'fable-5.1' };
    const screen = await renderScreen(
      <SessionModelPicker
        multiColumn
        agentTargetKey={AGENT}
        nativeModels={[{ value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }]}
        providerGroups={[]}
        providerProjectionAuthoritative
        selected={selected}
        hiddenSources={[
          {
            connectionId: GATEWAY,
            providerName: 'Main gateway',
            connectionName: 'Main gateway',
            connectionRole: 'default',
            connectionDisplayNameMode: 'automatic',
            modelCount: 1,
          },
        ]}
        sourceBrowse={{ machineId: 'machine-a', serverId }}
        onSelect={onSelect}
        favoriteKeys={new Set([sessionModelSelectionKey(favoriteRef)])}
        onToggleFavorite={onToggleFavorite}
        favoriteActionVisibility="all"
        favoriteEntries={[{ ref: selected, label: 'GPT-6.1 Sol' }]}
      />,
    );
    // Ordinary browse makes no scoped request until the person reaches for the source.
    expect(projectionRequests).toHaveLength(0);
    const link = screen.findByTestId('model-picker-hidden-source:pc_gateway');
    expect(link).not.toBeNull();
    await act(async () => {
      (link!.props.onPress as () => void)();
    });
    await flushHookEffects();

    expect(projectionRequests.at(-1)?.payload).toMatchObject({
      sourceConnectionId: 'pc_gateway',
      currentSelection: selected,
    });
    expect(screen.findByTestId('model-picker-source-scope-back')).not.toBeNull();
    // The way here was the list it left: the browsed source does not say it is hidden from it.
    expect(screen.getTextContent()).not.toContain(t('agentInput.model.hiddenFromMainPicker'));
    const optionLabels = () =>
      (
        screen.findByType(SelectionList).props.rootStep
          .sections as ReadonlyArray<{
          options: ReadonlyArray<{ id: string; label: string }>;
        }>
      ).flatMap((section) => section.options.map((option) => option.label));
    // Only the browsed source; the native selection elsewhere is not reported as missing.
    await waitForHomeGovernance(() => expect(optionLabels()).toEqual(['Fable 5.1', 'Fable 5.2']));
    // The scope bar already names the one source; its group heading would say it twice.
    expect((screen.findByType(SelectionList).props.rootStep.sections as ReadonlyArray<{ title?: string }>)
      .map((section) => section.title)).toEqual([undefined]);
    expect(onSelect).not.toHaveBeenCalled();
    const favoriteTestID = `model-picker-overlay-option-favorite:${sessionModelSelectionKey(favoriteRef)}`;
    await waitForHomeGovernance(() => expect(screen.findByTestId(favoriteTestID)).not.toBeNull());
    const favorite = screen.findByTestId(favoriteTestID);
    expect(favorite).not.toBeNull();
    expect(favorite!.props.accessibilityLabel).toContain(t('profiles.actions.removeFromFavorites'));
    const otherRef = { ...favoriteRef, modelId: 'fable-5.2' };
    const otherFavorite = screen.findByTestId(`model-picker-overlay-option-favorite:${sessionModelSelectionKey(otherRef)}`);
    expect(otherFavorite).not.toBeNull();
    expect(otherFavorite!.props.accessibilityLabel).toContain(t('profiles.actions.addToFavorites'));
    await act(async () => { favorite!.props.onPress(); });
    expect(onToggleFavorite).toHaveBeenCalledWith(favoriteRef);
    expect(onSelect).not.toHaveBeenCalled();

    // Back returns to every shown source without committing anything.
    const back = screen.findByTestId('model-picker-source-scope-back');
    await act(async () => {
      (back!.props.onPress as () => void)();
    });
    expect(screen.findByTestId('model-picker-source-scope-back')).toBeNull();
    expect(optionLabels()).toEqual(['GPT-6.1 Sol']);
    expect(onSelect).not.toHaveBeenCalled();

    // Browsing again and picking a card commits exactly that model and its source.
    await act(async () => {
      (
        screen.findByTestId('model-picker-hidden-source:pc_gateway')!.props
          .onPress as () => void
      )();
    });
    await flushHookEffects();
    const list = screen.findByType(SelectionList);
    const fable = (
      list.props.rootStep.sections as ReadonlyArray<{
        options: ReadonlyArray<{ id: string; label: string }>;
      }>
    )
      .flatMap((section) => section.options)
      .find((option) => option.label === 'Fable 5.1');
    await act(async () => {
      (list.props.onSelect as (id: string) => void)(fable!.id);
    });
    expect(onSelect).toHaveBeenCalledWith({
      agentTargetKey: AGENT,
      providerConnectionId: 'pc_gateway',
      modelId: 'fable-5.1',
    });
  });

  it('offers no hidden-source line where the host cannot browse', async () => {
    const screen = await renderScreen(
      <SessionModelPicker
        agentTargetKey={AGENT}
        nativeModels={[{ value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }]}
        providerGroups={[]}
        providerProjectionAuthoritative
        selected={null}
        hiddenSources={[
          {
            connectionId: GATEWAY,
            providerName: 'Main gateway',
            connectionName: 'Main gateway',
            connectionRole: 'default',
            connectionDisplayNameMode: 'automatic',
            modelCount: 1,
          },
        ]}
        onSelect={() => {}}
      />,
    );
    expect(screen.findByTestId('model-picker-hidden-sources')).toBeNull();
  });

  it('drops an old native scope when the Agent changes in the mounted picker', async () => {
    const picker = (agentTargetKey: string) => <SessionModelSourceBrowseHandoffContext.Provider value={{
      request: { agentTargetKey: AGENT, scope: { connectionId: null, label: 'Codex' }, key: 1 },
      browse: () => {},
    }}>
      <SessionModelPicker agentTargetKey={agentTargetKey}
        nativeModels={[{ value: 'native-model', label: 'Native model' }]}
        providerGroups={[]} providerProjectionAuthoritative selected={null}
        onSelect={() => {}} />
    </SessionModelSourceBrowseHandoffContext.Provider>;
    const screen = await renderScreen(picker(AGENT));
    expect(screen.findByTestId('model-picker-source-scope-back')).not.toBeNull();
    await screen.update(picker('agent:acme.agent/reviewer'));
    expect(screen.findByTestId('model-picker-source-scope-back')).toBeNull();
  });

  it('opens on the source "Runs through" asked for, only for the Agent it was asked for, and commits nothing', async () => {
    describeProviderModels.mockResolvedValue(
      createProviderModelProjectionFixture({
        agentTargetKey: AGENT,
        groups: [
          createProviderModelProjectionGroupFixture({
            connectionId: 'pc_gateway',
            providerName: 'Main gateway',
            connectionName: 'Main gateway',
            rows: [gatewayRow('fable-5.1', 'Fable 5.1')],
          }),
        ],
      }),
    );
    const onSelect = vi.fn();
    const picker = (agentTargetKey: string) => (
      <SessionModelSourceBrowseHandoffContext.Provider
        value={{
          request: { agentTargetKey: AGENT, scope: { connectionId: 'pc_gateway', label: 'Main gateway' }, key: 1 },
          browse: () => {},
        }}
      >
        <SessionModelPicker
          multiColumn
          agentTargetKey={agentTargetKey}
          nativeModels={[{ value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }]}
          providerGroups={[]}
          providerProjectionAuthoritative
          selected={null}
          sourceBrowse={{ machineId: 'machine-a', serverId }}
          onSelect={onSelect}
        />
      </SessionModelSourceBrowseHandoffContext.Provider>
    );
    const screen = await renderScreen(picker(AGENT));
    await flushHookEffects();
    expect(screen.findByTestId('model-picker-source-scope-back')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain(t('agentInput.model.hiddenFromMainPicker'));
    expect(projectionRequests.at(-1)?.payload).toMatchObject({ sourceConnectionId: 'pc_gateway' });
    expect(onSelect).not.toHaveBeenCalled();
    await screen.unmount();

    const other = await renderScreen(picker('agent:happier.agent.claude/claude'));
    await flushHookEffects();
    expect(other.findByTestId('model-picker-source-scope-back')).toBeNull();
  });
});
