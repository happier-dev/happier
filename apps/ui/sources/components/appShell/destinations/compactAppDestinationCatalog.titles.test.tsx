import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { WorkflowDefinitionArtifactHeaderV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { readApprovalActionTitle } from '@/components/approvals/approvalRequestTitle';
import { formatApprovalStatusLabel } from '@/components/approvals/approvalStatusLabel';

import { projectArtifactHeaderForDisplay } from '@/sync/encryption/artifactEncryption';
import { storage } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { applyProviderCatalogSnapshot, resetProviderCatalogSnapshotsForTests } from '@/sync/store/settings/providerCatalogSnapshot';
import { applyProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import { applyMcpServerCatalogSnapshot, resetMcpServerCatalogSnapshotsForTests } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import {
    readDestinationInstanceTitle,
    resolveCompactAppDestinations,
    resolveDestinationRefFromHref,
    useDestinationInstanceTitles,
    useDestinationInstanceTitleSources,
} from './compactAppDestinationCatalog';

vi.mock('@/sync/sync', async () => ({ sync: (await import('@/dev/testkit/mocks/sync')).createSessionListHydrationSyncBoundary() }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Keep real translations throughout this graph: late panel mocks split the title
// readers already loaded by fixture imports from this suite's translation binding.
// Catalog titles never access the Session-envelope HTTP boundary.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Unexpected Session-envelope HTTP request in catalog title test'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});

const scope = { serverId: 'home-a', accountId: 'account-a' };
const lumen: WorkspaceRefV1 = { id: 'checkout', serverId: scope.serverId, machineId: 'machine-a',
    rootPath: '/work/lumen', label: 'Lumen', createdAtMs: 1 };
const atlas: WorkspaceRefV1 = { ...lumen, serverId: 'home-b', label: 'Atlas' };
const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
    externalSessions: false, inbox: true, workflows: false, friends: false,
} });
function destination(href: string) {
    const ref = resolveDestinationRefFromHref(catalog, href);
    if (!ref) throw new Error(`Unregistered fixture destination: ${href}`);
    return ref;
}

beforeEach(() => {
    storage.getState().activateProfileScope(scope);
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [lumen, atlas] });
});
afterEach(() => {
    standardCleanup();
    resetProviderCatalogSnapshotsForTests();
    resetProfileCatalogSnapshotsForTests();
    resetMcpServerCatalogSnapshotsForTests();
    storage.setState(storage.getInitialState(), true);
});

describe('Project destination instance titles', () => {
    it('does not notify tab title readers for Account preference changes', async () => {
        const entries = [{ key: 'tab', ref: destination('/settings/appearance') }];
        const hook = await renderHook(() => useDestinationInstanceTitleSources(catalog, entries));
        const source = hook.getCurrent().get('tab');
        expect(source).toBeDefined();
        const notify = vi.fn();
        const stop = source!.subscribe(notify);
        try {
            await act(async () => {
                storage.getState().applySettingsLocal({ sessionTmuxSessionName: 'title-unrelated' });
            });
            expect(notify).toHaveBeenCalledTimes(0);
            await act(async () => {
                storage.getState().activateProfileScope({ serverId: 'home-b', accountId: 'account-b' });
            });
            expect(notify).toHaveBeenCalledTimes(1);
        } finally {
            stop();
            await hook.unmount();
        }
    });

    it('keeps destination titles when collection content publishes a headline or an automatic detail selection', () => {
        for (const [href, headline] of [
            ['/machines', 'Calm'], ['/settings/machines', 'Calm'], ['/settings', 'Alice'],
            ['/settings/agents', 'Antigravity'], ['/settings/providers', 'DeepSeek'],
        ] as const) {
            const ref = destination(href);
            const destinationTitle = readDestinationInstanceTitle(catalog, ref);
            expect(destinationTitle).toBeTruthy();
            expect(readDestinationInstanceTitle(catalog, ref, { publishedTitle: { ref, title: headline } }), href)
                .toBe(destinationTitle);
        }
        const detail = destination('/settings/agents/codex');
        expect(readDestinationInstanceTitle(catalog, detail, { publishedTitle: { ref: detail, title: 'Codex detail' } }))
            .toBe('Codex detail');
    });
    it('settles deleted Session identities without treating an uncached or other-Home Session as deleted', async () => {
        const entries = ['/session/gone?serverId=home-a', '/session/gone/info?serverId=home-a',
            '/session/gone?serverId=home-b', '/session/uncached?serverId=home-a'].map((href, index) => ({
            key: String(index), ref: destination(href), fallbackTitle: 'Old name',
        }));
        const hook = await renderHook(() => useDestinationInstanceTitles(catalog, entries));
        await act(async () => {
            storage.setState({ isDataReady: true });
            storage.getState().deleteSession('gone', 'home-a');
        });
        expect(entries.map(entry => readDestinationInstanceTitle(catalog, entry.ref, { fallbackTitle: entry.fallbackTitle })))
            .toEqual([t('errors.sessionDeleted'), t('errors.sessionDeleted'), 'Old name', 'Old name']);
        expect([...hook.getCurrent().values()]).toEqual([t('errors.sessionDeleted'), t('errors.sessionDeleted'), 'Old name', 'Old name']);
        await hook.unmount();
    });
    it('settles missing Projects and Artifacts only after their own census completes', async () => {
        storage.getState().setProjectAccountRowsStatusForScope(scope, 'loading');
        const entries = ['/projects/gone?serverId=home-a', '/artifacts/gone', '/workflows/gone'].map((href, index) => ({
            key: String(index), ref: destination(href),
        }));
        const hook = await renderHook(() => useDestinationInstanceTitles(catalog, entries));
        const pending = entries.map(entry => readDestinationInstanceTitle(catalog, entry.ref));
        expect([...hook.getCurrent().values()]).toEqual(pending);
        expect(pending.every(title => typeof title === 'string' && title.length > 0)).toBe(true);
        expect(pending[0]).not.toBe(t('projects.detail.notFoundTitle'));
        expect(pending[1]).not.toBe(t('artifacts.notFound'));
        await act(async () => {
            applyProjectAccountRowsFixture(storage, { workspaceRefs: [lumen, atlas] });
            storage.getState().applyArtifacts([], storage.getState().artifacts);
        });
        const expected = [t('projects.detail.notFoundTitle'), t('artifacts.notFound'), t('common.unavailable')];
        expect(entries.map(entry => readDestinationInstanceTitle(catalog, entry.ref))).toEqual(expected);
        expect([...hook.getCurrent().values()]).toEqual(expected);
        await hook.unmount();
    });
    it('names a restored built-in Profile from the same declaration its detail uses without an Account row', () => {
        const builtin = getBuiltInProfile('azure-openai');
        if (!builtin) throw new Error('Expected canonical built-in Profile');
        expect(readDestinationInstanceTitle(catalog, destination('/settings/profiles/azure-openai')))
            .toBe(getProfileDisplayName(builtin));
    });
    it('reads an executed Approval whose Action refused its effect as Failed, like its detail page', async () => {
        const request = { v: 2 as const, status: 'executed' as const, createdAtMs: 1, updatedAtMs: 3,
            createdBy: { surface: 'system' as const, sessionId: 'session-1' }, requestedSurface: 'ui' as const,
            executionOriginV1: { v: 1 as const, authority: 'present_user' as const, surface: 'ui' as const,
                caller: { kind: 'host' as const }, serverId: scope.serverId, sessionId: 'session-1',
                target: { kind: 'session' as const, sessionId: 'session-1' },
                actionId: 'machines.presets.archive' as const, requestId: 'request-refused' },
            actionId: 'machines.presets.archive' as const,
            actionArgs: { homeId: 'home-1', id: 'preset-1', expectedRevision: 0 }, summary: 'Archive preset',
            decision: { kind: 'approve' as const, decidedAtMs: 2 },
            execution: { executedAtMs: 3, ok: true as const, result: { kind: 'refused', code: 'provider_unavailable' } } };
        const stored = { id: 'refused-approval', isDecrypted: true, title: 'Archive preset',
            header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
            createdAt: 1, updatedAt: 3, headerVersion: 1, bodyVersion: 1, seq: 1 } as unknown as DecryptedArtifact;
        const before = storage.getState().artifacts;
        try {
            storage.setState((state) => ({ ...state, artifacts: { ...state.artifacts, [stored.id]: stored } }));
            const ref = destination(`/inbox/approvals/${stored.id}`);
            expect(readDestinationInstanceTitle(catalog, ref)).toMatch(new RegExp(`${t('approvals.status.failed')}$`));
            // Without its body this device can only read the stored header's status.
            storage.setState((state) => ({ ...state, artifacts: { ...state.artifacts, [stored.id]: { ...stored, body: undefined } } }));
            expect(readDestinationInstanceTitle(catalog, ref)).toMatch(new RegExp(`${t('approvals.status.executed')}$`));
        } finally {
            storage.setState((state) => ({ ...state, artifacts: before }));
        }
    });

    it('titles an Approval tab by the same rule as its page when the stored summary is the request\'s own older generated sentence', () => {
        const generated = 'Synchronize this linked workspace relationship now.';
        const request = { v: 2 as const, status: 'open' as const, createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'system' as const, sessionId: 'session-1' }, requestedSurface: 'ui' as const,
            executionOriginV1: { v: 1 as const, authority: 'present_user' as const, surface: 'ui' as const,
                caller: { kind: 'host' as const }, serverId: scope.serverId, sessionId: 'session-1',
                target: { kind: 'session' as const, sessionId: 'session-1' },
                actionId: 'workspace.sync.relationship.flush' as const, requestId: 'request-flush' },
            actionId: 'workspace.sync.relationship.flush' as const,
            actionArgs: { controllerMachineId: 'machine-1', relationshipId: 'relationship-1' }, summary: generated,
            preview: { summary: generated } };
        const stored = { id: 'flush-approval', isDecrypted: true, title: generated,
            header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
            createdAt: 1, updatedAt: 1, headerVersion: 1, bodyVersion: 1, seq: 1 } as unknown as DecryptedArtifact;
        const before = storage.getState().artifacts;
        try {
            storage.setState((state) => ({ ...state, artifacts: { ...state.artifacts, [stored.id]: stored } }));
            const title = readDestinationInstanceTitle(catalog, destination(`/inbox/approvals/${stored.id}`));
            expect(title).not.toContain(generated);
            expect(title).toBe(`${readApprovalActionTitle('workspace.sync.relationship.flush')} \u00b7 ${formatApprovalStatusLabel('open')}`);
        } finally {
            storage.setState((state) => ({ ...state, artifacts: before }));
        }
    });

    it('names inactive settings entities from their scoped catalogs and Approvals from their route owner', async () => {
        const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_saved',
            source: { kind: 'contribution', contributionKey: 'acme/provider' }, role: 'named',
            displayName: 'My provider', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 });
        const publish = (name: string) => {
            applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 1,
                catalog: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [{ ...connection, displayName: name }] } }, true);
            applyProfileCatalogSnapshot(scope, { status: 'ready', authority: 'inactive', source: 'legacy',
                control: null, controlRevision: 'absent', records: [], diagnostics: [], referenceGuardRevision: 1 }, true,
                new Map(), { legacyProfiles: [AIBackendProfileSchema.parse({ id: 'saved-profile', name: `${name} profile` })] });
            applyMcpServerCatalogSnapshot(scope, { status: 'ready', authority: 'active', revision: 1, diagnostics: [],
                catalog: { v: 1, servers: [{ id: 'saved-mcp', name: 'mcp-command', title: `${name} MCP`, transport: 'stdio',
                    stdio: { command: 'mcp-server', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [] } }, true);
        };
        publish('My provider');
        const entries = ['/settings/providers/pc_saved', '/settings/profiles/saved-profile', '/settings/mcp/saved-mcp',
            '/inbox/approvals/saved-approval?serverId=other-home'].map((href, index) => ({ key: String(index), ref: destination(href) }));
        const hook = await renderHook(() => useDestinationInstanceTitles(catalog, entries));
        expect(entries.map(entry => readDestinationInstanceTitle(catalog, entry.ref))).toEqual([
            'My provider', 'My provider profile', 'My provider MCP', t('approvals.title'),
        ]);
        expect([...hook.getCurrent().values()]).toEqual(['My provider', 'My provider profile', 'My provider MCP', t('approvals.title')]);
        await act(async () => publish('Renamed'));
        expect([...hook.getCurrent().values()]).toEqual(['Renamed', 'Renamed profile', 'Renamed MCP', t('approvals.title')]);
        expect(readDestinationInstanceTitle(catalog, { ...entries[0]!.ref,
            params: { ...entries[0]!.ref.params, serverId: 'other-home' } })).not.toBe('Renamed');
        await hook.unmount();
    });
    it('names restored Workflows and Runs from their stored projections and settles a removed Workflow', async () => {
        const definitionId = '00000000-0000-4000-8000-000000000011';
        const rawHeader = WorkflowDefinitionArtifactHeaderV1Schema.parse({ kind: 'workflow-definition.v1', definitionId,
            metadata: { title: 'Release checks' }, revision: { headerVersion: 1, bodyVersion: 1 } });
        const header = projectArtifactHeaderForDisplay(rawHeader);
        const workflow: DecryptedArtifact = { id: definitionId, title: header.title,
            header, rawHeader, isDecrypted: true,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        storage.getState().applyArtifacts([workflow], storage.getState().artifacts);
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(
            createWorkflowRunSummaryFixture({ id: 'saved-run', ownerAccountId: scope.accountId }),
            { kind: 'available', value: { title: 'Check the release' } },
        )], scope);
        const entries = [`/workflows/${definitionId}`, '/workflows/runs/saved-run', '/workflows/removed-workflow'].map((href, index) => ({
            key: `inactive-${index}`, ref: destination(href),
        }));
        const hook = await renderHook(() => useDestinationInstanceTitles(catalog, entries));
        const expected = ['Release checks', 'Check the release', t('common.unavailable')];
        expect(entries.map(entry => readDestinationInstanceTitle(catalog, entry.ref))).toEqual(expected);
        expect([...hook.getCurrent().values()]).toEqual(expected);
        expect(readDestinationInstanceTitle(catalog, entries[0]!.ref, {
            publishedTitle: { ref: entries[0]!.ref, title: 'Unsaved edit' },
        })).toBe('Unsaved edit');
        expect(readDestinationInstanceTitle(catalog, entries[0]!.ref, {
            publishedTitle: { ref: entries[0]!.ref, title: null },
        })).toBe(t('common.unavailable'));
        expect(readDestinationInstanceTitle(catalog, { ...entries[1]!.ref,
            params: { ...entries[1]!.ref.params, serverId: 'other-home' } })).toBe(t('common.unavailable'));
        const unchanged = hook.getCurrent();
        await act(async () => storage.setState({ isDataReady: true }));
        expect(hook.getCurrent()).toBe(unchanged);
        await act(async () => storage.getState().updateArtifact({ ...workflow, title: 'Renamed checks', headerVersion: 2 }));
        expect(hook.getCurrent().get('inactive-0')).toBe('Renamed checks');
        await hook.unmount();
    });
    it('names a built-in Workflow tab from its catalog entry, never as a missing artifact', async () => {
        storage.getState().applyArtifacts([], storage.getState().artifacts);
        const entries = [{ key: 'builtin', ref: destination(`/workflows/${encodeURIComponent('builtin:plan-with-a-panel')}`) }];
        const hook = await renderHook(() => useDestinationInstanceTitles(catalog, entries));
        const panel = t('workflows.builtins.planWithAPanel.title');
        expect(readDestinationInstanceTitle(catalog, entries[0]!.ref)).toBe(panel);
        expect([...hook.getCurrent().values()]).toEqual([panel]);
        await hook.unmount();
    });
    it('names restored nested Session tabs from the live title projection without mounting their screens', async () => {
        const named = (name: string) => createSessionFixture({ id: 'restored-session', metadata: {
            path: '/project', host: 'tester', homeDir: '/home/tester', summary: { text: name, updatedAt: 1 },
        } });
        storage.getState().applySessions([named('Before rename')]);
        const entries = ['/session/restored-session/info', '/session/restored-session/info'].map((href, index) => ({
            key: `inactive-${index}`, ref: destination(href),
        }));
        const hook = await renderHook(() => useDestinationInstanceTitles(catalog, entries));
        expect(entries.map(entry => readDestinationInstanceTitle(catalog, entry.ref))).toEqual(['Before rename', 'Before rename']);
        expect([...hook.getCurrent().values()]).toEqual(['Before rename', 'Before rename']);
        await act(async () => storage.getState().applySessions([named('After rename')]));
        expect([...hook.getCurrent().values()]).toEqual(['After rename', 'After rename']);
        expect(readDestinationInstanceTitle(catalog, entries[0]!.ref)).toBe('After rename');
        await hook.unmount();
    });
    it('gives an unnamed restored Session an honest fallback without mounting its title supplier', () => {
        expect(readDestinationInstanceTitle(catalog, destination('/session/example/info'))).toBe(t('session.untitled'));
        expect(readDestinationInstanceTitle(catalog, destination('/'))).toBe(t('common.home'));
        expect(readDestinationInstanceTitle(catalog, destination('/settings/appearance'))).toBe(t('settings.appearance'));
    });
    it('names qualified Projects and their pages while only the hub keeps the catalog title', () => {
        expect(readDestinationInstanceTitle(catalog, destination('/projects'))).toBe(t('tabs.projects'));
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout?serverId=home-a'))).toBe('Lumen');
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout?serverId=home-b'))).toBe('Atlas');
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout/code?serverId=home-a')))
            .toBe(`Lumen · ${t('projects.pages.code')}`);
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout/code?serverId=home-a&activeRootPath=%2Fwork%2Flumen-release')))
            .toBe(`Lumen · lumen-release · ${t('projects.pages.code')}`);
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout/code?serverId=home-a&worktreeId=%40root&activeRootPath=%2Fwork%2Flumen-release')))
            .toBe(`Lumen · ${t('projects.pages.code')}`);
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout/terminal?serverId=home-a')))
            .toBe(`Lumen · ${t('settings.terminal')}`);
    });

    it('settles absent Projects while giving ambiguous or another-Home identities only the category title', () => {
        expect(readDestinationInstanceTitle(catalog, destination('/projects/not-loaded/code?serverId=home-a'))).toBe(t('projects.detail.notFoundTitle'));
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout'))).toBe(t('tabs.projects'));
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout?serverId=unknown-home'))).toBe(t('tabs.projects'));
    });

    it('updates retained and duplicate tab titles through rename and refresh without changing their keys', async () => {
        storage.getState().setProjectAccountRowsStatusForScope(scope, 'loading');
        const ref = destination('/projects/checkout/code?serverId=home-a');
        const entries = [{ key: 'first', ref }, { key: 'explicit-duplicate', ref },
            { key: 'loading', ref: destination('/projects/not-loaded/code?serverId=home-a') }];
        const hook = await renderHook(() => useDestinationInstanceTitles(catalog, entries));
        expect([...hook.getCurrent()]).toEqual([
            ['first', `Lumen · ${t('projects.pages.code')}`],
            ['explicit-duplicate', `Lumen · ${t('projects.pages.code')}`],
            ['loading', t('tabs.projects')],
        ]);
        const unchanged = hook.getCurrent();
        await act(async () => { storage.setState({ isDataReady: false }); });
        expect(hook.getCurrent()).toBe(unchanged);
        await act(async () => {
            applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ ...lumen, label: 'Lumen renamed' }, atlas] });
            storage.getState().setProjectAccountRowsStatusForScope(scope, 'loading');
        });
        expect(hook.getCurrent().get('first')).toBe(`Lumen renamed · ${t('projects.pages.code')}`);
        expect(hook.getCurrent().get('explicit-duplicate')).toBe(hook.getCurrent().get('first'));
        expect(hook.getCurrent().get('loading')).toBe(t('tabs.projects'));
        await act(async () => {
            applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ ...lumen, label: null }, atlas] });
        });
        expect(hook.getCurrent().get('first')).toBe(`lumen · ${t('projects.pages.code')}`);
        await act(async () => { storage.getState().activateProfileScope({ ...scope, accountId: 'account-b' }); });
        expect([...hook.getCurrent()]).toEqual(entries.map(entry => [entry.key, t('tabs.projects')]));
        expect(readDestinationInstanceTitle(catalog, ref)).toBe(t('tabs.projects'));
        await hook.unmount();
    });
});
