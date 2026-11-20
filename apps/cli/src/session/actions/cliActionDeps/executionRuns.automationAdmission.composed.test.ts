import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { createExecutionRunRpcActionExecutor } from '@/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { configuration } from '@/configuration';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('carries the requester Automation owner into the real detached Run admission without borrowing the custodian', async () => {
    const accountId = randomUUID();
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const machineId = 'scm-requester-machine';
    const serverUrl = 'https://scm-requester.test';
    const serverId = configuration.activeServerId;
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-scm-root', binding: {
        accountId, custodianAccountId: 'different-custodian', authentication: { kind: 'account', tokenEpoch: 0 },
        accountEncryptionMode: 'plain', serverIdentityId: 'scm-home', actionId: 'scm.diffSummary.generate',
        requestId: 'scm-root', machineId, installationId: 'installed-machine',
        target: { kind: 'machine', machineId }, requestEnvelopeDigest: 'a'.repeat(43),
    } });
    // Only Home HTTP is replaced. Its real Account index and selector stay beneath the boundary.
    const sent: string[] = [];
    const http = vi.spyOn(axios, 'request').mockImplementation(async config => {
        if (config.url !== `${serverUrl}${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`) throw new Error(`Unexpected Home path ${config.url}`);
        sent.push(String(config.headers?.Authorization));
        return { status: 200, data: { v: 1, rows: [] } };
    });
    const policy = resolveExecutionRunPolicy();
    const manager = new ExecutionRunHostBridge({ parentProvider: 'daemon.executionRuns', cwd: '/repo', sendAcp: async () => {} });
    // Exercise admission without a model turn: the actual feature owner refuses the effect afterward.
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '0');
    const settings = createActionSettingsProvider({ accountSettings: accountSettingsParse({}) });
    const receiver = createExecutionRunRpcActionExecutor({ manager, policy,
        context: { sessionId: null, cwd: '/repo', serverId, serverUrl }, actionsSettingsProvider: settings,
        isExecutionRunsEnabled: () => resolveCliFeatureDecision({ featureId: 'execution.runs' }).state === 'enabled' });
    const request = { intent: 'agent', instructions: 'Explain the captured comparison',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' };
    const rootContext = { surface: 'rpc' as const, authority: 'account_automation' as const,
        actionCaller: { kind: 'host' as const }, actionRequestId: 'scm-root:execution-start', runtimeAccountId: accountId,
        externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target };
    const invokeReceiver = (localActionContext: Parameters<typeof buildActionExecutorContextForRpc>[0]['localActionContext']) =>
        receiver.execute('execution.run.start', request, buildActionExecutorContextForRpc({
            actionId: 'execution.run.start', serverId, externalActionTarget: authorization.binding.target,
            callerAuthority: 'account_automation', localActionContext,
        }));
    const absent = await invokeReceiver(rootContext);
    expect(absent).toMatchObject({ ok: false, errorCode: 'target_unavailable',
        failureCause: { phase: 'action.automations.admission', nativeErrorReason: 'action_automation_owner_unavailable' } });
    expect(sent).toEqual([]);
    const forwardedPorts: unknown[] = [];
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
        serverId, serverHttpBaseUrl: serverUrl, actionsSettingsProvider: settings,
        machineActionDirectTargetTransport: { machineId, invoke: async (_method, _request, options) => {
            forwardedPorts.push(options?.localActionContext?.actionAutomationPort);
            return invokeReceiver(options?.localActionContext);
        } } });
    try {
        const result = await deps.executionRunStart!(null, request, {
            ...rootContext, serverId, targetMachineId: machineId,
        });
        expect(result).toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed', error: 'Execution runs feature disabled' });
        expect(forwardedPorts[0]).toBe(deps.actionAutomations);
        expect(sent).toEqual([`Bearer ${token}`]);
        expect(http).toHaveBeenCalledTimes(1);
        expect(manager.listPublic()).toEqual([]);
    } finally { await manager.dispose(); }
});
