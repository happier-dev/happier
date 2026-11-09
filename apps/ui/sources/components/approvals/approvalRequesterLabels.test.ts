import { afterEach, describe, expect, it } from 'vitest';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import {
    describeApprovalOrigin,
    describeUnnamedApprovalSession,
    isHappierGuardApproval,
    readApprovalRequesterSurface,
    resolveApprovalHomeSentenceName,
} from './approvalRequesterLabels';
import { t } from '@/text';

const created: string[] = [];
afterEach(async () => { for (const id of created.splice(0)) await removeServerProfile(id); });

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
    const requestFrom = (surface: string, caller: Readonly<{ kind: string }>) =>
        ({ v: 2, executionOriginV1: { surface, caller } }) as unknown as ApprovalRequest;

    it('reads a Workflow Run caller as the Run, not as the agent surface the host stamped', () => {
        const surface = readApprovalRequesterSurface(requestFrom('agent', { kind: 'workflowRun' }), true);
        expect(describeApprovalOrigin(surface)).toBe(t('detailPages.approval.origin.workflowRun'));
        expect(describeApprovalOrigin(surface)).not.toBe(t('detailPages.approval.origin.agent'));
    });

    it('keeps the stamped surface for a session agent caller', () => {
        const surface = readApprovalRequesterSurface(requestFrom('agent', { kind: 'session' }), true);
        expect(describeApprovalOrigin(surface)).toBe(t('detailPages.approval.origin.agent'));
    });
});

describe('which requests Happier Guard asked', () => {
    const request = (surface: string, caller: Readonly<{ kind: string }>, actionId = 'machines.processes.leftBehind.cleanUp', pluginId?: string) =>
        ({ v: 2, actionId, createdBy: { surface, sessionId: 'session-1', ...(pluginId ? { pluginId } : {}) },
            executionOriginV1: { surface: 'api', caller } }) as unknown as ApprovalRequest;

    it('is the daemon host\'s Left behind Ask on the system surface, even when it names the Session whose work it concerns', () => {
        expect(isHappierGuardApproval(request('system', { kind: 'host' }), true)).toBe(true);
        expect(isHappierGuardApproval(request('agent', { kind: 'host' }), true)).toBe(false);
        expect(isHappierGuardApproval(request('system', { kind: 'session' }), true)).toBe(false);
        expect(isHappierGuardApproval(request('system', { kind: 'host' }, 'session.title.set'), true)).toBe(false);
        expect(isHappierGuardApproval(request('system', { kind: 'host' }, undefined, 'example.observer'), true)).toBe(false);
        expect(isHappierGuardApproval(request('system', { kind: 'host' }), false)).toBe(false);
        expect(isHappierGuardApproval(null, true)).toBe(false);
    });
});
