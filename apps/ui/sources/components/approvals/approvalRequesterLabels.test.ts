import { afterEach, describe, expect, it } from 'vitest';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ApprovalRequestV2Schema, type ApprovalExecutionOriginV1, type ApprovalRequestCreatedBy } from '@happier-dev/protocol/approvals/approvalRequestV1';
import {
    describeApprovalOrigin,
    describeUnnamedApprovalSession,
    isHappierGuardApproval,
    readApprovalRequesterSurface,
    resolveApprovalHomeSentenceName,
} from './approvalRequesterLabels';
import { t } from '@/text';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { createWorkflowPublicationApprovalArtifact } from '@/dev/testkit/fixtures/workflowPublicationApprovalFixture';

const created: string[] = [];
afterEach(async () => { for (const id of created.splice(0)) await removeServerProfile(id); });

const sessionId = 'session-1';
const sessionCaller = { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } as const;
const titleChange = { sessionId, title: 'Release cleanup' };

function requestFrom(actionId: ActionId, args: unknown, createdBy: ApprovalRequestCreatedBy,
    surface: ApprovalExecutionOriginV1['surface'], caller: ApprovalExecutionOriginV1['caller']) {
    return ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy, requestedSurface: surface, actionId, actionArgs: getActionSpec(actionId).inputSchema.parse(args),
        summary: getActionSpec(actionId).title,
        executionOriginV1: { v: 1, authority: 'account_automation', serverId: 'home', accountId: 'account',
            actionId, requestId: 'request', surface, caller, sessionId: createdBy.sessionId } });
}

describe('the Home a requesting session is said to live on', () => {
    it('names a Home by its own name, else as this Home when this device has it but never named it', async () => {
        const named = await upsertServerProfile({ name: 'Studio Home', serverUrl: 'https://studio-label.example.test' });
        const unnamed = await upsertServerProfile({ name: 'unnamed-label.example.test', serverUrl: 'https://unnamed-label.example.test' });
        created.push(named.id, unnamed.id);
        expect(resolveApprovalHomeSentenceName(named.id)).toBe('Studio Home');
        expect(resolveApprovalHomeSentenceName(unnamed.id)).toBe(t('settingsAccount.thisHome'));
        expect(describeUnnamedApprovalSession(resolveApprovalHomeSentenceName(unnamed.id)))
            .toBe(t('detailPages.approval.sessionOnHome', { home: t('settingsAccount.thisHome') }));
    });

    it('says a session is not on this device only for a Home this device has no profile for', () => {
        expect(resolveApprovalHomeSentenceName('srv_never_saved_here')).toBeNull();
        expect(describeUnnamedApprovalSession(resolveApprovalHomeSentenceName('srv_never_saved_here')))
            .toBe(t('detailPages.approval.sessionElsewhere'));
    });
});

describe('how a built-in request says who asked', () => {
    // The host stamps surface 'agent' on every Workflow Run Action; the caller is what tells a person
    // that no agent was involved.
    it('reads a Workflow Run caller as the Run, not as the agent surface the host stamped', () => {
        const request = requestFrom('session.title.set', titleChange, { surface: 'agent' }, 'agent', {
            kind: 'workflowRun', runId: 'run',
            authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
            authenticatedStarterV1: { requestRef: 'start', requester: { accountId: 'account', serverId: 'home' } },
        });
        const surface = readApprovalRequesterSurface(request, true);
        expect(describeApprovalOrigin(surface)).toBe(t('detailPages.approval.origin.workflowRun'));
        expect(describeApprovalOrigin(surface)).not.toBe(t('detailPages.approval.origin.agent'));
    });

    it('keeps the stamped surface for a session agent caller', () => {
        const surface = readApprovalRequesterSurface(
            requestFrom('session.title.set', titleChange, { surface: 'agent', sessionId }, 'agent', sessionCaller), true);
        expect(describeApprovalOrigin(surface)).toBe(t('detailPages.approval.origin.agent'));
    });
});

describe('how a contributed Action request says who asked', () => {
    // R21-D2: a Workflow dispatching a plugin Action records its Run as the caller; the creator surface says agent.
    it('reads a Workflow Run caller as the Run, never as "Asked by an agent"', () => {
        const approval = createWorkflowPublicationApprovalArtifact({ id: 'target', runId: 'run-1',
            scope: { serverId: 'home', accountId: 'account' }, requestKind: 'external' });
        const request = TargetActionApprovalRequestV1Schema.parse(JSON.parse(approval.body));
        const surface = readApprovalRequesterSurface({ ...request, createdBy: { surface: 'agent' } }, false);
        expect(describeApprovalOrigin(surface)).toBe(t('detailPages.approval.origin.workflowRun'));
    });

    it('keeps the creator surface when the request carries no Workflow caller', () => {
        expect(readApprovalRequesterSurface({ createdBy: { surface: 'agent' } }, false)).toBe('agent');
    });
});

describe('which requests Happier Guard asked', () => {
    const cleanupAction = 'machines.processes.leftBehind.cleanUp';
    const cleanup = { serverId: 'home', machineId: 'machine', refs: ['exact-ref'] };
    const request = (surface: ApprovalRequestCreatedBy['surface'], caller: ApprovalExecutionOriginV1['caller'],
        actionId: typeof cleanupAction | 'session.title.set' = cleanupAction) =>
        requestFrom(actionId, actionId === cleanupAction ? cleanup : titleChange, { surface, sessionId }, 'rpc', caller);

    it('is the daemon host\'s Left behind Ask on the system surface, even when it names the Session whose work it concerns', () => {
        expect(isHappierGuardApproval(request('system', { kind: 'host' }), true)).toBe(true);
        expect(isHappierGuardApproval(request('agent', { kind: 'host' }), true)).toBe(false);
        expect(isHappierGuardApproval(request('system', sessionCaller), true)).toBe(false);
        expect(isHappierGuardApproval(request('system', { kind: 'host' }, 'session.title.set'), true)).toBe(false);
        const pluginId = 'example.observer';
        const plugin = requestFrom(cleanupAction, cleanup, { surface: 'system', pluginId, sessionId }, 'plugin', {
            kind: 'plugin', pluginId, contributionLocalId: 'observer',
            sourceCustody: { kind: 'development', registeredRootId: 'observer-root' },
        });
        expect(isHappierGuardApproval(plugin, true)).toBe(false);
        expect(isHappierGuardApproval(request('system', { kind: 'host' }), false)).toBe(false);
        expect(isHappierGuardApproval(null, true)).toBe(false);
    });
});
