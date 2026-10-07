import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { WorkflowsLibraryHome } from './WorkflowsLibraryHome';

const execute = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
// The Action transport is a system boundary; parsing, the library reader and Collection stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/workflows', router: { push: routerPush } }).module);
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
let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
const searchRuntime = { open: () => {}, buildCommands: () => [] };
function Wrapper({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={null}><UniversalSearchRuntimeProvider value={searchRuntime}>{children}</UniversalSearchRuntimeProvider></InjectedAuthProvider>;
}
let previous = storage.getState();
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
beforeEach(async () => {
    previous = storage.getState();
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    appliedSnapshot = runtime.getActiveServerSnapshot;
    const home = await runtime.upsertAndActivateServer({ serverUrl: 'http://listsum.test', name: 'Library' });
    publishAppliedActiveServerSnapshot(appliedSnapshot());
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
    routerPush.mockClear();
    storage.setState(previous);
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousRuntimeAvailable);
});

describe('workflow library page anatomy', () => {
    it.each([false, true])('reads history for an empty library and distinguishes a first visit (has history: %s)', async (hasHistory) => {
        const { createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: {
                runs: hasHistory ? [createWorkflowRunSummaryFixture({ id: 'old-run', state: 'succeeded' })] : [], metadataByRunId: {},
            } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        expect(execute.mock.calls.filter(([actionId]) => actionId === 'workflow.run.list')).toHaveLength(1);
        expect(screen.findByTestId('workflows-home:firstVisit') !== null).toBe(!hasHistory);
        if (hasHistory) expect(screen.findByTestId('workflows-home:empty')).not.toBeNull();
    });
    it('lays saved rows on one page sheet like the sections below, and marks built-ins by purpose with their step count', async () => {
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: ['first', 'second', 'third'].map((definitionId) => (
                { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
                    metadata: { title: definitionId }, ownerAccountId: 'account-a', access: 'owner', contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null })) } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        // A populated library needs summaries, not a history-window read just to rule out first visit.
        expect(execute.mock.calls.filter(([actionId]) => actionId === 'workflow.run.list')).toHaveLength(0);
        // A sheet's hairline sits between its rows and never after the group's last one.
        const divider = (definitionId: string) => screen.findAll((node) => node.props.testID === `workflows-home:row:${definitionId}`
            && Array.isArray(node.props.secondaryActions))[0]?.props.showDivider;
        expect(divider('first')).toBe(true);
        expect(divider('second')).toBe(true);
        expect(divider('third')).toBe(false);
        const { t } = await import('@/text');
        const plan = screen.tree.findHostByTestId('workflow-builtins:builtin:plan-with-a-panel');
        expect(plan).not.toBeNull();
        const planCopy = plan!.findAll((node) => typeof node.props.children === 'string').map((node) => node.props.children).join('\n');
        const { getBuiltinWorkflowCatalogV1 } = await import('@happier-dev/protocol');
        const { countWorkflowStepsV1 } = await import('@happier-dev/protocol/workflows/workflowDefinitionEditV1');
        const planEntry = getBuiltinWorkflowCatalogV1().find((entry) => entry.id === 'builtin:plan-with-a-panel')!;
        expect(planCopy).toContain(t('workflows.examples.stepCount', { count: countWorkflowStepsV1(planEntry.definition.blocks) }));
        const marks = (id: string) => screen.findAll((node) => node.props.testID === `workflow-builtins:${id}`)[0]
            ?.findAll((node) => typeof node.props.name === 'string').map((node) => node.props.name) ?? [];
        expect(marks('builtin:plan-with-a-panel')).toContain('list-checks');
        expect(marks('builtin:review-and-converge')).toContain('shield-check');
        expect(marks('builtin:keep-going')).toContain('target');
    });
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
                    metadata: { title: 'Unreadable work' }, ownerAccountId: 'account-a', access: 'owner', contentStatus: 'unavailable', contentUnavailableReason: 'invalid_header', stepCount: null, triggers: [], nextRunAt: null },
                { kind: 'workflow-definition.v1', definitionId: 'malformed', revision: null, metadata: null,
                    ownerAccountId: 'account-a', access: 'owner', contentStatus: 'unavailable', contentUnavailableReason: 'invalid_header',
                    stepCount: null, triggers: [], nextRunAt: null },
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
        expect(unavailableCopy).toContain(t('workflows.contentReasons.invalidHeader'));
        expect(unavailableCopy).not.toContain(t('workflows.examples.stepCount', { count: 0 }));
        const malformed = screen.tree.findHostByTestId('workflows-home:row:malformed');
        expect(malformed).not.toBeNull();
        const malformedCopy = malformed!.findAll(node => typeof node.props.children === 'string').map(node => node.props.children).join('\n');
        expect(malformedCopy).toContain(t('common.unavailable'));
        expect(malformedCopy).toContain(t('workflows.contentReasons.invalidHeader'));
        for (const definitionId of ['unreadable', 'malformed']) {
            const overflow = screen.findAll(node => node.props.testID === `workflows-home:row:${definitionId}`
                && Array.isArray(node.props.secondaryActions))[0];
            expect(overflow).toBeDefined();
            expect(overflow!.props.secondaryActions.find((action: { id: string }) => action.id === 'run')).toMatchObject({ disabled: true });
            await act(async () => { overflow!.props.onSecondaryAction('run'); });
        }
        expect(routerPush).not.toHaveBeenCalled();
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
