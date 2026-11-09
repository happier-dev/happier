import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema, ApprovalRequestSchema, FeaturesResponseSchema, accountSettingsParse, createActionExecutor,
    type ActionExecutorDeps, type ActionExecutorContext, type ApprovalRequest } from '@happier-dev/protocol';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { BrowserCommandV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { UiBrowserAutomationDispatchRequestV1Schema, uiBrowserAutomationDispatchMethod } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';
import * as persistence from '@/persistence';
import { createSessionDaemonAuthorityFixture } from '@/mcp/runtime/sessionDaemonAuthority.testkit';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '../../externalActions/daemonExternalActionTargetResolver';
import { createDaemonControlApp, resolveTrackedAgentRuntimeDaemonServiceAuthority } from '../../controlServer';
import { createDaemonRuntimeActionExecutor } from '../../runtimeActionExecutor';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserAutomationReverseDispatcher } from '../automation/reverseDispatch';
import { createCliBrowserRuntimeActionExecutor } from './controlTransport';

const fixtureSource = new URL('../../../../../ui/sources/dev/testkit/fixtures/actionExecutorBoundary.ts', import.meta.url).href;
const { createActionExecutorBoundaryFixture }: {
    createActionExecutorBoundaryFixture(overrides: Partial<ActionExecutorDeps>): ActionExecutorDeps;
} = await import(fixtureSource);
const MACHINE_ID = 'machine_browser_control';
const BROWSER_SESSION_ID = 'browser_surface:details:preview';
const SESSION_ID = 'session-origin';
const VIEW_ID = 'view_1';
const pageUrl = ['https:', '', 'page.example.test', ''].join('/');
const command = { kind: 'reload', commandId: 'approved-ipc', browserSessionId: BROWSER_SESSION_ID, viewId: VIEW_ID } as const;
afterEach(() => vi.restoreAllMocks());

function createMountedRuntime() {
    const broker = createBrowserDaemonControlBroker();
    const reverseRequests: unknown[] = [];
    const runtimeActionExecute = createDaemonRuntimeActionExecutor({ env: { NODE_ENV: 'test' },
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
            browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, automation: { enabled: true } },
        } }) }),
        resolveRouteOwners: () => ({ browserControl: createBrowserDaemonControlRoutes({ broker }),
            browserUiAutomation: { ownsAutomationView: broker.ownsView,
                uiAutomation: createBrowserAutomationReverseDispatcher({ getMachineClient: () => ({
                    // The answering App is a network boundary; both strict readers and exact-view routing stay real.
                    callConnectedClientRpc: async (method, payload, options) => {
                        expect(method).toBe(uiBrowserAutomationDispatchMethod(command));
                        const request = UiBrowserAutomationDispatchRequestV1Schema.parse(payload);
                        const parsedCommand = BrowserCommandV1Schema.parse(request.input);
                        reverseRequests.push(request);
                        options?.onIssued?.();
                        return { ok: true, result: { v: 1, commandId: parsedCommand.commandId,
                            status: 'dispatched', adapterKind: 'localPreview', events: [] } };
                    },
                }) }),
            },
        }),
    });
    const app = createDaemonControlApp({ getChildren: () => [], machineId: MACHINE_ID,
        stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: SESSION_ID }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'fixture-control-token', runtimeActionExecute });
    vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: 123, httpPort: 12345,
        controlToken: 'fixture-control-token', startedAt: 1, startedWithCliVersion: '0.3.0' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
        const response = await app.inject({ method: 'POST', url: new URL(String(url)).pathname,
            headers: options?.headers as Record<string, string>, payload: String(options?.body) });
        return new Response(response.body, { status: response.statusCode });
    });
    return { app, reverseRequests, execute: createCliBrowserRuntimeActionExecutor({ sessionId: 'cli-global' }) };
}

describe('approved Reload strict Browser replay', () => {
    it.each([
        ['browser.control.takeControl', { kind: 'takeControl' }],
        ['browser.control.handBack', { kind: 'handBack' }],
        ['browser.view.close', { kind: 'closeView' }],
        ['browser.view.focus', { kind: 'focusView' }],
        ['browser.target.set', { kind: 'setTarget', target: { kind: 'externalUrl', targetId: 'page', url: pageUrl } }],
        ['browser.navigate', { kind: 'navigate', url: pageUrl }],
        ['browser.goBack', { kind: 'goBack' }],
        ['browser.goForward', { kind: 'goForward' }],
        ['browser.stop', { kind: 'stop' }],
    ] as const)('routes existing-view %s without a daemon sidecar', async (actionId, operation) => {
        const runtime = createMountedRuntime();
        try {
            const input = { commandId: 'mounted-control', browserSessionId: BROWSER_SESSION_ID, viewId: VIEW_ID, ...operation };
            expect(await runtime.execute({ actionId, input, context: { defaultSessionId: SESSION_ID, bypassApprovals: true } }))
                .toMatchObject({ status: 'dispatched', commandId: input.commandId });
            expect(runtime.reverseRequests).toHaveLength(1);
            expect(runtime.reverseRequests[0]).toMatchObject({ actionId, input, sessionId: SESSION_ID });
        } finally { await runtime.app.close(); }
    });

    it('routes a mounted Reload through authenticated private IPC with its invoking Session separate from Browser identity', async () => {
        const runtime = createMountedRuntime();
        try {
            expect(await runtime.execute({ actionId: 'browser.reload', input: command,
                context: { defaultSessionId: SESSION_ID, authority: 'account_automation', bypassApprovals: true } }))
                .toMatchObject({ status: 'dispatched', commandId: command.commandId });
            expect(runtime.reverseRequests).toEqual([{ v: 1, actionId: 'browser.reload', sessionId: SESSION_ID,
                input: command, authority: 'account_automation' }]);
            await runtime.execute({ actionId: 'browser.reload', input: { ...command, invokingHost: 'untrusted' },
                context: { defaultSessionId: SESSION_ID } });
            expect(runtime.reverseRequests).toHaveLength(1);
        } finally { await runtime.app.close(); }
    });

    it.each(['ui', 'agent'] as const)('preserves the %s proposal through one real decision and exact IPC page effect', async surface => {
        const runtime = createMountedRuntime();
        const session = await createSessionDaemonAuthorityFixture({ sessionId: SESSION_ID,
            execute: async () => { throw new Error('Session authority fixture must not execute an unrelated effect'); } });
        let stored: ApprovalRequest | undefined;
        let proposals = 0;
        const invocations: ActionExecutorContext[] = [];
        const isApprovalExecutionOriginCurrent = createDaemonApprovalExecutionOriginCurrentness({
            accountId: 'account', machineId: MACHINE_ID, serverId: 'home',
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture-account-token', encryption: null } }),
            // Bound Home identity and authenticated Account eligibility are remote system facts.
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_home', machineId: MACHINE_ID }),
            isAccountCurrent: async () => true,
            resolveCurrentSessionAgentSpawnPolicyV1: async () => accountSettingsParse({}).sessionAgentSpawnPolicyV1,
            listAccountApiTokens: async () => { throw new Error('Unsigned Session approval has no API-token lookup'); },
            isSessionCallerCurrent: async ({ caller }) => Boolean(await resolveTrackedAgentRuntimeDaemonServiceAuthority(session.trackedSession, caller.sessionId)),
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            approvalsCreate: async ({ request }) => { stored = ApprovalRequestSchema.parse(request); proposals++; return { artifactId: 'reload-approval' }; },
            approvalsGet: async () => stored ?? null,
            approvalsUpdate: async ({ request }) => {
                if (!stored) throw new Error('Missing stored approval');
                const transition = decideApprovalRequestTransition(stored, request);
                if (!transition.ok) return transition;
                stored = ApprovalRequestSchema.parse(request);
                return { ok: true };
            },
            isApprovalExecutionOriginCurrent,
            runtimeActionExecute: async args => { invocations.push(args.context); return runtime.execute(args); },
        }));
        const context: ActionExecutorContext = { surface, authority: surface === 'ui' ? 'present_user' : 'account_automation',
            actionCaller: surface === 'ui' ? { kind: 'host' } : { kind: 'session', sessionId: SESSION_ID, starterDepth: 0, turnDepth: 0 },
            serverId: 'home', serverIdentityId: 'srv_home', runtimeAccountId: 'account', defaultSessionId: SESSION_ID,
            defaultSessionMachineId: MACHINE_ID, externalActionTarget: { kind: 'machine', machineId: MACHINE_ID },
            actionRequestId: 'reload-' + surface, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                actions: { 'browser.reload': { approvalRequiredSurfaces: [surface] } } }) };
        try {
            const pending = executor.execute('browser.reload', command, context);
            expect(await pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            expect(stored?.actionArgs).toEqual(command);
            expect(runtime.reverseRequests).toEqual([]);
            const result = await executor.execute('approval.request.decide', { artifactId: 'reload-approval', decision: 'approve' },
                { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                    serverId: 'home', serverIdentityId: 'srv_home', runtimeAccountId: 'account' });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
            expect(result).toMatchObject({ result: { status: 'executed' } });
            expect(proposals).toBe(1);
            expect(invocations).toHaveLength(1);
            expect(invocations[0]).toMatchObject({ surface, authority: context.authority, actionCaller: context.actionCaller,
                defaultSessionId: SESSION_ID, externalActionTarget: context.externalActionTarget });
            expect(runtime.reverseRequests).toEqual([{ v: 1, actionId: 'browser.reload', sessionId: SESSION_ID,
                input: command, authority: 'account_automation' }]);
            expect(stored).toMatchObject({ status: 'executed', execution: { ok: true } });
            expect(await executor.execute('approval.request.decide', { artifactId: 'reload-approval', decision: 'approve' },
                { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                    serverId: 'home', serverIdentityId: 'srv_home', runtimeAccountId: 'account' }))
                .toMatchObject({ ok: true, result: { status: 'executed' } });
            expect(runtime.reverseRequests).toHaveLength(1);
        } finally { await session.close(); await runtime.app.close(); }
    });
});

