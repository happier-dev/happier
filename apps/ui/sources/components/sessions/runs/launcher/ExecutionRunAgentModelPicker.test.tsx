import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installBundledProviderDeclarationsRpcBoundary, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { SelectionList } from '@/components/ui/selectionList';

// Home HTTP, daemon delivery and native UI are the only substituted boundaries.
const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { ExecutionRunAgentModelPicker } = await import('./ExecutionRunAgentModelPicker');
const { resolveExecutionRunLauncherBackendChoices } = await import('./resolveExecutionRunLauncherBackendChoices');
const { ModalProvider } = await import('@/modal');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');

afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); });

it('authors a native runner account through the same controlled account picker as an Agent reviewer', async () => {
    const machineId = '6a37defb-c9fd-46bd-8b59-5a341cf630a9';
    rpc.state.machines.push(createMachineFixture({ id: machineId, activeAt: Date.now() }));
    installBundledProviderDeclarationsRpcBoundary(rpc);
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const profile = AccountProfileSchema.parse({ id: 'account-a', connectedAccountsV4: [{
        revisionSemantics: 'legacy_unfenced', ref: { service, accountId: 'work' },
        status: 'connected', authenticationModeId: null, configurationReady: true, configurationRevision: null,
        credentialRevision: null, kind: 'oauth', expiresAt: null, lastUsedAt: null, providerIdentity: {},
    }] });
    const { serverId } = await account.restore({ waivedActions: ['providers.models.refresh'],
        httpAnswers: { '/v1/account/profile': { body: profile } } });
    installConnectedAccountDescriptorProjection({ scopeKey: 'execution-account', status: 'ready', descriptors: [{
        id: service.localId, serviceId: service.localId, pluginId: service.pluginId, provenance: 'first_party', sourceKind: 'bundled', title: 'Codex',
        authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode',
            callbackUrl: 'http://127.0.0.1:4000/auth/callback', scopes: ['openid'], pkce: 'required', outcomeReconciliation: 'none' }] },
        capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    }], conflicts: [], errorReason: null });
    const choice = resolveExecutionRunLauncherBackendChoices({ intent: 'review', enabledAgentIds: ['codex'], executionRunsBackends: {},
        reviewEngines: [{ engineId: 'codex', value: 'agent:happier.agent.codex/codex', label: 'Codex', enabled: true,
            available: true, capabilities: { structuredNarration: false } }] })[0];
    if (!choice) throw new Error('Expected the canonical Codex reviewer choice');
    let current: Record<string, unknown> = {};
    function Host() {
        const [input, setInput] = React.useState<Record<string, unknown>>({});
        current = input;
        return <ExecutionRunAgentModelPicker choice={choice} sessionId={null} serverId={serverId} machineId={machineId}
            providerProtocols={[]} actionInput={input} selected={null} inheritedTeamCredentialModel={null}
            selectBackend={() => undefined} setActionInput={setInput} />;
    }
    const token = account.home.findByServerUrl('https://provider-settings-account.test')?.token;
    if (!token) throw new Error('Expected the admitted synthetic Account credentials');
    const screen = await renderScreen(<InjectedAuthProvider credentials={{ token }}><ModalProvider><Host /></ModalProvider></InjectedAuthProvider>);
    expect(screen.findByTestId('execution-run-native-account')).not.toBeNull();
    const restricted = await renderScreen(<InjectedAuthProvider credentials={{ token }}><ModalProvider>
        <ExecutionRunAgentModelPicker choice={choice} sessionId={null} serverId={serverId} machineId={machineId}
            connectedAccountPurposes={[]} providerProtocols={[]} actionInput={{}} selected={null}
            inheritedTeamCredentialModel={null} selectBackend={() => undefined} setActionInput={() => undefined} />
    </ModalProvider></InjectedAuthProvider>);
    expect(restricted.findByTestId('execution-run-native-account')).toBeNull();
    await restricted.unmount();
    const popover = screen.findAllByType(AgentInputContentPopover)[0];
    if (!popover) throw new Error('Expected the existing native account picker');
    const content = popover.props.content;
    if (typeof content !== 'function') throw new Error('Expected native account content');
    const picker = await renderScreen(<InjectedAuthProvider credentials={{ token }}>{content({ maxHeight: 420, requestClose() {} })}</InjectedAuthProvider>);
    try {
        const options = picker.findByType(SelectionList).props.rootStep.sections
            .flatMap((section: { options: readonly { id: string; onSelect?: () => void }[] }) => section.options);
        const work = options.find((option: { id: string }) => option.id.endsWith(':profile:work'));
        if (!work?.onSelect) throw new Error('Expected the enrolled Work account');
        await act(async () => { await work.onSelect(); });
        expect(current.connectedServices).toMatchObject({ v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        } });
        expect(current.modelSelection).toBeUndefined();
    } finally { await picker.unmount(); }
});


it('offers an account-only engine its declared purpose without a model picker', async () => {
    const service = { pluginId: 'happier.review.coderabbit', localId: 'coderabbit-account' };
    const profile = AccountProfileSchema.parse({ id: 'account-a', connectedAccountsV4: [{
        revisionSemantics: 'legacy_unfenced', ref: { service, accountId: 'work' },
        status: 'connected', authenticationModeId: null, configurationReady: true, configurationRevision: null,
        credentialRevision: null, kind: 'oauth', expiresAt: null, lastUsedAt: null, providerIdentity: {},
    }] });
    const { serverId } = await account.restore({ waivedActions: ['providers.models.refresh'],
        httpAnswers: { '/v1/account/profile': { body: profile } } });
    const choice = resolveExecutionRunLauncherBackendChoices({ intent: 'review', enabledAgentIds: ['coderabbit'], executionRunsBackends: {},
        reviewEngines: [{ engineId: 'coderabbit', value: 'agent:happier.review.coderabbit/coderabbit', label: 'CodeRabbit', enabled: true,
            available: true, capabilities: { structuredNarration: false } }] })[0];
    if (!choice) throw new Error('Expected the declared CodeRabbit engine');
    const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
    const { ExactModelChoicePicker } = await import('@/components/sessions/modelPicker/useExactModelChoice');
    let current: Record<string, unknown> = {};
    function Host() {
        const [input, setInput] = React.useState<Record<string, unknown>>({});
        current = input;
        return <ExecutionRunAgentModelPicker choice={choice} sessionId={null} serverId={serverId} machineId={null}
            actionInput={input} selected={null} inheritedTeamCredentialModel={null}
            selectBackend={() => undefined} setActionInput={setInput} />;
    }
    const token = account.home.findByServerUrl('https://provider-settings-account.test')?.token;
    if (!token) throw new Error('Expected synthetic Account credentials');
    const screen = await renderScreen(<InjectedAuthProvider credentials={{ token }}><ModalProvider><Host /></ModalProvider></InjectedAuthProvider>);
    const chooser = screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0];
    expect(chooser).toBeDefined();
    expect(screen.findAllByType(ExactModelChoicePicker)).toHaveLength(0);
    const declaration = choice.agentCatalogEntry!.connectedAccounts[0]!;
    expect(chooser!.props.declaration).toMatchObject(declaration);
    expect(screen.getTextContent()).toContain('CodeRabbit’s own sign-in');
    await act(async () => chooser!.props.onChange({ kind: 'account', account: { service: declaration.service, accountId: 'work' } }, null));
    expect(current.connectedServices).toMatchObject({ v: 2, bindingsByServiceId: {
        [declaration.service.pluginId + '/' + declaration.service.localId]: { source: 'connected', selection: 'profile', profileId: 'work' },
    } });
    expect(current.modelSelection).toBeUndefined();
});


it('offers the shared connect sheet instead of an empty account picker when an engine has no accounts', async () => {
    const { serverId } = await account.restore({ waivedActions: ['providers.models.refresh'] });
    const choice = resolveExecutionRunLauncherBackendChoices({ intent: 'review', enabledAgentIds: ['coderabbit'], executionRunsBackends: {},
        reviewEngines: [{ engineId: 'coderabbit', value: 'agent:happier.review.coderabbit/coderabbit', label: 'CodeRabbit', enabled: true,
            available: true, capabilities: { structuredNarration: false } }] })[0]!;
    const token = account.home.findByServerUrl('https://provider-settings-account.test')?.token;
    if (!token) throw new Error('Expected synthetic Account credentials');
    const screen = await renderScreen(<InjectedAuthProvider credentials={{ token }}><ModalProvider>
        <ExecutionRunAgentModelPicker choice={choice} sessionId={null} serverId={serverId} machineId={null}
            actionInput={{}} selected={null} inheritedTeamCredentialModel={null}
            selectBackend={() => undefined} setActionInput={() => undefined} />
    </ModalProvider></InjectedAuthProvider>);
    expect(screen.findByTestId('execution-run-account:coderabbit:connect')).not.toBeNull();
    await screen.pressByTestIdAsync('execution-run-account:coderabbit:connect');
    const { ConnectSheetContent } = await import('@/components/settings/connectedServices/setup/ConnectSheetContent');
    expect(screen.findAllByType(ConnectSheetContent)[0]?.props.request).toMatchObject({
        intent: 'add', service: choice.agentCatalogEntry!.connectedAccounts[0]!.service,
    });
});
