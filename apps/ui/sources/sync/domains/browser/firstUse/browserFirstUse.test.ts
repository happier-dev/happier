import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';

import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

import {
    projectBrowserOpenOperation,
    readBrowserOpenAcceptance,
    readBrowserOpenFirstUse,
    readBrowserOpenTargetUrl,
    readBrowserSandboxInstallOutcome,
} from './browserFirstUse';

const scope = { serverId: 'home', accountId: 'account', machineId: 'machine', sessionId: 'session' };

function open(overrides: Record<string, unknown> = {}) {
    return ActionOperationSnapshotV1Schema.parse({
        version: 1, operationId: 'open-1', revision: 1, actionId: 'browser.view.open', state: 'running',
        title: 'Open Browser', createdAt: 1, startedAt: 2, cancellation: 'unsupported',
        scope: { accountId: scope.accountId, machineId: scope.machineId, sessionId: scope.sessionId },
        ...overrides,
    });
}

function read() {
    return readBrowserOpenFirstUse(actionOperationStore.getSnapshot(), scope);
}

afterEach(() => actionOperationStore.reset());

describe('readBrowserOpenFirstUse', () => {
    it('is preparing while the Machine-targeted open reports browser_runtime_provisioning, then connecting', () => {
        actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [open()] });
        expect(read()).toEqual({ kind: 'connecting' });
        actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [open({ revision: 2,
            progress: { kind: 'phase', phase: 'browser_runtime_provisioning', label: 'Preparing Browser' } })] });
        expect(read()).toEqual({ kind: 'preparing' });
        actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [open({ revision: 3 })] });
        expect(read()).toEqual({ kind: 'connecting' });
    });

    it('does not read a list entry without its result as an outcome, and takes the exact fetched operation instead', () => {
        const listed = open({ revision: 2, state: 'succeeded', settledAt: 3 });
        actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [listed] });
        expect(read()).toBeNull();
        const fetched = open({ revision: 2, state: 'succeeded', settledAt: 3,
            result: { v: 1, commandId: 'c', status: 'failed', adapterKind: 'chromiumSidecar',
                error: { code: 'sandbox_unavailable', message: 'Managed Chromium sandbox is unavailable.' } } });
        expect(readBrowserOpenFirstUse(actionOperationStore.getSnapshot(), scope, fetched)).toEqual({ kind: 'sandboxUnavailable' });
        // A fetched record of another operation never answers for this one.
        expect(readBrowserOpenFirstUse(actionOperationStore.getSnapshot(), scope, { ...fetched, operationId: 'other' })).toBeNull();
    });

    it('settles a dispatched open into waiting for its page, and reads typed failures from the exact open', () => {
        actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [open({ revision: 2, state: 'succeeded', settledAt: 3,
            result: { v: 1, commandId: 'c', status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] } })] });
        expect(read()).toEqual({ kind: 'dispatched' });

        actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [open({ operationId: 'open-2', createdAt: 5, startedAt: 6,
            revision: 2, state: 'failed', settledAt: 7,
            error: { errorCode: 'browser_runtime_provisioning_failed', error: 'Could not prepare the browser.' } })] });
        expect(read()).toEqual({ kind: 'installFailed', actionFailure: {
            ok: false, errorCode: 'browser_runtime_provisioning_failed', error: 'Could not prepare the browser.',
        } });

        actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [open({ operationId: 'open-3', createdAt: 9, startedAt: 10,
            revision: 2, state: 'succeeded', settledAt: 11,
            result: { v: 1, commandId: 'c', status: 'failed', adapterKind: 'chromiumSidecar',
                error: { code: 'sandbox_unavailable', message: 'Managed Chromium sandbox is unavailable.' } } })] });
        expect(read()).toEqual({ kind: 'sandboxUnavailable' });
    });

    it('ignores other Homes, Accounts, Machines, Sessions, Actions and unrelated failures', () => {
        const preparing = open({ revision: 2, progress: { kind: 'phase', phase: 'browser_runtime_provisioning', label: 'Preparing' } });
        actionOperationStore.mergeSnapshots({ serverId: 'other-home', snapshots: [preparing] });
        actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [
            { ...preparing, operationId: 'a', scope: { ...preparing.scope, accountId: 'other' } },
            { ...preparing, operationId: 'm', scope: { ...preparing.scope, machineId: 'other' } },
            { ...preparing, operationId: 's', scope: { ...preparing.scope, sessionId: 'other' } },
            { ...preparing, operationId: 'x', actionId: 'browser.automation.snapshot' },
            open({ operationId: 'f', state: 'failed', revision: 2, settledAt: 22, createdAt: 20, startedAt: 21,
                error: { errorCode: 'permission_denied', error: 'no' } }),
        ] });
        expect(read()).toBeNull();
    });
});

describe('readBrowserSandboxInstallOutcome', () => {
    it('reads the typed installation result and treats a declined approval as no outcome', () => {
        expect(readBrowserSandboxInstallOutcome({ ok: true, result: { status: 'installed' } })).toEqual({ status: 'installed' });
        expect(readBrowserSandboxInstallOutcome({ ok: true, result: { status: 'failed', code: 'os_authorization_required' } }))
            .toEqual({ status: 'failed', code: 'os_authorization_required' });
        expect(readBrowserSandboxInstallOutcome({ ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' })).toBeNull();
        expect(readBrowserSandboxInstallOutcome({ ok: false, errorCode: 'runtime_action_disabled', error: 'x' }))
            .toEqual({ status: 'failed', code: 'runtime_action_disabled',
                actionFailure: { ok: false, errorCode: 'runtime_action_disabled', error: 'x' } });
        expect(readBrowserSandboxInstallOutcome({ ok: true, result: { nonsense: true } }))
            .toEqual({ status: 'failed', code: 'invalid_action_output' });
    });
});

describe('allowBrowserSandbox', () => {
    it('dispatches the one sandbox Action as the present person to the exact Machine, through the UI Browser executor', async () => {
        const { allowBrowserSandbox } = await import('./browserFirstUse');
        const { createBrowserRuntimeActionExecutor } = await import('@/sync/domains/browser/actions/runtimeActionExecutor');
        const executeOnMachine = vi.fn(async () => ({ status: 'failed', code: 'os_authorization_required' }));
        const runtime = createBrowserRuntimeActionExecutor({ executeOnMachine });
        const calls: unknown[] = [];
        const outcome = await allowBrowserSandbox(async (actionId, input, context) => {
            calls.push({ actionId, input, context });
            return { ok: true, result: await runtime({ actionId, input, context }) };
        }, scope);
        expect(outcome).toEqual({ status: 'failed', code: 'os_authorization_required' });
        expect(calls).toEqual([{ actionId: 'browser.sandbox.install', input: { machineId: 'machine' }, context: expect.objectContaining({
            surface: 'ui', authority: 'present_user', serverId: 'home', expectedAccountId: 'account', defaultSessionId: 'session',
            externalActionTarget: { kind: 'machine', machineId: 'machine' },
        }) }]);
        expect(executeOnMachine).toHaveBeenCalledTimes(1);
    });
});

describe('an approval receipt of a browser open that is still being prepared', () => {
    const acceptance = { v: 1, status: 'in_progress', phase: 'browser_runtime_provisioning', commandId: 'c1',
        browserSessionId: 'bs', viewId: 'v1', operationId: 'open-1' };
    function approvalArtifact(result: unknown): DecryptedArtifact {
        const request = { v: 2 as const, status: 'executed' as const, createdAtMs: 1, updatedAtMs: 3,
            createdBy: { surface: 'agent' as const, sessionId: scope.sessionId }, requestedSurface: 'ui' as const,
            executionOriginV1: { v: 1 as const, authority: 'present_user' as const, surface: 'ui' as const,
                caller: { kind: 'host' as const }, serverId: scope.serverId, sessionId: scope.sessionId,
                target: { kind: 'machine' as const, machineId: scope.machineId }, machineId: scope.machineId,
                actionId: 'browser.view.open' as const, requestId: 'request-open' },
            actionId: 'browser.view.open' as const,
            actionArgs: { kind: 'openView', commandId: 'c1', browserSessionId: 'bs', viewId: 'v1', platform: 'web',
                target: { kind: 'externalUrl', targetId: 't', url: 'http://localhost:5173/login' } },
            summary: 'Open browser view', decision: { kind: 'approve' as const, decidedAtMs: 2 },
            execution: { executedAtMs: 3, ok: true as const, result } };
        return { id: 'approval-1', isDecrypted: true, header: buildApprovalRequestArtifactHeaderV1(request),
            body: JSON.stringify(request) } as unknown as DecryptedArtifact;
    }

    it('links to its operation and names the page, only for the provisioning acceptance', () => {
        const artifact = approvalArtifact(acceptance);
        const request = JSON.parse(artifact.body as string);
        expect(readBrowserOpenAcceptance(request)).toEqual({ operationId: 'open-1', targetUrl: 'http://localhost:5173/login' });
        expect(readBrowserOpenAcceptance({ ...request, execution: { ...request.execution, result:
            { v: 1, commandId: 'c1', status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] } } })).toBeNull();
        expect(readBrowserOpenAcceptance({ ...request, actionId: 'browser.view.close' })).toBeNull();
        expect(readBrowserOpenTargetUrl([artifact], 'open-1')).toBe('http://localhost:5173/login');
        expect(readBrowserOpenTargetUrl([artifact], 'open-2')).toBeNull();
    });

    it('is projected from the operation like the Session Browser, including a typed failure result', () => {
        expect(projectBrowserOpenOperation(open())).toEqual({ kind: 'connecting' });
        expect(projectBrowserOpenOperation(open({ revision: 2, state: 'succeeded', settledAt: 3,
            result: { v: 1, commandId: 'c', status: 'failed', adapterKind: 'chromiumSidecar',
                error: { code: 'adapter_unavailable', message: 'No browser.' } } })))
            .toEqual({ kind: 'failed', code: 'adapter_unavailable' });
    });
});
