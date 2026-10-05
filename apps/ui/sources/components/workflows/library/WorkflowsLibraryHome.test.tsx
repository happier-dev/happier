import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { WorkflowsLibraryHome } from './WorkflowsLibraryHome';

const execute = vi.hoisted(() => vi.fn());
// The Action transport is a system boundary; parsing, the library reader and Collection stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/workflows' }).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Native recycler is a system boundary; real Collection row rendering stays below it.
vi.mock('@legendapp/list/react-native', async (original) => (await import('@/dev/testkit/mocks/legendList'))
    .createCapturingLegendListMock({ original: await original<Record<string, unknown>>() }).module);
vi.mock('@/sync/api/capabilities/serverFeaturesClient', async (original) => {
    const snapshot = { status: 'ready' as const, features: (await import('@/dev/testkit/fixtures/featureFixtures')).createRootLayoutFeaturesResponse() };
    return { ...await original<typeof import('@/sync/api/capabilities/serverFeaturesClient')>(),
        getCachedServerFeaturesSnapshot: () => snapshot, getServerFeaturesSnapshot: async () => snapshot };
});
vi.mock('@/auth/storage/tokenStorage', async (original) => {
    const module = await original<typeof import('@/auth/storage/tokenStorage')>();
    return { ...module, TokenStorage: { ...module.TokenStorage,
        getCredentialsForServerUrl: async () => ({ token: 'header.eyJzdWIiOiJhY2NvdW50LWEifQ==.signature' }) } };
});
vi.mock('@/sync/runtime/orchestration/connectionManager', async (original) => ({
    ...await original<typeof import('@/sync/runtime/orchestration/connectionManager')>(),
    getAppliedActiveServerSnapshot: () => appliedSnapshot(), isAppliedActiveServerRuntimeAvailable: () => true,
}));
let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
const searchRuntime = { open: () => {}, buildCommands: () => [] };
function Wrapper({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={null}><UniversalSearchRuntimeProvider value={searchRuntime}>{children}</UniversalSearchRuntimeProvider></InjectedAuthProvider>;
}
let previous = storage.getState();
beforeEach(async () => {
    previous = storage.getState();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    appliedSnapshot = runtime.getActiveServerSnapshot;
    const home = await runtime.upsertAndActivateServer({ serverUrl: 'http://listsum.test', name: 'Library' });
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    storage.setState({ profileScope: { serverId: home.id, accountId: 'account-a' },
        settings: { ...settingsDefaults, experiments: true, featureToggles: { automations: true } },
        workflowRunListWindows: {}, workflowRunsById: {} });
});
afterEach(async () => {
    standardCleanup();
    (await import('./workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    execute.mockReset();
    storage.setState(previous);
});

describe('workflow library summaries and filter', () => {
    it('paints count and shared trigger wording, and filters attached triggers without losing manual workflows', async () => {
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [
                { kind: 'workflow-definition.v1', definitionId: 'manual', revision: { headerVersion: 1, bodyVersion: 1 },
                    metadata: { title: 'Manual work' }, ownerAccountId: 'account-a', access: 'owner', contentStatus: 'available', stepCount: 3, triggers: [], nextRunAt: null },
                { kind: 'workflow-definition.v1', definitionId: 'timed', revision: { headerVersion: 1, bodyVersion: 1 },
                    metadata: { title: 'Timed work' }, ownerAccountId: 'account-a', access: 'owner', contentStatus: 'available', stepCount: 2, nextRunAt: 1_900_000_000_000,
                    triggers: [{ kind: 'schedule', schedule: { kind: 'interval', everyMs: 3_600_000, scheduleExpr: null, timezone: null } }] },
                { kind: 'workflow-definition.v1', definitionId: 'unreadable', revision: { headerVersion: 1, bodyVersion: 1 },
                    metadata: { title: 'Unreadable work' }, ownerAccountId: 'account-a', access: 'owner', contentStatus: 'unavailable', stepCount: null, triggers: [], nextRunAt: null },
            ] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        const { formatTriggerSetSummary } = await import('../triggers/formatTriggerSummary');
        const { t } = await import('@/text');
        expect(screen.tree.findHostByTestId('workflows-home:filter:triggered')).not.toBeNull();
        const manual = screen.tree.findHostByTestId('workflows-home:row:manual');
        expect(manual).not.toBeNull();
        const copy = manual!.findAll((node) => typeof node.props.children === 'string').map((node) => node.props.children).join('\n');
        expect(copy).toContain(t('workflows.examples.stepCount', { count: 3 }));
        expect(copy).toContain(formatTriggerSetSummary([]));
        const unreadable = screen.tree.findHostByTestId('workflows-home:row:unreadable');
        expect(unreadable).not.toBeNull();
        const unavailableCopy = unreadable!.findAll(node => typeof node.props.children === 'string').map(node => node.props.children).join('\n');
        expect(unavailableCopy).toContain(t('common.unavailable'));
        expect(unavailableCopy).not.toContain(t('workflows.examples.stepCount', { count: 0 }));
        await screen.tree.pressByTestIdAsync('workflows-home:filter:triggered');
        expect(screen.tree.findHostByTestId('workflows-home:row:manual')).toBeNull();
        expect(screen.tree.findHostByTestId('workflows-home:row:timed')).not.toBeNull();
        await screen.tree.pressByTestIdAsync('workflows-home:filter:all');
        expect(screen.tree.findHostByTestId('workflows-home:row:manual')).not.toBeNull();
        await screen.tree.pressByTestIdAsync('workflows-home:filter:triggered');
        const { forgetWorkflowLibraryDefinition } = await import('./workflowLibraryReads');
        await act(async () => { forgetWorkflowLibraryDefinition('timed'); });
        expect(screen.tree.findHostByTestId('workflows-home:filter:triggered')).toBeNull();
        expect(screen.tree.findHostByTestId('workflows-home:row:manual')).not.toBeNull();
    });
});
