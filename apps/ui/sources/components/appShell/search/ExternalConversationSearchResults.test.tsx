import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema, makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol';
import { createDeferred, createMachineFixture, findAllHostTestInstances, flushHookEffects, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';

const boundary = vi.hoisted(() => ({ list: vi.fn(), ensure: vi.fn(), page: vi.fn(), projection: vi.fn(), routerPush: vi.fn(), serverId: '' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Legend's native scrolling is a platform boundary; the browser and paging owner remain real.
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ renderItems: true }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: boundary.routerPush } }).module;
});
// Applied Home identity is a process/connection boundary; scope and credential fencing remain real.
vi.mock('@/sync/runtime/orchestration/appliedActiveServerRuntime', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/appliedActiveServerRuntime')>(),
    getAppliedActiveServerSnapshot: () => ({ serverId: boundary.serverId }),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { answerMachineProjectionDescribeAtRpcBoundary } = await import('@/dev/testkit/mocks/machineProjectionRpc');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { DEFAULT_MEMORY_SETTINGS } = await import('@happier-dev/protocol/memory/memorySettings');
    const describe = answerMachineProjectionDescribeAtRpcBoundary(boundary.projection);
    return { machineRpcWithServerScope: (params: Parameters<typeof describe>[0]) => params.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET
        ? Promise.resolve(DEFAULT_MEMORY_SETTINGS) : describe(params) };
});
vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionsCandidatesList: boundary.list,
    machineExternalSessionLinkEnsure: boundary.ensure,
    machineExternalSessionTranscriptPage: boundary.page,
}));

import { ExternalConversationSearchResults } from './ExternalConversationSearchResults';
import { resolveExternalSessionBrowseSourceOptions } from '@/components/sessions/external/browse/resolveExternalSessionBrowseSourceOptions';

let scopeOwner: typeof import('@/sync/domains/scope/activeServerAccountScope');

function projection(contentSearch?: boolean) {
    return PluginProjectionV2Schema.parse({
        v: 2, generation: 1,
        installedPackagesById: {
            'happier.external-sessions-fixture': { id: 'happier.external-sessions-fixture', displayName: 'Codex', enabled: true, source: { kind: 'bundled', locator: 'happier.external-sessions-fixture' } },
        },
        agentsById: {
            codex: { id: 'codex', title: 'Codex', externalSessions: {
                agent: { pluginId: 'happier.external-sessions-fixture', localId: 'codex' }, generation: 1,
                operations: { listCandidates: true, resolveLinkIdentity: true, pageTranscript: true, readAfterTranscript: true },
                sources: [{
                    sourceKind: 'codexHome', ...(contentSearch === undefined ? {} : { contentSearch }),
                    schema: { fields: [{ name: 'kind', kind: 'literal', value: 'codexHome' }, { name: 'home', kind: 'literal', value: 'user' }] },
                    key: { segments: [{ kind: 'literal', value: 'codexHome' }] },
                    instances: [{ kind: 'default', constants: { home: 'user' } }],
                }],
            } },
        },
    });
}

const hit = { remoteSessionId: 'hit', title: 'Unrelated title', updatedAtMs: 1,
    match: { snippet: 'A body-only phrase', sourceItemId: 'source-item', messageIndex: 91 } };
const page = { ok: true, candidates: [hit, { remoteSessionId: 'native-only', title: 'Native thread', updatedAtMs: 1 }], nextCursor: 'next', contentCoverage: 'partial' } as const;
const transcriptPage = { ok: true, hasMore: false, items: [
    { id: 'prompt', createdAtMs: 1, raw: { role: 'user', content: { type: 'text', text: 'Explain this failure' } } },
    { id: 'source-item', createdAtMs: 2, raw: { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'text', text: 'A body-only phrase in the full response' } } } },
] } satisfies Extract<Awaited<ReturnType<typeof import('@/sync/ops/machineExternalSessions').machineExternalSessionTranscriptPage>>, { ok: true }>;

function props() {
    const accountLifetime = scopeOwner.captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Account fixture did not mount');
    return {
        target: { machineId: 'machine-1', serverId: boundary.serverId, accountId: 'account-a' },
        query: 'body-only phrase', machineLabel: 'Devbox', accountLifetime,
        onBack: vi.fn(), onRequestClose: vi.fn(), onOpenSession: vi.fn(),
    };
}

function sourceKey() {
    const option = resolveExternalSessionBrowseSourceOptions({
        accountScope: { serverId: boundary.serverId, accountId: 'account-a' },
        providerId: 'codex', machineId: 'machine-1', projection: projection(true),
        profile: null, settings: { connectedServicesProfileLabelByKey: {} }, activeServerId: boundary.serverId,
    })[0];
    if (!option) throw new Error('Projected source fixture did not materialize');
    return JSON.stringify(['machine-1', option.key]);
}

describe('activated external conversation results', () => {
    beforeEach(async () => {
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        const { storage } = await import('@/sync/domains/state/storage');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        scopeOwner = await import('@/sync/domains/scope/activeServerAccountScope');
        boundary.list.mockReset().mockResolvedValue(page);
        boundary.ensure.mockReset().mockResolvedValue({ ok: true, sessionId: 'linked', created: true });
        boundary.page.mockReset().mockResolvedValue(transcriptPage);
        boundary.routerPush.mockReset();
        boundary.projection.mockReset().mockResolvedValue({ supported: true, projection: projection(true) });
        const home = await upsertAndActivateServer({ serverUrl: 'https://palette-history.test' });
        boundary.serverId = home.id;
        storage.setState({
            profileScope: { serverId: home.id, accountId: 'account-a' },
            machineListByServerId: { [home.id]: [createMachineFixture({ activeAt: Date.now() })] },
        });
        const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
        registerStorageStateReader(() => storage.getState());
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`,
        });
        clearDaemonMergedProjectionCacheForTests();
    });
    afterEach(() => { standardCleanup(); scopeOwner?.retireActiveServerAccountScopeLifetime(); vi.restoreAllMocks(); });

    it('searches only the selected source after activation, pages explicitly, and opens the decoded hit with a mapped Find seed', async () => {
        const input = props();
        input.query = '  body-only phrase  ';
        const ordering: string[] = [];
        input.onRequestClose.mockImplementation(() => { ordering.push('close'); });
        input.onOpenSession.mockImplementation(() => { ordering.push('navigate'); });
        const screen = await renderScreen(<ExternalConversationSearchResults {...input} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(boundary.list).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1', agentId: 'codex', source: { kind: 'codexHome', home: 'user' },
            searchTarget: 'content', searchTerm: input.query,
        }), expect.objectContaining({ serverId: boundary.serverId }));
        expect(screen.findHostByTestId('external-session-candidate-match:hit')).not.toBeNull();
        expect(screen.findByTestId('external-conversation-open:native-only')).toBeNull();
        expect(boundary.list.mock.calls).toHaveLength(1);
        await screen.pressByTestIdAsync(`external-conversation-more:${sourceKey()}`);
        expect(boundary.list.mock.calls[1]?.[0]).toMatchObject({ cursor: 'next', searchTarget: 'content' });
        await screen.pressByTestIdAsync('external-conversation-open:hit');
        expect(input.onOpenSession).toHaveBeenCalledWith('linked', { machineId: 'machine-1', serverId: boundary.serverId }, {
            query: input.query, options: { matchCase: false, regex: false },
            target: { kind: 'route-message-id', routeMessageId: makeExternalSessionHistoricalImportLocalId({ agentId: 'codex', remoteSessionId: 'hit', directItemId: 'source-item' }) },
        });
        expect(ordering).toEqual(['close', 'navigate']);
    });

    it('loads the highlighted exchange only when wide, and opens it from there (lab H1r)', async () => {
        const input = props();
        const screen = await renderScreen(<ExternalConversationSearchResults {...input} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        const layout = (width: number) => act(async () => {
            screen.findByTestId('external-conversation-results')!.props.onLayout({ nativeEvent: { layout: { width, height: 560 } } });
        });
        await layout(420);
        expect(screen.findHostByTestId('external-conversation-preview')).toBeNull();
        expect(boundary.page).not.toHaveBeenCalled();
        await layout(800);
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('Explain this failure');
        expect(screen.getTextContent()).toContain('in the full response');
        expect(boundary.page).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1', agentId: 'codex', remoteSessionId: 'hit', direction: 'older',
        }), expect.objectContaining({ serverId: boundary.serverId, accountId: 'account-a' }));
        expect(screen.findHostByTestId('external-conversation-preview')?.props).toBeDefined();
        expect(findAllHostTestInstances(screen.root, node => typeof (node.props.onPress ?? node.props.onClick) === 'function'
            && node.findAll(child => typeof child.type === 'string' && child.children.includes('externalSessions.browseContentShow')).length > 0)).toHaveLength(1);
        expect(boundary.ensure).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('external-conversation-preview-open');
        expect(input.onOpenSession).toHaveBeenCalledWith('linked', { machineId: 'machine-1', serverId: boundary.serverId },
            expect.objectContaining({ query: input.query }));
    });

    it('keeps one cancellable progress band above retained results while paging', async () => {
        const pending = createDeferred<typeof page>();
        boundary.list.mockResolvedValueOnce(page).mockImplementationOnce(() => pending.promise);
        const screen = await renderScreen(<ExternalConversationSearchResults {...props()} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        await screen.pressByTestIdAsync(`external-conversation-more:${sourceKey()}`);
        await flushHookEffects();
        expect(screen.findHostByTestId('external-conversation-progress')).not.toBeNull();
        expect(screen.findAllHostsByTestId('external-conversation-stop')).toHaveLength(1);
        await screen.pressByTestIdAsync('external-conversation-stop');
        expect(screen.findHostByTestId('external-conversation-stop')).toBeNull();
        expect(screen.findHostByTestId('external-session-candidate-match:hit')).not.toBeNull();
        pending.resolve(page);
        await flushHookEffects();
    });

    it('finishes an empty conversation search with a query-specific empty state', async () => {
        boundary.list.mockResolvedValue({ ok: true, candidates: [], contentCoverage: 'complete' });
        const screen = await renderScreen(<ExternalConversationSearchResults {...props()} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(screen.findHostByTestId('external-conversation-none')).not.toBeNull();
        expect(screen.findHostByTestId('external-conversation-progress')).toBeNull();
        expect(screen.getTextContent()).not.toContain('externalSessions.browseNoSearchResults');
    });

    it('never sends content to an older source or displays metadata rows as matches', async () => {
        boundary.projection.mockResolvedValue({ supported: true, projection: projection() });
        const screen = await renderScreen(<ExternalConversationSearchResults {...props()} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(boundary.list).not.toHaveBeenCalled();
        expect(screen.findHostByTestId(`external-conversation-unsupported:${sourceKey()}`)).not.toBeNull();
        expect(screen.findHostByTestId('external-session-candidate-match:hit')).toBeNull();
    });

    it('reads the preceding prompt across a page boundary without showing the neighboring turn', async () => {
        const full = transcriptPage;
        boundary.page.mockResolvedValueOnce({ ok: true, hasMore: true, nextCursor: 'older', items: [
            full.items[1],
            { id: 'next-prompt', createdAtMs: 3, raw: { role: 'user', content: { type: 'text', text: 'Another unrelated turn' } } },
        ] }).mockResolvedValueOnce({ ok: true, hasMore: false, items: [full.items[0]] });
        const screen = await renderScreen(<ExternalConversationSearchResults {...props()} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        await act(async () => { screen.findByTestId('external-conversation-results')!.props.onLayout({ nativeEvent: { layout: { width: 800 } } }); });
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('Explain this failure');
        expect(screen.getTextContent()).not.toContain('Another unrelated turn');
        expect(boundary.page.mock.calls[1]?.[0].cursor).toBe('older');
    });

    it('cancels the selected preview on a new highlight and Account retirement, rejecting both late responses', async () => {
        boundary.list.mockResolvedValue({ ...page, candidates: [hit, { ...hit, remoteSessionId: 'other' }] });
        const response = transcriptPage;
        const first = createDeferred<typeof response>();
        const second = createDeferred<typeof response>();
        boundary.page.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
        const screen = await renderScreen(<ExternalConversationSearchResults {...props()} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        await act(async () => { screen.findByTestId('external-conversation-results')!.props.onLayout({ nativeEvent: { layout: { width: 800 } } }); });
        await flushHookEffects();
        const firstSignal = boundary.page.mock.calls[0]?.[1].signal as AbortSignal;
        await act(async () => { screen.findByTestId('external-conversation-open:other')!.props.onFocus(); });
        await flushHookEffects();
        expect(firstSignal.aborted).toBe(true);
        first.resolve(response);
        await flushHookEffects();
        expect(screen.getTextContent()).not.toContain('Explain this failure');
        const secondSignal = boundary.page.mock.calls[1]?.[1].signal as AbortSignal;
        await act(async () => { scopeOwner.retireActiveServerAccountScopeLifetime(); });
        expect(secondSignal.aborted).toBe(true);
        second.resolve(response);
        await flushHookEffects();
        expect(screen.findHostByTestId('external-conversation-results')).toBeNull();
        expect(boundary.ensure).not.toHaveBeenCalled();
    });

    it('Stop aborts a pending page and Account retirement removes published rows and prevents opening', async () => {
        const pending = createDeferred<typeof page>();
        boundary.list.mockImplementationOnce(() => pending.promise);
        const input = props();
        const screen = await renderScreen(<ExternalConversationSearchResults {...input} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        await screen.pressByTestIdAsync('external-conversation-stop');
        expect(boundary.list.mock.calls[0]?.[1].signal.aborted).toBe(true);
        pending.resolve(page);
        await flushHookEffects();
        expect(screen.findHostByTestId('external-session-candidate-match:hit')).toBeNull();
        await act(async () => { scopeOwner.retireActiveServerAccountScopeLifetime(); });
        expect(screen.findHostByTestId('external-conversation-results')).toBeNull();
        expect(input.onOpenSession).not.toHaveBeenCalled();
    });

    it('replaces an expired source page when Search more resets its cursor', async () => {
        boundary.list.mockResolvedValueOnce(page).mockResolvedValueOnce({ ok: true,
            candidates: [], cursorReset: true }).mockResolvedValueOnce({ ok: true,
            candidates: [{ ...hit, remoteSessionId: 'fresh' }], contentCoverage: 'complete' });
        const screen = await renderScreen(<ExternalConversationSearchResults {...props()} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        await screen.pressByTestIdAsync(`external-conversation-more:${sourceKey()}`);
        await flushHookEffects();
        expect(screen.findHostByTestId('external-session-candidate-match:hit') === null).toBe(true);
        expect(screen.findHostByTestId('external-session-candidate-match:fresh') !== null).toBe(true);
        expect(boundary.list.mock.calls.at(-1)?.[0].cursor).toBeUndefined();
    });

    it('removes published results and suppresses a pending link when the selected Account retires', async () => {
        const pending = createDeferred<{ ok: true; sessionId: string; created: boolean }>();
        boundary.ensure.mockImplementationOnce(() => pending.promise);
        const input = props();
        const screen = await renderScreen(<ExternalConversationSearchResults {...input} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(screen.findHostByTestId('external-session-candidate-match:hit')).not.toBeNull();
        await screen.pressByTestIdAsync('external-conversation-open:hit');
        await flushHookEffects();
        expect(boundary.ensure).toHaveBeenCalled();
        await act(async () => { scopeOwner.retireActiveServerAccountScopeLifetime(); });
        expect(screen.findHostByTestId('external-conversation-results')).toBeNull();
        pending.resolve({ ok: true, sessionId: 'late-linked', created: true });
        await flushHookEffects();
        expect(input.onRequestClose).not.toHaveBeenCalled();
        expect(input.onOpenSession).not.toHaveBeenCalled();
    });

    it('keeps Show scoped to the online foreign Home when the foreground Home has an offline machine with the same id', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        const { useServerCredentialAccountScopes } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const foreign = await upsertServerProfileOnly({ serverUrl: 'https://palette-foreign.test' });
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementation(async (serverUrl) => ({
            token: `e30.${Buffer.from(JSON.stringify({ sub: serverUrl === foreign.serverUrl ? 'account-b' : 'account-a' })).toString('base64url')}.signature`,
        }));
        storage.setState({
            settingsScope: { serverId: boundary.serverId, accountId: 'account-a' },
            machineListByServerId: {
                [boundary.serverId]: [createMachineFixture({ active: false, activeAt: Date.now() - 600_000 })],
                [foreign.id]: [createMachineFixture({ active: true, activeAt: Date.now() })],
            },
        });
        const input = props();
        input.query = '  body-only phrase  ';
        function ForeignResults() {
            const accountLifetime = useServerCredentialAccountScopes([foreign.id]).get(foreign.id);
            const [admitted, setAdmitted] = React.useState<typeof accountLifetime>();
            // Credential admission withdraws unproven retained rows. Publish this
            // fixture's scoped census after that admission, as the real runtime does.
            React.useLayoutEffect(() => {
                if (accountLifetime?.isCurrent()) {
                    storage.setState(state => ({
                        machineListByServerId: { ...state.machineListByServerId, [foreign.id]: [createMachineFixture({ active: true, activeAt: Date.now() })] },
                        machineListStatusByServerId: { ...state.machineListStatusByServerId, [foreign.id]: 'idle' },
                    }));
                    setAdmitted(accountLifetime);
                }
            }, [accountLifetime]);
            return accountLifetime && admitted === accountLifetime ? <ExternalConversationSearchResults {...input}
                target={{ machineId: 'machine-1', serverId: foreign.id, accountId: 'account-b' }}
                accountLifetime={accountLifetime} /> : null;
        }
        const screen = await renderScreen(<ForeignResults />);
        await flushHookEffects({ cycles: 6, turns: 2 });
        // Lazy transport admission can settle after the credential/census
        // render; wait for the observable request, not a fixed effect count.
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(boundary.list).toHaveBeenCalled();
        });
        const request = {
            machineId: 'machine-1', agentId: 'codex', source: { kind: 'codexHome', home: 'user' },
            searchTarget: 'content', searchTerm: input.query,
        };
        expect(boundary.list.mock.calls, JSON.stringify({ inventory: storage.getState().machineListByServerId,
            statuses: storage.getState().machineListStatusByServerId, projectionCalls: boundary.projection.mock.calls,
            text: findAllHostTestInstances(screen.root, node => node.children.some(child => typeof child === 'string')).map(node => node.children.filter(child => typeof child === 'string')) })).not.toHaveLength(0);
        expect(boundary.list).toHaveBeenCalledWith(expect.objectContaining(request), expect.objectContaining({ serverId: foreign.id }));
        boundary.list.mockClear();
        const show = findAllHostTestInstances(screen.root, (button) => typeof (button.props.onPress ?? button.props.onClick) === 'function'
            && button.findAll((node) => typeof node.type === 'string' && node.children.includes('externalSessions.browseContentShow')).length > 0).at(-1);
        await pressTestInstanceAsync(show, 'Show in External sessions');
        await flushHookEffects({ cycles: 6, turns: 2 });
        expect(boundary.list).toHaveBeenCalledWith(expect.objectContaining(request), expect.objectContaining({ serverId: foreign.id }));
        expect(boundary.list.mock.calls.every((call) => call[1]?.serverId === foreign.id && call[0].source.home === 'user')).toBe(true);
        expect(screen.findHostByTestId('external-session-candidate-match:hit')).not.toBeNull();
        await pressTestInstanceAsync(screen.findAllHostsByTestId('direct-session-candidate:hit').at(-1), 'browser content hit');
        await flushHookEffects();
        expect(boundary.ensure).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1', agentId: 'codex', remoteSessionId: 'hit', source: request.source,
        }), expect.objectContaining({ serverId: foreign.id }));
        const { buildScopedSessionRouteHref } = await import('@/hooks/session/sessionRouteServerScope');
        expect(boundary.routerPush).toHaveBeenCalledWith(buildScopedSessionRouteHref({ sessionId: 'linked', serverId: foreign.id }));
    });
});
