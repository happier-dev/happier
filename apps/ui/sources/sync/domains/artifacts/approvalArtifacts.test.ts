import { describe, expect, it, vi } from 'vitest';
import * as approvalAdmission from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import * as serverProfiles from '@/sync/domains/server/serverProfiles';
import { ApprovalRequestV1Schema, ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

import type { DecryptedArtifact } from './artifactTypes';
import { readOpenApprovalInboxEntry } from './approvalArtifactAdmission';
import {
    collectOpenApprovalSessionReferences,
    isOpenApprovalInboxArtifact,
    listOpenApprovalInboxArtifactHydrationRequests,
    readOpenApprovalDiscussionAttention,
    readOpenManagedMachineApprovalId,
    listOpenApprovalArtifactsForSession,
    listApprovalArtifactIdsNeedingHydrationForSession,
    listTranscriptApprovalArtifactsForSession,
    listProjectServiceStartApprovalArtifactIds,
    resolveOpenApprovalSessionKeys,
} from './approvalArtifacts';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { buildDiscussionListAttention } from '@/activity/attention/buildDiscussionListAttention';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { describeApprovalRequestFields } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { COMPOSER_SETTLED_APPROVAL_PRESENTATIONS, TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS } from '@/components/tools/shell/approvals/transcriptSettledApprovalPresentations';
import { doesApprovalMatchToolCall } from '@/components/tools/shell/views/toolApprovalPromptMatching';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import * as approvalArtifacts from './approvalArtifacts';

function artifact(
    id: string,
    header: NonNullable<DecryptedArtifact['header']>,
    body?: unknown,
): Extract<DecryptedArtifact, { isDecrypted: true }> {
    return {
        id,
        header,
        title: header.title ?? null,
        sessions: header.sessions,
        draft: header.draft,
        body: typeof body === 'undefined' ? undefined : JSON.stringify(body),
        headerVersion: 1,
        bodyVersion: typeof body === 'undefined' ? undefined : 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        isDecrypted: true,
    };
}

function approvalBody(sessionId: string, actionId = 'session.list') {
    return {
        v: 1,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId },
        requestedSurface: 'agent',
        actionId,
        actionArgs: {},
        summary: 'List sessions',
    };
}

describe('readOpenManagedMachineApprovalId', () => {
    const deleteBody = (managedId: string, status = 'open') => ({ ...approvalBody('session-1', 'machines.managed.delete'), status,
        summary: 'Delete managed machine',
        actionArgs: { homeId: 'home-1', managedId, when: 'now', expectedRevision: 3, intent: 'delete', reviewedDependencies: true },
        ...(status === 'rejected' ? { decision: { kind: 'reject', decidedAtMs: 2 } } : {}) });
    const stored = (id: string, body: ReturnType<typeof deleteBody>) => artifact(id,
        buildApprovalRequestArtifactHeaderV1(ApprovalRequestV1Schema.parse(body)), body);

    it('finds the open Ask already filed for this managed resource and Action, so the page shows it instead of filing another', () => {
        const artifacts = [stored('other-resource', deleteBody('managed-2')), stored('settled', deleteBody('managed-1', 'rejected')),
            stored('pending', deleteBody('managed-1'))];
        const entries = artifacts.flatMap(artifact => {
            const entry = readOpenApprovalInboxEntry(artifact);
            return entry ? [entry] : [];
        });
        expect(readOpenManagedMachineApprovalId(entries, { homeId: 'home-1', managedId: 'managed-1', actionId: 'machines.managed.delete' }))
            .toBe('pending');
        expect(readOpenManagedMachineApprovalId(entries, { homeId: 'home-2', managedId: 'managed-1', actionId: 'machines.managed.delete' }))
            .toBeNull();
        expect(readOpenManagedMachineApprovalId(entries.slice(0, 1), { homeId: 'home-1', managedId: 'managed-1',
            actionId: 'machines.managed.delete' })).toBeNull();
    });
});

describe('ordinary plugin approvals for the selected Machine', () => {
    it('projects only open admitted requests for the exact Home, Account and Machine, and withdraws settled requests', () => {
        const stored = (id: string, machineId: string, accountId = 'account-1', status = 'open') => {
            const actionId = 'plugins.install';
            const actionArgs = { machineId, kind: 'path', path: '/workspace/reviewed-plugin' };
            const executionOriginV1 = buildApprovalExecutionOriginV1({ actionId, input: actionArgs, targetSessionId: null,
                context: { surface: 'agent', authority: 'account_automation', serverId: 'home-1', runtimeAccountId: accountId,
                    executionRunTargetMachineId: machineId, actionRequestId: id, actionCaller: { kind: 'host' } } });
            const request = ApprovalRequestV2Schema.parse({ v: 2, status, createdAtMs: 1, updatedAtMs: 1,
                createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId, actionArgs, executionOriginV1,
                summary: 'Install reviewed plugin', ...(status === 'rejected' ? { decision: { kind: 'reject', decidedAtMs: 2 } } : {}) });
            return artifact(id, buildApprovalRequestArtifactHeaderV1(request), request);
        };
        const pending = stored('approval-a', 'machine-a');
        if (typeof pending.body !== 'string') throw new Error('Expected the approval request body');
        const crossedRequest = { ...ApprovalRequestV2Schema.parse(JSON.parse(pending.body)), actionArgs: {
            machineId: 'machine-b', kind: 'path', path: '/workspace/reviewed-plugin',
        } };
        const crossed = artifact('crossed-target', buildApprovalRequestArtifactHeaderV1(ApprovalRequestV2Schema.parse(crossedRequest)), crossedRequest);
        const values = [pending, stored('approval-b', 'machine-b'), stored('foreign-account', 'machine-a', 'account-2'),
            stored('settled', 'machine-a', 'account-1', 'rejected'), { ...pending, id: 'malformed', body: '{}' }, crossed];
        expect(approvalArtifacts.listOpenPluginApprovalArtifactsForMachine(values,
            { serverId: 'home-1', accountId: 'account-1', machineId: 'machine-a' })).toMatchObject([
                { artifact: { id: 'approval-a' }, approval: { actionArgs: { machineId: 'machine-a', path: '/workspace/reviewed-plugin' } } },
            ]);
        expect(approvalArtifacts.listOpenPluginApprovalArtifactsForMachine(values,
            { serverId: 'home-1', accountId: 'account-1', machineId: 'machine-b' })).toMatchObject([{ artifact: { id: 'approval-b' } }]);
        expect(approvalArtifacts.listOpenPluginApprovalArtifactsForMachine(values,
            { serverId: 'other-home', accountId: 'account-1', machineId: 'machine-a' })).toEqual([]);
    });
});

function durableApprovalBody(sessionId: string) {
    return {
        v: 2,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system', sessionId },
        requestedSurface: 'api',
        executionOriginV1: {
            v: 1,
            authority: 'account_automation',
            surface: 'api',
            caller: { kind: 'host' },
            serverId: 'server-a',
            accountId: 'account-1',
            principalId: 'principal-1',
            credentialId: 'credential-1',
            sessionId,
            machineId: 'machine-1',
            target: { kind: 'session', sessionId },
            actionId: 'session.title.set',
            requestId: 'request-1',
        },
        actionId: 'session.title.set',
        actionArgs: { sessionId, title: 'Current title' },
        summary: 'Set session title',
    };
}

describe('Project Start approval identities', () => {
    it('selects only pending SOURCE identities and reuses admitted local bodies without broad hydration', () => {
        const source = { serverId: 'server-a', refId: 'checkout', machineId: 'source' };
        const actionArgs = { machineId: 'worker', targetId: 'web', workspace: { serverId: source.serverId, machineId: source.machineId,
            workspaceId: source.refId, rootPath: '/source' },
            declaration: { workspaceRefId: source.refId, selection: { kind: 'manifest', name: 'web' } } };
        const request = ApprovalRequestV2Schema.parse({ ...durableApprovalBody('session-1'), status: 'approved',
            decision: { kind: 'approve', decidedAtMs: 2 }, actionId: 'localServices.launcher.start',
            executionOriginV1: { ...durableApprovalBody('session-1').executionOriginV1, actionId: 'localServices.launcher.start',
                machineId: 'worker', target: { kind: 'machine', machineId: 'worker' } },
            actionArgs });
        const other = ApprovalRequestV2Schema.parse({ ...request,
            executionOriginV1: { ...request.executionOriginV1, requestId: 'other-request' },
            actionArgs: { ...actionArgs, workspace: { ...actionArgs.workspace, workspaceId: 'other', rootPath: '/other' },
                declaration: { ...actionArgs.declaration, workspaceRefId: 'other' } } });
        const header = buildApprovalRequestArtifactHeaderV1(request);
        const { approvalSubjectKey: _index, ...olderHeader } = header;
        const stored = artifact('matching', header);
        const local = artifact('admitted-local', olderHeader, request);
        expect(listProjectServiceStartApprovalArtifactIds([
            stored, local, artifact('unknown', olderHeader), artifact('wrong-home', { ...header, serverId: 'server-b' }),
            artifact('other-project', buildApprovalRequestArtifactHeaderV1(other)),
            artifact('open', { ...header, approvalStatus: 'open' }), artifact('terminal', { ...header, approvalStatus: 'executed' }),
            artifact('executing', { ...header, approvalStatus: 'executing' }), artifact('malformed', { ...header, approvalSubjectKey: {} }),
        ], source)).toEqual(['matching', 'admitted-local', 'executing']);
        expect(listProjectServiceStartApprovalArtifactIds([stored, local], { ...source, refId: 'other' })).toEqual([]);
        expect(listProjectServiceStartApprovalArtifactIds([stored, local], { ...source, machineId: 'other' })).toEqual([]);
    });
});

describe('listOpenApprovalArtifactsForSession', () => {
    it('projects an open contributed Action approval into its bound Session', () => {
        const request = TargetActionApprovalRequestV1Schema.parse({
            v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
            qualifiedActionId: 'dev.leads-fixture/actions/update-stage', input: { leadId: 'verdant', stage: 'qualified' },
            sourceCustody: { kind: 'managed', immutableGenerationId: 'fixture-generation', installSource: 'npm' },
            policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), approvalInputCustody: 'live_only',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
                caller: { kind: 'session', sessionId: 'session-1', starterDepth: 0, turnDepth: 0 },
                serverId: 'server-a', sessionId: 'session-1', actionId: 'action.invoke', requestId: 'request-1' },
            summary: 'Update this lead’s stage?',
        });
        const stored = artifact('target-approval', buildTargetActionApprovalArtifactHeaderV1(request), request);
        expect(listOpenApprovalArtifactsForSession([stored], { serverId: 'server-a', sessionId: 'session-1' }))
            .toMatchObject([{ artifact: { id: 'target-approval' }, approval: { kind: 'plugin_target_action' } }]);
        expect(listOpenApprovalArtifactsForSession([stored], { serverId: 'server-a', sessionId: 'session-2' })).toEqual([]);
    });

    it.each([12, 139])('checks Home membership once per candidate on arrival among %i retained approvals', (retainedCount) => {
        const target = { serverId: 'server-a', sessionId: 'membership-cost-session' };
        const stored = (id: string) => {
            const body = ApprovalRequestV1Schema.parse(approvalBody(target.sessionId));
            return artifact(id, buildApprovalRequestArtifactHeaderV1(body, { legacyServerId: target.serverId }), body);
        };
        const retained = Array.from({ length: retainedCount }, (_, index) => stored(`membership-${index}`));
        const incoming = stored('membership-incoming');
        const initial = listTranscriptApprovalArtifactsForSession(retained, target);
        // Call-through observation only: Home equivalence and strict admission remain real.
        const comparisons = vi.spyOn(serverProfiles, 'areServerProfileIdentifiersEquivalent');
        try {
            const added = listTranscriptApprovalArtifactsForSession([...retained, incoming], target);
            expect(added).toHaveLength(retainedCount + 1);
            expect(added.slice(0, retainedCount).every((entry, index) => entry === initial[index])).toBe(true);
            expect(comparisons).toHaveBeenCalledTimes(retainedCount + 1);
        } finally { comparisons.mockRestore(); }
    });

    it.each([12, 139])('bounds TOTAL reference-producer serialization for one arrival among %i retained approvals', (retainedCount) => {
        const target = { serverId: 'server-a', sessionId: 'reference-cost-session' };
        const opaqueTarget = sessionAddressKey(target);
        const stored = (id: string) => {
            const body = ApprovalRequestV1Schema.parse(approvalBody(id.startsWith('distinct-open-reference-') ? id : target.sessionId));
            return artifact(id, buildApprovalRequestArtifactHeaderV1(body, { legacyServerId: target.serverId }), body);
        };
        const unrelated = Array.from({ length: retainedCount === 139 ? 861 : 0 }, (_, index) => artifact(`note-${index}`,
            { title: 'Note', kind: 'prompt_doc.v2' }, { markdown: 'Unrelated' }));
        const measurements: { producer: string; retained: number; single: number; arrival: number; repeat: number }[] = [];
        for (const producer of ['transcript', 'opaque-transcript', 'open-reference', 'distinct-open-reference'] as const) {
            const retained = Array.from({ length: retainedCount }, (_, index) => stored(`${producer}-${index}`));
            const incoming = stored(`${producer}-incoming`);
            const single = stored(`${producer}-single`);
            const project = (rows: readonly DecryptedArtifact[]) => producer === 'transcript' || producer === 'opaque-transcript'
                ? listTranscriptApprovalArtifactsForSession(rows, producer === 'opaque-transcript' ? opaqueTarget : target)
                : collectOpenApprovalSessionReferences(rows);
            // Count every producer serialization, including admission and membership. All fixtures
            // are constructed before observation; no signature-only or call-site filtering.
            const stringify = vi.spyOn(JSON, 'stringify');
            try {
                project([single]);
                const singleCount = stringify.mock.calls.length;
                project([...retained, ...unrelated]);
                stringify.mockClear();
                project([...retained, ...unrelated, incoming]);
                const arrival = stringify.mock.calls.length;
                stringify.mockClear();
                project([...retained, ...unrelated, incoming]);
                const repeat = stringify.mock.calls.length;
                measurements.push({ producer, retained: retainedCount, single: singleCount, arrival, repeat });
                // One new approval may do its own cold work, never repeat retained approvals' work.
                expect.soft(arrival, `${producer}: arrival versus one cold approval`).toBeLessThanOrEqual(singleCount);
                expect.soft(repeat, `${producer}: unchanged snapshots`).toBe(0);
            } finally { stringify.mockRestore(); }
        }
        console.info('approval producer TOTAL serialization counts', measurements);
    });

    it('admits only replaced header/body snapshots and retains unaffected entries across a scale-shaped publication', () => {
        const target = { serverId: 'server-a', sessionId: 'retained-session' };
        const stored = (index: number) => {
            const body = ApprovalRequestV1Schema.parse({ ...approvalBody(target.sessionId),
                origin: { kind: 'transcript_tool_call', sessionId: target.sessionId, toolCallId: `call-${index}` } });
            return artifact(`retained-${index}`, buildApprovalRequestArtifactHeaderV1(body, { legacyServerId: target.serverId }), body);
        };
        const retained = Array.from({ length: 139 }, (_, index) => stored(index));
        const unrelated = Array.from({ length: 861 }, (_, index) => artifact(`note-${index}`,
            { title: 'Note', kind: 'prompt_doc.v2' }, { markdown: 'Unrelated' }));
        const project = (rows: readonly DecryptedArtifact[]) => listTranscriptApprovalArtifactsForSession(rows, target);
        // Observe the real strict reader without replacing its schema/header admission.
        const admit = vi.spyOn(approvalAdmission, 'approvalArtifactBodyMatchesHeaderV1');
        try {
            const initial = project([...retained, ...unrelated]);
            expect(initial).toHaveLength(139);
            expect(admit).toHaveBeenCalledTimes(139);
            admit.mockClear();
            const incoming = stored(139);
            const added = project([...retained, ...unrelated, incoming]);
            expect(admit).toHaveBeenCalledTimes(1);
            expect(added.slice(0, 139).every((entry, index) => entry === initial[index])).toBe(true);
            expect(listOpenApprovalArtifactsForSession(retained, target).every((entry, index) => entry === initial[index])).toBe(true);
            expect(admit).toHaveBeenCalledTimes(1);

            const before = retained[42]!;
            const changedBody = ApprovalRequestV1Schema.parse({ ...approvalBody(target.sessionId),
                origin: { kind: 'transcript_tool_call', sessionId: target.sessionId, toolCallId: 'replacement-call' } });
            const changed = { ...before, body: JSON.stringify(changedBody), bodyVersion: 2 };
            const rows = [...retained.slice(0, 42), changed, ...retained.slice(43), incoming];
            admit.mockClear();
            const updated = project(rows);
            expect(admit).toHaveBeenCalledTimes(1);
            expect(updated[42]).not.toBe(added[42]);
            expect(updated[42]?.approval.origin?.toolCallId).toBe('replacement-call');
            expect(updated.every((entry, index) => index === 42 || entry === added[index])).toBe(true);

            admit.mockClear();
            const metadataOnly = { ...changed, updatedAt: 3 };
            const refreshed = project(rows.map(row => row === changed ? metadataOnly : row));
            expect(admit).not.toHaveBeenCalled();
            expect(refreshed[42]).toBe(updated[42]);
            expect(refreshed[42]?.artifact).toEqual({ id: metadataOnly.id, header: metadataOnly.header });
            expect(refreshed[42]?.approval).toBe(updated[42]?.approval);
            expect(refreshed.every((entry, index) => index === 42 || entry === updated[index])).toBe(true);

            const withdrawn = project(rows.filter(row => row !== changed));
            expect(admit).not.toHaveBeenCalled();
            expect(withdrawn).not.toContain(updated[42]);
            expect(withdrawn.every(entry => updated.includes(entry))).toBe(true);
            expect(listTranscriptApprovalArtifactsForSession(rows, { ...target, serverId: 'server-b' })).toEqual([]);
            expect(admit).not.toHaveBeenCalled();

            // A replacement header must pass strict duplicated-field checks even with a retained body.
            const invalidHeader = { ...metadataOnly, header: { ...metadataOnly.header, title: 'Mismatched header' }, headerVersion: 2 };
            expect(project([invalidHeader])).toEqual([]);
            expect(admit).toHaveBeenCalledTimes(1);
            expect(project([invalidHeader])).toEqual([]);
            expect(admit).toHaveBeenCalledTimes(1);
            expect(project([metadataOnly])[0]).toBe(refreshed[42]);
            const otherHome = { ...metadataOnly,
                header: buildApprovalRequestArtifactHeaderV1(changedBody, { legacyServerId: 'server-b' }) };
            admit.mockClear();
            expect(project([otherHome])).toEqual([]);
            const other = listTranscriptApprovalArtifactsForSession([otherHome], { ...target, serverId: 'server-b' });
            expect(other[0]?.artifact).toEqual({ id: otherHome.id, header: otherHome.header });
            expect(other[0]?.approval).not.toBe(refreshed[42]?.approval);
            expect(admit).toHaveBeenCalledTimes(1);
        } finally { admit.mockRestore(); }
    });

    it('retains reference facts across duplicate carriers without caching replaced Session links', () => {
        const body = ApprovalRequestV1Schema.parse(approvalBody('same'));
        const header = buildApprovalRequestArtifactHeaderV1(body, { legacyServerId: 'home-a' });
        const first = artifact('first', header, body);
        const second = artifact('second', header, body);
        const initial = collectOpenApprovalSessionReferences([first, second]);
        const remaining = collectOpenApprovalSessionReferences([second], initial);
        expect(remaining[0]).toBe(initial[0]);
        // Outer Session links are an independently retained slice, not part of the header identity.
        const extended = { ...second, sessions: ['same', 'additional'] };
        const linked = collectOpenApprovalSessionReferences([extended], remaining);
        expect(linked).toEqual(expect.arrayContaining([
            { kind: 'exact', address: { serverId: 'home-a', sessionId: 'same' } },
            { kind: 'exact', address: { serverId: 'home-a', sessionId: 'additional' } },
        ]));
        const replacedBody = ApprovalRequestV1Schema.parse(approvalBody('replacement'));
        const replaced = artifact('second', buildApprovalRequestArtifactHeaderV1(replacedBody, { legacyServerId: 'home-b' }), replacedBody);
        expect(collectOpenApprovalSessionReferences([replaced], linked)).toEqual([
            { kind: 'exact', address: { serverId: 'home-b', sessionId: 'replacement' } },
        ]);
        expect(collectOpenApprovalSessionReferences([{ ...replaced, body: '{}' }], linked)).toEqual([]);
    });

    it('does not re-admit unchanged unrelated approvals for a Session or closed Inbox entries', () => {
        const other = ApprovalRequestV1Schema.parse(approvalBody('other-session'));
        const open = artifact('other', buildApprovalRequestArtifactHeaderV1(other, { legacyServerId: 'server-a' }), other);
        const settled = ApprovalRequestV1Schema.parse({ ...other, status: 'rejected',
            decision: { kind: 'reject', decidedAtMs: 2 } });
        const closed = artifact('closed', buildApprovalRequestArtifactHeaderV1(settled, { legacyServerId: 'server-a' }), settled);
        const document = artifact('document', { title: 'Note', kind: 'prompt_doc.v2' }, { markdown: 'Note' });
        const admit = vi.spyOn(approvalAdmission, 'approvalArtifactBodyMatchesHeaderV1');
        try {
            for (let tick = 0; tick < 20; tick += 1) {
                expect(listTranscriptApprovalArtifactsForSession([open, closed, document],
                    { serverId: 'server-a', sessionId: 'session-1' }, {
                        knownSessionAddresses: [{ serverId: 'server-a', sessionId: 'other-session' }],
                        settledPresentations: [() => true],
                    })).toEqual([]);
                expect(isOpenApprovalInboxArtifact(closed)).toBe(false);
                expect(isOpenApprovalInboxArtifact(document)).toBe(false);
            }
            expect(admit).not.toHaveBeenCalled();
            // Header filtering is demand only: a matching row still requires strict body admission.
            expect(listOpenApprovalArtifactsForSession([{ ...open, body: '{}' }],
                { serverId: 'server-a', sessionId: 'other-session' }, {
                    knownSessionAddresses: [{ serverId: 'server-a', sessionId: 'other-session' }],
                })).toEqual([]);
            expect(admit).toHaveBeenCalledTimes(1);
        } finally { admit.mockRestore(); }
    });

    it('distinguishes immutable pending draft-review purpose through the strict private Inbox reader', () => {
        const request = ApprovalRequestV2Schema.parse({
            ...durableApprovalBody('publisher'), actionId: 'discussion.reply',
            actionArgs: { discussionId: 'discussion-a', content: { v: 1, parts: [{ t: 'text', text: 'Private answer' }] },
                replyTarget: { kind: 'message', messageId: 'question' } },
            executionOriginV1: { ...durableApprovalBody('publisher').executionOriginV1, actionId: 'discussion.reply' },
        });
        const reviewed = ApprovalRequestV2Schema.parse({ ...request, discussionDraftReview: true });
        const ordinary = artifact('ordinary', buildApprovalRequestArtifactHeaderV1(request), request);
        const draft = artifact('private-draft', buildApprovalRequestArtifactHeaderV1(reviewed), reviewed);
        const scope = { serverId: 'server-a', accountId: 'account-1' };
        const input = { scope, artifactScope: scope, artifactsLoaded: true,
            approvalEntries: [readOpenApprovalInboxEntry(ordinary)!, readOpenApprovalInboxEntry(draft)!],
            items: [{ id: 'discussion-a', unreadMentionCount: 1 }] };
        const rows = buildDiscussionListAttention(input);
        expect(rows[0]).toMatchObject({ attentionReason: 'draft_waiting', attentionType: 'approval', approvalArtifactIds: [ordinary.id, draft.id] });
        // The line speaks of the draft's Session when a draft is waiting, else of the request's.
        const otherDraft = ApprovalRequestV2Schema.parse({ ...reviewed,
            createdBy: { surface: 'system', sessionId: 'drafter' }, executionOriginV1: { ...reviewed.executionOriginV1, sessionId: 'drafter', target: { kind: 'session', sessionId: 'drafter' } } });
        expect(buildDiscussionListAttention({ ...input, approvalEntries: [readOpenApprovalInboxEntry(ordinary)!,
            readOpenApprovalInboxEntry(artifact('other-draft', buildApprovalRequestArtifactHeaderV1(otherDraft), otherDraft))!] })[0])
            .toMatchObject({ attentionReason: 'draft_waiting', waitingSessionId: 'drafter' });
        expect(rows[0]).toMatchObject({ waitingSessionId: 'publisher' });
        expect(buildDiscussionListAttention({ ...input, approvalEntries: [] })[0]).toMatchObject({ waitingSessionId: null });
        expect(buildDiscussionListAttention(input, rows)).toBe(rows);
        expect(buildDiscussionListAttention({ ...input, approvalEntries: [readOpenApprovalInboxEntry(ordinary)!] }, rows)[0])
            .toMatchObject({ attentionReason: 'approval_pending', attentionType: 'approval', approvalArtifactIds: [ordinary.id] });
        expect(readOpenApprovalInboxEntry({ ...draft, body: undefined })).toBeNull();
        expect(buildDiscussionListAttention({ ...input, approvalEntries: [] }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', attentionType: 'mention', approvalArtifactIds: [] });
        const settled = ApprovalRequestV2Schema.parse({ ...reviewed, status: 'executed', updatedAtMs: 2,
            decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result: {} } });
        expect(readOpenApprovalInboxEntry(artifact(draft.id, buildApprovalRequestArtifactHeaderV1(settled), settled))).toBeNull();
        expect(buildDiscussionListAttention({ ...input,
            approvalEntries: [] }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [] });
        expect(buildDiscussionListAttention({ ...input, artifactScope: { ...scope, accountId: 'other-account' } }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [], approvalAttentionAvailable: false });
        const otherHome = { ...scope, serverId: 'other-home' };
        expect(buildDiscussionListAttention({ ...input, scope: otherHome, artifactScope: otherHome }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [] });
    });

    it('qualifies Discussion approval attention by the strict Action target and captured Home', () => {
        const request = ApprovalRequestV2Schema.parse({
            ...durableApprovalBody('publisher'), actionId: 'discussion.reply',
            actionArgs: { discussionId: 'same-raw-discussion', content: { v: 1, parts: [{ t: 'text', text: 'Private answer' }] },
                replyTarget: { kind: 'message', messageId: 'question' } },
            executionOriginV1: { ...durableApprovalBody('publisher').executionOriginV1, actionId: 'discussion.reply' },
        });
        const open = artifact('reply-approval', buildApprovalRequestArtifactHeaderV1(request), request);
        const target = { serverId: 'server-a', discussionId: 'same-raw-discussion' };
        expect(readOpenApprovalDiscussionAttention(open)).toEqual({ ...target, reason: 'approval_pending', sessionId: 'publisher' });
        // The header list facts name the Discussion before the body is read; a read body must agree.
        expect(readOpenApprovalDiscussionAttention({ ...open, body: undefined })).toEqual({ ...target, reason: 'approval_pending', sessionId: 'publisher' });
        expect(readOpenApprovalDiscussionAttention({ ...open, header: { ...open.header, title: 'Changed index' } })).toBeNull();
        expect(readOpenApprovalDiscussionAttention({ ...open, draft: true })).toBeNull();
        const scope = { serverId: target.serverId, accountId: 'account-1' };
        const items = [{ id: target.discussionId, unreadMentionCount: 2 }, { id: 'quiet', unreadMentionCount: 0 }];
        const input = { scope, artifactScope: scope, artifactsLoaded: true, approvalEntries: [readOpenApprovalInboxEntry(open)!], items };
        const rows = buildDiscussionListAttention(input);
        expect(rows).toMatchObject([{ attentionReason: 'approval_pending', approvalArtifactIds: [open.id] },
            { attentionReason: null, approvalArtifactIds: [] }]);
        expect(buildDiscussionListAttention(input, rows)).toBe(rows);
        const otherHome = { ...scope, serverId: 'other-home' };
        expect(buildDiscussionListAttention({ ...input, scope: otherHome, artifactScope: otherHome }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [] });
        expect(buildDiscussionListAttention({ ...input, items: [{ id: 'other-discussion', unreadMentionCount: 0 }] }, rows)[0])
            .toMatchObject({ attentionReason: null, approvalArtifactIds: [] });
        expect(buildDiscussionListAttention({ ...input, approvalEntries: [] }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [] });
        expect(buildDiscussionListAttention({ ...input, artifactScope: { ...scope, accountId: 'different-account' } }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [], approvalAttentionAvailable: false });
        expect(buildDiscussionListAttention({ ...input, artifactsLoaded: false }, rows)[0])
            .toMatchObject({ attentionReason: 'approval_pending', approvalArtifactIds: [open.id], approvalAttentionAvailable: false });
        expect(buildDiscussionListAttention({ ...input, artifactsLoaded: false, approvalEntries: [] }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [], approvalAttentionAvailable: false });
    });

    it('keeps draft requests out of the canonical Inbox approval predicate', () => {
        const body = approvalBody('s1');
        const header = buildApprovalRequestArtifactHeaderV1(ApprovalRequestV1Schema.parse(body));
        expect(isOpenApprovalInboxArtifact(artifact('open', header, body))).toBe(true);
        expect(isOpenApprovalInboxArtifact(artifact('draft', { ...header, draft: true }, body))).toBe(false);
    });
    it('preserves every open approval when the Inbox uses its predicate as an array callback', () => {
        const body = ApprovalRequestV1Schema.parse(approvalBody('s1'));
        const header = buildApprovalRequestArtifactHeaderV1(body);
        const first = artifact('first', header, body);
        const second = artifact('second', header, body);
        expect([first, second, artifact('draft', { ...header, draft: true }, body)]
            .filter(isOpenApprovalInboxArtifact).map(row => row.id)).toEqual(['first', 'second']);
    });
    it('rejects bodyless approval indexes until the authoritative body is hydrated', () => {
        const approvals = listOpenApprovalArtifactsForSession([
            artifact('matching-session-id', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'open',
                sessionId: 's1',
                actionId: 'session.list',
                approvalSummary: 'List sessions',
            }),
            artifact('matching-sessions-array', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'open',
                sessions: ['s1'],
                actionId: 'session.status.get',
                approvalSummary: 'Read status',
            }),
            artifact('closed', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'executed',
                sessionId: 's1',
            }),
            artifact('other-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'open',
                sessionId: 's2',
            }),
        ], { serverId: 'home-a', sessionId: 's1' }, {
            knownSessionAddresses: [{ serverId: 'home-a', sessionId: 's1' }],
        });

        expect(approvals).toEqual([]);
    });
    it('requests each bodyless open Ask for Inbox admission exactly once and ignores settled indexes', () => {
        const open = artifact('managed-delete', {
            v: 1, kind: 'approval_request.v1', title: 'Delete managed machine', approvalStatus: 'open',
            actionId: 'machines.managed.delete', serverIdentityId: 'home-a',
        });
        const duplicate = { ...open };
        const settled = artifact('settled-delete', {
            v: 1, kind: 'approval_request.v1', title: 'Delete managed machine', approvalStatus: 'executed',
            actionId: 'machines.managed.delete', serverIdentityId: 'home-a',
        });
        const target = artifact('target-action', { kind: 'target_action_approval.v1', title: 'Target action', approvalStatus: 'open' });
        const host = artifact('host-action', { kind: 'execution_run_host_action_approval.v1', title: 'Host action', approvalStatus: 'open' });
        expect(listOpenApprovalInboxArtifactHydrationRequests([open, duplicate, settled, target, host], 'home-a')).toEqual([
            { artifactId: 'managed-delete', serverId: 'home-a' },
            { artifactId: 'target-action', serverId: 'home-a' },
            { artifactId: 'host-action', serverId: 'home-a' },
        ]);
    });

    it('hydrates from the inventory Home before a portable header identity is learned', () => {
        const header = buildApprovalRequestArtifactHeaderV1(ApprovalRequestV2Schema.parse({
            ...durableApprovalBody('session'), executionOriginV1: {
                ...durableApprovalBody('session').executionOriginV1,
                serverId: 'portable-home', serverIdentityId: 'portable-home',
            },
        }));
        const head = artifact('cold-approval', header);
        expect(listOpenApprovalInboxArtifactHydrationRequests([head], 'inventory-home')).toEqual([
            { artifactId: head.id, serverId: 'inventory-home' },
        ]);
        expect(listOpenApprovalInboxArtifactHydrationRequests([head])).toEqual([
            { artifactId: head.id, serverId: 'portable-home' },
        ]);
    });

    it('parses available approval bodies and drops malformed bodies', () => {
        const approvals = listOpenApprovalArtifactsForSession([
            artifact('body', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'List sessions',
                approvalStatus: 'open',
                sessionId: 's1',
                sessions: ['s1'],
                actionId: 'session.history.get',
            }, approvalBody('s1', 'session.history.get')),
            {
                ...artifact('malformed', {
                    v: 1,
                    kind: 'approval_request.v1',
                    title: 'List sessions',
                    approvalStatus: 'open',
                    sessionId: 's1',
                    sessions: ['s1'],
                    actionId: 'session.history.get',
                }),
                body: '{',
            },
        ], { serverId: 'home-a', sessionId: 's1' }, {
            knownSessionAddresses: [{ serverId: 'home-a', sessionId: 's1' }],
        });

        expect(approvals).toHaveLength(1);
        expect(approvals[0]?.artifact.id).toBe('body');
        expect(approvals[0]).toMatchObject({ approval: { actionId: 'session.history.get' } });
    });

    it('projects current V2 durable approvals into the Session approval surface', () => {
        const request = ApprovalRequestV2Schema.parse(durableApprovalBody('s1'));
        const approvals = listOpenApprovalArtifactsForSession([
            artifact('durable', buildApprovalRequestArtifactHeaderV1(request), request),
        ], buildSessionListServerScopedRowKey('server-a', 's1')!);

        expect(approvals).toHaveLength(1);
        expect(approvals[0]?.approval).toMatchObject({ v: 2, actionId: 'session.title.set' });
    });

    it('links a remote Agent approval by its portable Home identity through hydration and settlement', async () => {
        const serverUrl = 'https://approval-cross-device-home.test';
        const profile = await upsertServerProfile({ serverUrl });
        await setServerProfileIdentityForUrl(serverUrl, 'srv_approval_cross_device');
        const request = ApprovalRequestV2Schema.parse({
            ...durableApprovalBody('same-session'),
            executionOriginV1: { ...durableApprovalBody('same-session').executionOriginV1,
                serverId: 'remote-cli-profile', serverIdentityId: 'srv_approval_cross_device' },
        });
        const header = buildApprovalRequestArtifactHeaderV1(request);
        const head = artifact('remote-approval', header);
        const opened = artifact('remote-approval', header, request);
        const address = { serverId: profile.id, sessionId: 'same-session' };
        const knownSessionAddresses = [address, { serverId: 'other-home', sessionId: address.sessionId }];

        // A header locates the body hydration demand; it is not an open decision
        // or Session-attention fact until the body agrees with it.
        expect([...resolveOpenApprovalSessionKeys(collectOpenApprovalSessionReferences([head]), knownSessionAddresses)])
            .toEqual([]);
        expect([...resolveOpenApprovalSessionKeys(collectOpenApprovalSessionReferences([opened]), knownSessionAddresses)])
            .toEqual([buildSessionListServerScopedRowKey(profile.id, address.sessionId)]);
        expect(listOpenApprovalArtifactsForSession([opened], address, { knownSessionAddresses }))
            .toHaveLength(1);
        expect(listOpenApprovalArtifactsForSession([opened], {
            serverId: 'srv_approval_cross_device', sessionId: address.sessionId,
        }, { knownSessionAddresses })).toHaveLength(1);
        expect(listOpenApprovalArtifactsForSession([opened], knownSessionAddresses[1]!, { knownSessionAddresses })).toEqual([]);

        const settled = ApprovalRequestV2Schema.parse({ ...request, status: 'executed', updatedAtMs: 2,
            decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result: {} } });
        const completed = artifact('remote-approval', buildApprovalRequestArtifactHeaderV1(settled), settled);
        expect(collectOpenApprovalSessionReferences([completed])).toEqual([]);
        expect(listOpenApprovalArtifactsForSession([completed], address, { knownSessionAddresses })).toEqual([]);
        expect(listTranscriptApprovalArtifactsForSession([completed], address, {
            knownSessionAddresses, settledPresentations: [() => true],
        })).toHaveLength(1);
    });

    it('keeps a legacy unscoped approval on its linked Session within one exact Home', () => {
        const request = ApprovalRequestV1Schema.parse({ ...approvalBody('session-a'),
            createdBy: { surface: 'cli', sessionId: 'session-a' }, requestedSurface: 'cli' });
        // 0.2 cliApprovalsArtifactStore writes this Session binding without a Home.
        const header = buildApprovalRequestArtifactHeaderV1(request);
        const opened = artifact('legacy-session-a', header, request);
        const head = artifact(opened.id, header);
        const sessionA = { serverId: 'home-a', sessionId: 'session-a' };
        const sessionB = { serverId: 'home-a', sessionId: 'session-b' };
        const knownSessionAddresses = [sessionA, sessionB];
        const options = { knownSessionAddresses };

        // A Work Instructions footer demands this Action's receipts, not every Session approval body.
        const unrelated = Array.from({ length: 1000 }, (_, index) => artifact(`unrelated-${index}`, header));
        const instructions = artifact('instructions-edit', { ...header, actionId: 'prompt_doc.update' });
        expect(listApprovalArtifactIdsNeedingHydrationForSession([...unrelated, instructions], sessionA,
            knownSessionAddresses, ['prompt_doc.update'])).toEqual(['instructions-edit']);

        expect(listOpenApprovalArtifactsForSession([opened], sessionA, options).map(entry => entry.artifact.id))
            .toEqual([opened.id]);
        expect(listOpenApprovalArtifactsForSession([opened], sessionB, options)).toEqual([]);
        expect(listTranscriptApprovalArtifactsForSession([opened], sessionB, options)).toEqual([]);
        expect(listApprovalArtifactIdsNeedingHydrationForSession([head], sessionA, knownSessionAddresses))
            .toEqual([opened.id]);
        expect(listApprovalArtifactIdsNeedingHydrationForSession([head], sessionB, knownSessionAddresses)).toEqual([]);
        expect([...resolveOpenApprovalSessionKeys(collectOpenApprovalSessionReferences([opened]), knownSessionAddresses)])
            .toEqual([buildSessionListServerScopedRowKey(sessionA.serverId, sessionA.sessionId)]);
        expect(isOpenApprovalInboxArtifact(opened)).toBe(true);
        expect(listOpenApprovalArtifactsForSession([opened], { ...sessionA, serverId: 'home-b' }, options)).toEqual([]);

        const accountRequest = ApprovalRequestV1Schema.parse({ ...request, createdBy: { surface: 'cli' } });
        const accountApproval = artifact('legacy-account', buildApprovalRequestArtifactHeaderV1(accountRequest), accountRequest);
        expect(isOpenApprovalInboxArtifact(accountApproval)).toBe(true);
        for (const target of knownSessionAddresses) {
            expect(listOpenApprovalArtifactsForSession([accountApproval], target, options)).toEqual([]);
        }
    });

    it('admits a legacy unscoped approval only when canonical membership resolves one exact Home', () => {
        const legacy = artifact('legacy', {
            v: 1,
            kind: 'approval_request.v1',
            title: 'List sessions',
            approvalStatus: 'open',
            sessionId: 'same',
            sessions: ['same'],
            actionId: 'session.list',
        }, approvalBody('same'));

        expect(collectOpenApprovalSessionReferences([legacy])).toEqual([
            { kind: 'legacy_unscoped', sessionId: 'same' },
        ]);

        expect(listOpenApprovalArtifactsForSession([legacy], { serverId: 'home-a', sessionId: 'same' }, {
            knownSessionAddresses: [{ serverId: 'home-a', sessionId: 'same' }],
        })).toHaveLength(1);
        expect(listOpenApprovalArtifactsForSession([legacy], { serverId: 'home-a', sessionId: 'same' }, {
            knownSessionAddresses: [
                { serverId: 'home-a', sessionId: 'same' },
                { serverId: 'home-b', sessionId: 'same' },
            ],
        })).toEqual([]);
    });
});

describe('collectOpenApprovalSessionReferences', () => {
    it('collects only sessions linked to currently open approval artifacts', () => {
        const references = collectOpenApprovalSessionReferences([
            artifact('header-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'List sessions',
                approvalStatus: 'open',
                sessionId: 's1',
                sessions: ['s1'],
                actionId: 'session.list',
                approvalSummary: 'List sessions',
            }, approvalBody('s1')),
            artifact('body-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'List sessions',
                approvalStatus: 'open',
                sessionId: 's2',
                sessions: ['s2'],
                actionId: 'session.list',
            }, approvalBody('s2')),
            artifact('closed', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'rejected',
                sessionId: 's3',
                actionId: 'session.list',
                approvalSummary: 'List sessions',
            }),
        ]);

        expect(references).toEqual([
            { kind: 'legacy_unscoped', sessionId: 's1' },
            { kind: 'legacy_unscoped', sessionId: 's2' },
        ]);
    });

    it('uses server-scoped identities when approval artifacts carry a server id', () => {
        const references = collectOpenApprovalSessionReferences([
            artifact('header-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'List sessions',
                approvalStatus: 'open',
                sessionId: 's1',
                sessions: ['s1'],
                serverId: 'server-a',
                actionId: 'session.list',
                approvalSummary: 'List sessions',
            }, approvalBody('s1')),
        ]);

        expect(references).toEqual([{
            kind: 'exact',
            address: { serverId: 'server-a', sessionId: 's1' },
        }]);
    });

    it('resolves legacy references once and never broadcasts them across duplicate Homes', () => {
        const references = [{ kind: 'legacy_unscoped', sessionId: 'same' }] as const;
        expect([...resolveOpenApprovalSessionKeys(references, [
            { serverId: 'home-a', sessionId: 'same' },
        ])]).toEqual([buildSessionListServerScopedRowKey('home-a', 'same')]);
        expect([...resolveOpenApprovalSessionKeys(references, [
            { serverId: 'home-a', sessionId: 'same' },
            { serverId: 'home-b', sessionId: 'same' },
        ])]).toEqual([]);
    });
});

describe('listTranscriptApprovalArtifactsForSession', () => {
    it('matches an uncorrelated MCP approval only by its exact tool and input, never just its name', () => {
        const approval = ApprovalRequestV2Schema.parse({ ...durableApprovalBody('s1'),
            origin: { kind: 'transcript_tool_call', sessionId: 's1', toolName: 'action_execute', mcpRequestId: '2' } });
        const request = { artifact: artifact('uncorrelated', buildApprovalRequestArtifactHeaderV1(approval), approval), approval };
        const tool = { id: 'provider-call', name: 'mcp__happier__action_execute',
            input: { actionId: 'session.title.set', input: { title: 'Current title', sessionId: 's1' } },
            state: 'completed', createdAt: 1, startedAt: 1, completedAt: 2, description: null } as const;
        const match = (candidate: ToolCall) => doesApprovalMatchToolCall({
            request, tool: candidate, sessionId: 's1', messageId: 'message-1', normalizedToolName: 'MCP' });
        expect(match(tool)).toBe(true);
        expect(match({ ...tool, input: { actionId: 'session.title.set', input: { sessionId: 's1', title: 'Another title' } } })).toBe(false);
        expect(match({ ...tool, input: { actionId: 'session.title.set' } })).toBe(false);
        expect(match({ ...tool, name: 'mcp__foreign__action_execute' })).toBe(false);
        expect(match({ ...tool, input: { actionId: 'skills.delete', input: approval.actionArgs } })).toBe(false);
        expect(doesApprovalMatchToolCall({ request, tool, sessionId: 'other-session', messageId: 'message-1', normalizedToolName: 'MCP' })).toBe(false);
        const direct = { ...request, approval: { ...approval, origin: { ...approval.origin!, toolName: 'session_title_set' } } };
        expect(doesApprovalMatchToolCall({ request: direct, tool: { ...tool, name: 'session_title_set', input: approval.actionArgs },
            sessionId: 's1', messageId: 'message-1', normalizedToolName: 'session_title_set' })).toBe(true);
        expect(doesApprovalMatchToolCall({ request: direct, tool: { ...tool, name: 'session_title_set', input: {} },
            sessionId: 's1', messageId: 'message-1', normalizedToolName: 'session_title_set' })).toBe(false);
    });

    const settled = (status: 'rejected' | 'executed') => ApprovalRequestV2Schema.parse({
        ...durableApprovalBody('s1'), status, updatedAtMs: 2,
        decision: { kind: status === 'rejected' ? 'reject' : 'approve', decidedAtMs: 2 },
        ...(status === 'executed' ? { execution: { executedAtMs: 3, ok: true, result: {} } } : {}),
    });
    const target = buildSessionListServerScopedRowKey('server-a', 's1')!;

    it.each(['rejected', 'canceled'] as const)('keeps a %s Skills Action review only at its originating call', status => {
        const spec = getActionSpec('skills.rules.set');
        const actionArgs = spec.inputSchema.parse({ items: [{ skillId: 'skill-1' }],
            change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } } });
        const request = ApprovalRequestV2Schema.parse({
            ...durableApprovalBody('s1'), actionId: spec.id, actionArgs, status, updatedAtMs: 2,
            executionOriginV1: { ...durableApprovalBody('s1').executionOriginV1, actionId: spec.id },
            origin: { kind: 'transcript_tool_call', sessionId: 's1', toolCallId: 'skills-call' },
            ...(status === 'rejected' ? { decision: { kind: 'reject', decidedAtMs: 2 } } : {}),
        });
        const stored = artifact('skills-review', buildApprovalRequestArtifactHeaderV1(request), request);
        const options = { settledPresentations: TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS };
        const selected = listTranscriptApprovalArtifactsForSession([stored], target, options);
        expect(selected.map(entry => entry.artifact.id)).toEqual(['skills-review']);
        const tool = { id: 'skills-call', name: 'mcp__happier__action_execute', input: {}, state: 'error',
            createdAt: 1, startedAt: 1, completedAt: 2, description: null } as const;
        expect(doesApprovalMatchToolCall({ request: selected[0]!, sessionId: 's1', messageId: 'message-1',
            tool, normalizedToolName: 'MCP' })).toBe(true);
        expect(doesApprovalMatchToolCall({ request: selected[0]!, sessionId: 's1', messageId: 'message-1',
            tool: { ...tool, id: 'other-call' }, normalizedToolName: 'MCP' })).toBe(false);
        const detached = ApprovalRequestV2Schema.parse({ ...request, origin: undefined });
        expect(listTranscriptApprovalArtifactsForSession([
            artifact('detached', buildApprovalRequestArtifactHeaderV1(detached), detached),
        ], target, options)).toEqual([]);
        expect(listOpenApprovalArtifactsForSession([stored], target)).toEqual([]);
    });

    it('keeps an execution failure with the composer attention owner rather than the declined transcript rule', () => {
        const request = ApprovalRequestV2Schema.parse({ ...durableApprovalBody('s1'), status: 'failed', updatedAtMs: 3,
            origin: { kind: 'transcript_tool_call', sessionId: 's1', toolCallId: 'failed-call' },
            decision: { kind: 'approve', decidedAtMs: 2 },
            execution: { executedAtMs: 3, effectAttempted: false, ok: false,
                errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' },
        });
        const stored = artifact('failed-review', buildApprovalRequestArtifactHeaderV1(request), request);
        expect(listTranscriptApprovalArtifactsForSession([stored], target, {
            settledPresentations: TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS,
        })).toEqual([]);
        expect(listTranscriptApprovalArtifactsForSession([stored], target, {
            settledPresentations: COMPOSER_SETTLED_APPROVAL_PRESENTATIONS,
        }).map(entry => entry.artifact.id)).toEqual(['failed-review']);
    });

    it.each([
        { status: 'canceled', client: { clientId: 'public-client', clientSecret: 'private-fixture' }, operation: 'set' },
        { status: 'rejected', client: null, operation: 'remove' },
    ] as const)('keeps the $status MCP sign-in review at its originating tool call', ({ status, client, operation }) => {
        const spec = getActionSpec('mcp.servers.signIn.start');
        const input = { serverId: 'mcp-server', client };
        // Live-only Actions persist observation operands and a separate safe review preview.
        const actionArgs = spec.projectObservationInput!(input);
        const preview = { actionId: spec.id, actionArgs: spec.approvalPresentation!.projectInput!(input) };
        const request = ApprovalRequestV2Schema.parse({
            ...durableApprovalBody('s1'), actionId: spec.id, actionArgs, preview, status, updatedAtMs: 2,
            executionOriginV1: { ...durableApprovalBody('s1').executionOriginV1, actionId: spec.id },
            origin: { kind: 'transcript_tool_call', sessionId: 's1', toolCallId: 'oauth-call' },
            ...(status === 'rejected' ? { decision: { kind: 'reject', decidedAtMs: 2 } } : {}),
        });
        const stored = artifact('oauth-review', buildApprovalRequestArtifactHeaderV1(request), request);
        const selected = listTranscriptApprovalArtifactsForSession([stored], target, {
            settledPresentations: TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS,
        });
        expect(selected.map(entry => entry.artifact.id)).toEqual(['oauth-review']);
        expect(doesApprovalMatchToolCall({ request: selected[0]!, sessionId: 's1', messageId: 'message-1',
            tool: { id: 'oauth-call', name: 'mcp__happier__action_execute', input: {}, state: 'error',
                createdAt: 1, startedAt: 1, completedAt: 2, description: null },
            normalizedToolName: 'MCP',
        })).toBe(true);
        const fields = describeApprovalRequestFields(selected[0]!.approval);
        expect(fields.rows).toContainEqual(expect.objectContaining({ path: 'oauthApp', selectedOptions: [expect.objectContaining({
            labelKey: operation === 'set' ? 'capabilities.mcpSignIn.reviewSetApp' : 'capabilities.mcpSignIn.reviewRemoveApp',
        })] }));
        expect(fields.rows.filter(row => row.path === 'clientId')).toEqual(operation === 'set'
            ? [expect.objectContaining({ value: 'public-client' })] : []);
        expect(JSON.stringify(fields)).not.toContain('private-fixture');
        expect(listOpenApprovalArtifactsForSession([stored], target)).toEqual([]);
        expect(listTranscriptApprovalArtifactsForSession([stored], { serverId: 'server-b', sessionId: 's1' }, {
            settledPresentations: TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS,
        })).toEqual([]);
    });

    it('keeps a settled approval in the transcript only when its body declares a settled presentation', () => {
        const declined = settled('rejected');
        const executed = settled('executed');
        const artifacts = [
            artifact('declined', buildApprovalRequestArtifactHeaderV1(declined), declined),
            artifact('executed', buildApprovalRequestArtifactHeaderV1(executed), executed),
            artifact('open', buildApprovalRequestArtifactHeaderV1(ApprovalRequestV2Schema.parse(durableApprovalBody('s1'))), durableApprovalBody('s1')),
        ];
        const presents = [(approval: { status: string }) => approval.status === 'executed'];

        expect(listTranscriptApprovalArtifactsForSession(artifacts, target, { settledPresentations: presents })
            .map((entry) => entry.artifact.id).sort()).toEqual(['executed', 'open']);
        // Without a declaring body nothing settled is kept, and the open projection is unchanged.
        expect(listTranscriptApprovalArtifactsForSession(artifacts, target).map((entry) => entry.artifact.id)).toEqual(['open']);
        expect(listOpenApprovalArtifactsForSession(artifacts, target).map((entry) => entry.artifact.id)).toEqual(['open']);
    });
});
