import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationDefinitionListItemSchema } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { createAutomationDefinitionSummary } from '@/sync/domains/automations/automationDefinitionProjection';
import { AutomationApiError } from '@/sync/api/automations/apiAutomations';
import { SessionTriggersRoute } from '@/app/(app)/session/[id]/triggers';
import { WorkflowsRoute } from '@/app/(app)/workflows';
import { SessionTriggersSection } from '@/components/workflows/triggers/SessionTriggersSection';

const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));
// Sync's authenticated direct-definition request is the network façade; keep route/state logic real.
const read = vi.hoisted(() => vi.fn());
const execute = vi.hoisted(() => vi.fn());
vi.mock('@/sync/sync', () => ({ sync: { refreshAutomationDefinitionDetail: read } }));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router'))
    .createExpoRouterMock({ params: () => route.params }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The native portal is a system boundary; keep the trigger section, form and Action client real.
vi.mock('@/components/ui/popover', () => ({
    Popover: ({ children }: { children: (size: { maxHeight: number }) => React.ReactNode }) => children({ maxHeight: 640 }),
}));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => ({ serverId: storage.getState().profileScope?.serverId }),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));

let previous = storage.getState();
beforeEach(() => {
    previous = storage.getState();
    route.params = {};
    read.mockReset();
    execute.mockReset();
    storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' },
        workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {} });
});
afterEach(() => { standardCleanup(); storage.setState(previous); });

function automation(workflowDefinitionId: string | null = null) {
    return createAutomationDefinitionSummary(AutomationDefinitionListItemSchema.parse({
        id: 'automation-42', name: 'Daily standup', enabled: true, description: null,
        triggers: [], targetType: 'newSession', existingSessionId: null, templateVersion: 1,
        workflowDefinitionId, assignments: [], lastRunAt: null, createdAt: 1, updatedAt: 1,
    }));
}
async function mount(kind: 'edit' | 'detail' = 'edit') {
    const body = kind === 'edit' ? (await import('@/app/(app)/automations/edit')).AutomationEditRoute
        : (await import('@/app/(app)/automations/[id]')).AutomationDetailRoute;
    return renderScreen(React.createElement(body));
}
function href(screen: Awaited<ReturnType<typeof mount>>) {
    return screen.findAll((node) => String(node.type) === 'Redirect')[0]?.props.href;
}

describe('retired Automation routes', () => {
    it('redirects an empty edit link even when the old Automation feature is unavailable', async () => {
        expect(href(await mount())).toBe('/workflows');
        expect(read).not.toHaveBeenCalled();
    });
    it.each(['edit', 'detail'] as const)('resolves %s to its bound workflow and reveals the trigger section', async (kind) => {
        route.params = { id: ' automation-42 ' };
        const workflowId = '11111111-1111-4111-8111-111111111111';
        read.mockResolvedValue(automation(workflowId));
        expect(href(await mount(kind))).toEqual({ pathname: '/workflows/[id]', params: { id: workflowId, intent: 'schedule' } });
    });
    it('opens a legacy trigger without a conversion or a second editor', async () => {
        route.params = { id: 'automation-42' };
        read.mockResolvedValue(automation());
        expect(href(await mount())).toEqual({ pathname: '/workflows', params: { trigger: 'automation-42' } });
    });
    it('opens a session-scoped set in that session rather than the Account column', async () => {
        route.params = { id: 'automation-42' };
        read.mockResolvedValue({ ...automation(), scopeSessionId: 'session-1' });
        expect(href(await mount())).toEqual({ pathname: '/session/[id]/triggers', params: { id: 'session-1', serverId: 'server-a', trigger: 'automation-42' } });
    });
    it.each(['edit', 'detail'] as const)('resolves combined identifiers on %s to the exact Session trigger popover', async (kind) => {
        route.params = { id: 'automation-42' };
        const workflowId = '11111111-1111-4111-8111-111111111111';
        read.mockResolvedValue({ ...automation(workflowId), scopeSessionId: 'session-1' });
        expect(href(await mount(kind))).toEqual({ pathname: '/session/[id]/triggers', params: {
            id: 'session-1', serverId: 'server-a', trigger: 'automation-42',
        } });
    });
    it('forwards the scoped trigger identity through the Session alias and opens its existing row without writing', async () => {
        route.params = { id: 'session-1', serverId: 'server-a', trigger: 'automation-42' };
        const destination = href(await renderScreen(<SessionTriggersRoute />));
        expect(destination).toEqual({ pathname: '/session/[id]', params: {
            id: 'session-1', serverId: 'server-a', trigger: 'automation-42', right: 'agents',
        } });
        route.params = destination.params;
        const workflowId = '11111111-1111-4111-8111-111111111111';
        const set = (automationId: string, hour: number) => ({ automationId, revision: 4, enabled: true,
            health: 'available', target: { kind: 'workflow', ref: workflowId },
            triggers: [{ id: `${automationId}-schedule`, revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
                kind: 'schedule', triggerDefinitionEnvelope: null, nextRunAt: null,
                schedule: { kind: 'cron', scheduleExpr: `0 ${hour} * * *`, everyMs: null, timezone: null } }] });
        const selected = set('automation-42', 19);
        selected.triggers.push({ ...set('automation-42', 21).triggers[0]!, id: 'automation-42-later-schedule' });
        execute.mockImplementation(async (actionId: string) => actionId === 'session.trigger.list'
            ? { ok: true, result: { sessionId: 'session-1', sets: [set('other-automation', 9), selected], pullRequestLinks: [] } }
            : actionId === 'workflow.definition.list'
                ? { ok: true, result: { definitions: [], nextCursor: null } }
                : { ok: false, errorCode: 'source_unavailable', error: 'Unavailable' });
        const screen = await renderScreen(<SessionTriggersSection sessionId="session-1" />);
        expect(screen.findByTestId('session-work-trigger-popover')).not.toBeNull();
        expect(screen.findAll((node) => node.props.accessibilityLabel === 'workflows.triggers.popover.at'
            && node.props.value === '19:00').length).toBeGreaterThan(0);
        expect(execute.mock.calls.filter(([actionId]) => /session\.trigger\.(add|update|remove)$/.test(actionId))).toEqual([]);
    });
    it('lands a deleted Automation in Workflows with the not-available line', async () => {
        route.params = { id: 'automation-42' };
        read.mockRejectedValue(new AutomationApiError({ status: 404, code: 'automation_not_found' }));
        expect(href(await mount())).toEqual({ pathname: '/workflows', params: { automationUnavailable: '1' } });
    });
    it('keeps a stable loading shell and never redirects from a retired Account', async () => {
        route.params = { id: 'automation-42' };
        let finish: ((value: ReturnType<typeof automation>) => void) | undefined;
        read.mockImplementation(() => new Promise<ReturnType<typeof automation>>((resolve) => { finish = resolve; }));
        const screen = await mount();
        expect(screen.findByTestId('retired-automation-read')).not.toBeNull();
        expect(href(screen)).toBeUndefined();
        const first = finish;
        await act(async () => { storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-b' } }); });
        const oldWorkflowId = '22222222-2222-4222-8222-222222222222';
        await act(async () => { first?.(automation(oldWorkflowId)); });
        expect(href(screen)).toBeUndefined();
        await act(async () => { finish?.(automation()); });
        expect(href(screen)).not.toEqual({ pathname: '/workflows/[id]', params: { id: oldWorkflowId, intent: 'schedule' } });
    });
    it('keeps a transport failure visible with Retry instead of claiming the Automation was deleted', async () => {
        route.params = { id: 'automation-42' };
        read.mockRejectedValueOnce(new Error('offline'));
        const screen = await mount();
        expect(href(screen)).toBeUndefined();
        expect(screen.findByTestId('retired-automation-read-retry')).not.toBeNull();
        read.mockResolvedValue(automation());
        await screen.pressByTestIdAsync('retired-automation-read-retry');
        expect(href(screen)).toEqual({ pathname: '/workflows', params: { trigger: 'automation-42' } });
    });
    it('shows the prescribed not-available line at the Workflows destination', async () => {
        route.params = { automationUnavailable: '1' };
        const screen = await renderScreen(<WorkflowsRoute />);
        expect(screen.findByTestId('retired-automation-unavailable')).not.toBeNull();
    });
    it('keeps exact-turn identity on a retired create link for the session trigger owner to validate', async () => {
        route.params = { sourceSessionId: 'session-1', sourceTurnId: 'turn-9', sourceServerId: 'server-a', sessionLifecycleEvents: 'parentTurnCompleted' };
        const { RetiredAutomationCreateRoute } = await import('@/app/(app)/automations/new');
        const screen = await renderScreen(<RetiredAutomationCreateRoute />);
        expect(href(screen)).toEqual({ pathname: '/session/[id]/triggers', params: {
            id: 'session-1', serverId: 'server-a', sourceSessionId: 'session-1', sourceTurnId: 'turn-9',
            sourceServerId: 'server-a', sessionLifecycleEvents: 'parentTurnCompleted',
        } });
    });
});
