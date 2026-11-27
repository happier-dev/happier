import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { LocalServiceStartApprovalReviewV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { ACCOUNT_ERASURE_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountErasure';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { AccountSettingsV2UpdateRequestSchema} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ApprovalRequestSchema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { SessionMessageReplyProgressV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { PROJECT_TRUST_ROUTE_V1, ProjectTrustMutationRequestV1Schema, ProjectTrustReadResponseV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit';
import { t, setPreferredLanguageFromSettings, preloadTranslations } from '@/text';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { Modal } = await import('@/modal');

/** A receiving Machine without a presenter: it carries its review back and admits only a confirmation of that review. */
const REVIEW_DIGEST = 'M'.repeat(43);
const refusedWithReview = Symbol('refused-with-review');
const refuseWithReview = (input: unknown, summary: string) => ({ [refusedWithReview]: { input, summary } });
const carriedMachineReview = (result: unknown) => {
    if (typeof result !== 'object' || result === null || !(refusedWithReview in result)) return null;
    const carried = (result as { [refusedWithReview]: { input: unknown; summary?: string; preview?: unknown } })[refusedWithReview];
    return { errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required',
        details: { review: { actionArgs: carried.input, preview: carried.preview ?? { summary: carried.summary } }, reviewDigest: REVIEW_DIGEST } };
};

describe('present-user UI approval origin at the Action host', () => {
    const shownReviews: Array<Parameters<typeof Modal.show>[0]> = [];
    let confirmationAnswer = false;
    let beforeConfirmationAnswer: (() => void) | null = null;
    beforeEach(async () => {
        await harness.reset();
        confirmationAnswer = false;
        beforeConfirmationAnswer = null;
        shownReviews.length = 0;
        vi.mocked(Modal.confirm).mockReset().mockResolvedValue(false);
        vi.mocked(Modal.show).mockReset().mockImplementation(config => {
            shownReviews.push(config);
            // The modal host is the platform boundary; all approval owners remain real.
            const props = config.props as { onAnswer(confirmed: boolean): void };
            queueMicrotask(() => {
                beforeConfirmationAnswer?.();
                props.onAnswer(confirmationAnswer);
            });
            return 'action-review';
        });
    });
    afterEach(() => { setPreferredLanguageFromSettings('en'); standardCleanup(); });

    it.each(['actions.policy.set', 'actions.policy.reset'] as const)(
        'restores an Ask-first Usage policy through %s on its captured Account', async actionId => {
            const serverId = await harness.addHome({ name: 'Usage policy', serverUrl: 'https://usage-policy.test', accountId: 'alice' });
            let raw: Record<string, unknown> = {};
            let version = 0;
            harness.answer(serverId, '/v2/account/settings', { select: input => {
                if (input === null || input === undefined) return { body: { content: { t: 'plain', v: raw }, version } };
                const request = AccountSettingsV2UpdateRequestSchema.parse(input);
                if (request.expectedVersion !== version) return { body: { success: false, error: 'version-mismatch', currentVersion: version,
                    currentContent: { t: 'plain', v: raw } } };
                if (request.content?.t !== 'plain') throw new Error('Expected Plain Account settings');
                raw = request.content.v;
                return { body: { success: true, version: ++version } };
            } });
            confirmationAnswer = true;
            const executor = createDefaultActionExecutor();
            const context = { surface: 'ui', authority: 'present_user', serverId, actionCaller: { kind: 'host' } } as const;
            const target = { actionId: 'usage.prices.refresh', audience: 'ui' } as const;
            const setup = await executor.execute('actions.policy.set', { ...target, mode: 'ask_first' }, context);
            expect(setup, JSON.stringify(setup))
                .toMatchObject({ ok: true, result: { mode: 'ask_first' } });
            const restored = await executor.execute(actionId, actionId === 'actions.policy.set' ? { ...target, mode: 'default' } : target, context);
            expect(restored, JSON.stringify(restored))
                .toMatchObject({ ok: true, result: { mode: 'default' } });
            expect(await executor.execute('actions.policy.get', target, context))
                .toMatchObject({ ok: true, result: { mode: 'default' } });
        },
    );

    it.each(['unmount', 'lost transport', 'double dispatch', 'decline', 'withdraw'] as const)(
        'keeps a deferred CLI request actionable until daemon decision admission (%s)', async scenario => {
            const serverIdentityId = 'srv_deferred_cli';
            const serverId = await harness.addHome({
                name: 'Approval Home', serverUrl: 'https://deferred-cli.test',
                accountId: 'alice', serverIdentityId, currentAccount: true,
            });
            const machineId = 'cli-origin-machine';
            await installOwnMachineApprovalReplayBoundary({ harness, serverId, accountId: 'alice', machineId });
            const actionId = 'paths.list_recent';
            const request = ApprovalRequestV2Schema.parse({
                v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, summary: 'Review a Machine read',
                createdBy: { surface: 'cli' }, requestedSurface: 'cli', approval: { flow: 'deferred', result: 'required' },
                actionId, actionArgs: { machineId, limit: 10 },
                executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                    serverId: 'cli-local-home', serverIdentityId, accountId: 'alice',
                    machineId, actionId, requestId: 'cli-deferred-machine-read' },
            });
            const { captureLazyActionAccountContext } = await import('./actionAccountContext');
            const account = await captureLazyActionAccountContext(serverId);
            const header = buildApprovalRequestArtifactHeaderV1(request);
            let artifactId: string;
            try { artifactId = await account.createArtifact(header, JSON.stringify(request)); }
            finally { account.dispose(); }
            const readStored = () => ApprovalRequestV2Schema.parse(
                JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId) ?? 'null'));
            const { useApprovalDecisionHandler } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
            const hook = await renderHook(() => useApprovalDecisionHandler({ id: artifactId, header }, request, '', serverId));
            const path = '/v1/actions/approval.request.decide';
            const dispatchStatuses: string[] = [];
            let effects = 0;
            const { approvalArtifactBodyMatchesHeaderV1 } = await import('@happier-dev/protocol/approvals/approvalArtifactHeaderV1');
            const { writeApprovalRequestArtifact } = await import('./approvalArtifactWriter');
            const receive = async (input: unknown) => {
                const daemon = await captureLazyActionAccountContext(serverId);
                const read = (id: string) => daemon.fetchArtifact(id);
                try {
                    const receiver = createActionExecutor({
                        approvalsGet: async ({ artifactId }) => {
                            const artifact = await read(artifactId);
                            if (!artifact?.header || typeof artifact.body !== 'string') return null;
                            const match = approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body);
                            return match?.family === 'built_in' ? match.request : null;
                        },
                        approvalsUpdate: async ({ artifactId, request, expectedStatus }) => writeApprovalRequestArtifact({
                            artifactId, request, expectedStatus, read,
                            write: (basis, header, body) => daemon.updateArtifact(artifactId, header, body, basis),
                        }),
                        isApprovalExecutionOriginCurrent: async ({ origin }) => origin.machineId === machineId,
                        pathsListRecent: async () => { effects++; return []; },
                    });
                    return await receiver.execute('approval.request.decide', input, {
                        surface: 'ui', authority: 'present_user', serverId, serverIdentityId, runtimeAccountId: 'alice',
                    });
                } finally { daemon.dispose(); }
            };
            let unmounted = false;
            if (scenario === 'unmount') {
                const artifactPath = '/v1/artifacts/' + artifactId;
                harness.answer(serverId, 'GET ' + artifactPath, { select: async (_input, incoming) => {
                    if (!unmounted) {
                        unmounted = true;
                        await hook.unmount();
                    }
                    const response = await harness.artifacts(serverId).handle(artifactPath, incoming.init);
                    if (!response) throw new Error('Missing Artifact read boundary');
                    return { status: response.status, body: await response.json() };
                } });
            }
            harness.answer(serverId, path, { select: async input => {
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
                dispatchStatuses.push(readStored().status);
                expect(envelope.target).toEqual({ kind: 'machine', machineId });
                expect(envelope.input).toMatchObject({ artifactId, decision: 'approve',
                    serverIdentityId, originServerId: 'cli-local-home' });
                if (scenario === 'lost transport') throw new TypeError('Failed to fetch');
                return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide',
                    requestId: envelope.requestId, execution: await receive(envelope.input) }) };
            } });
            const decision = hook.getCurrent();
            if (scenario === 'decline' || scenario === 'withdraw') {
                await expect(decision(scenario === 'decline' ? 'reject' : 'cancel')).resolves.toBe(true);
                expect(readStored().status).toBe(scenario === 'decline' ? 'rejected' : 'canceled');
                await expect(decision('approve')).rejects.toMatchObject({ code: 'approval_not_open' });
                expect(dispatchStatuses).toEqual([]);
                expect(effects).toBe(0);
            } else if (scenario === 'lost transport') {
                await expect(decision('approve')).rejects.toBeDefined();
                expect(dispatchStatuses).toEqual(['open']);
                expect(readStored()).toMatchObject({ status: 'open' });
                expect(readStored().execution).toBeUndefined();
                expect(effects).toBe(0);
            } else if (scenario === 'unmount') {
                await expect(decision('approve')).resolves.toBe(true);
                expect(unmounted).toBe(true);
                expect(dispatchStatuses).toEqual(['open']);
                expect(readStored()).toMatchObject({ status: 'executed', execution: { ok: true } });
                expect(effects).toBe(1);
            } else {
                await Promise.allSettled([decision('approve'), decision('approve')]);
                expect(dispatchStatuses).toHaveLength(2);
                expect(readStored()).toMatchObject({ status: 'executed', execution: { ok: true } });
                expect(effects).toBe(1);
            }
        },
    );

    it('keeps a private Post open until the exact daemon accepts its decision', async () => {
        const serverIdentityId = 'srv_private_post';
        const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://private-post.test',
            accountId: 'alice', serverIdentityId, currentAccount: true });
        await installOwnMachineApprovalReplayBoundary({ harness, serverId, accountId: 'alice', machineId: 'reviewer-machine' });
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'reviewer-session' }, requestedSurface: 'agent', discussionDraftReview: true,
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: 'daemon-local-profile', serverIdentityId, accountId: 'alice', sessionId: 'reviewer-session',
                machineId: 'reviewer-machine', actionId: 'discussion.reply', requestId: 'private-answer',
                discussionReplyReturn: { serverId: serverIdentityId, requestLocalId: 'original-input', acceptedTurnId: 'turn' } },
            actionId: 'discussion.reply', actionArgs: { discussionId: 'private-discussion', localId: 'private-answer',
                content: { v: 1, parts: [{ t: 'text', text: 'Private answer' }] },
                replyTarget: { kind: 'message', messageId: 'question' } }, summary: 'Post the answer' });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        let artifactId: string;
        try { artifactId = await account.createArtifact(buildApprovalRequestArtifactHeaderV1(request), JSON.stringify(request)); }
        finally { account.dispose(); }
        let statusAtDaemonIngress: string | undefined;
        harness.answer(serverId, '/v1/actions/approval.request.decide', { select: input => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
            expect(envelope.input).toMatchObject({ artifactId, decision: 'approve' });
            statusAtDaemonIngress = ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId) ?? 'null')).status;
            // Refusal at the genuine daemon ingress boundary must not leave
            // browser-owned consent stranded without a publication executor.
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide',
                requestId: envelope.requestId, execution: { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' } }) };
        } });
        const result = await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'approve' },
            { surface: 'ui', authority: 'present_user', serverId });
        expect(statusAtDaemonIngress).toBe('open');
        expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId) ?? 'null')).status).toBe('open');
        expect(harness.requestsFor('/v1/actions/approval.request.decide')).toHaveLength(1);
    });

    it.each(['portable', 'foreign'] as const)(
        'settles a rejected private Discussion original through its immutable Home (%s)', async binding => {
        const serverIdentityId = 'srv_discussion_review_home';
        const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://discussion-review.test',
            accountId: 'alice', serverIdentityId });
        const sessionId = 'reviewer-session';
        const requestLocalId = 'discussion-follow-v1:private-question';
        const acceptedTurnId = 'native-turn-private-question';
        const discussion = { discussionId: 'private-discussion', messageId: 'private-question', throughSeq: 7,
            participantSessionId: sessionId };
        let progress = SessionMessageReplyProgressV1Schema.parse({ v: 1, mode: 'return', discussion, acceptedTurnId,
            disposition: 'return_pending', outcome: { kind: 'answer', result: { sessionId, messageId: 'private-answer' } } });
        const replyPath = `/v2/sessions/${sessionId}/messages/by-local-id/${encodeURIComponent(requestLocalId)}/reply`;
        harness.answer(serverId, `POST ${replyPath}`, { select: input => {
            expect(input).toEqual({ kind: 'discussion_review', discussionId: discussion.discussionId,
                messageId: discussion.messageId, decision: 'reject', acceptedTurnId });
            progress = SessionMessageReplyProgressV1Schema.parse({ ...progress, disposition: 'released', outcome: { kind: 'declined' } });
            return { body: { v: 1, ok: true, progress } };
        } });
        const originServerId = 'creator-device-local-home';
        const originIdentityId = binding === 'foreign' ? 'srv_different_home' : serverIdentityId;
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId }, requestedSurface: 'agent', discussionDraftReview: true,
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: originServerId, serverIdentityId: originIdentityId,
                accountId: 'alice', sessionId, machineId: 'reviewer-machine', actionId: 'discussion.reply', requestId: 'private-answer',
                discussionReplyReturn: { serverId: originIdentityId, requestLocalId, acceptedTurnId } },
            actionId: 'discussion.reply', actionArgs: { discussionId: discussion.discussionId, localId: 'private-answer',
                content: { v: 1, parts: [{ t: 'text', text: 'Private draft' }] },
                replyTarget: { kind: 'message', messageId: discussion.messageId } }, summary: 'Reply in a discussion.' });
        // This models the persisted source-device Artifact at the Home boundary;
        // its client codec, transition/CAS owner and captured-Home checks stay live.
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        let artifactId: string;
        try { artifactId = await account.createArtifact(buildApprovalRequestArtifactHeaderV1(request), JSON.stringify(request)); }
        finally { account.dispose(); }
        const { useApprovalDecisionHandler } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
        const hook = await renderHook(() => useApprovalDecisionHandler({ id: artifactId, header: null }, request, sessionId, serverId));
        const outcome: unknown = await hook.getCurrent()('reject').catch((error: unknown) => error);
        const stored = ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId) ?? 'null'));
        expect(stored.executionOriginV1).toEqual(request.executionOriginV1);
        expect(stored.execution).toBeUndefined();
        if (binding === 'foreign') {
            expect(stored.status).toBe('open');
            expect(outcome).toMatchObject({ code: 'approval_origin_unavailable' });
            expect(progress.disposition).toBe('return_pending');
            expect(harness.requestsFor(replyPath)).toEqual([]);
        } else {
            expect(stored).toMatchObject({ status: 'rejected', decision: { kind: 'reject' } });
            expect(outcome).toBe(true);
            expect(progress).toMatchObject({ disposition: 'released', outcome: { kind: 'declined' } });
            expect(harness.requestsFor(replyPath)).toHaveLength(1);
        }
    });

    it('opens a generic confirmation with no repeated title body and declines without deleting', async () => {
        const serverId = await harness.addHome({ name: 'Drafts', serverUrl: 'https://draft-confirmation.test', accountId: 'alice' });
        const result = await createDefaultActionExecutor().execute('session.draft.delete', { draftId: '4135b238-607a-458d-b96c-7877d8076877' },
            { surface: 'ui', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(shownReviews).toHaveLength(1);
        expect(shownReviews[0]?.chrome).toMatchObject({ kind: 'card', title: expect.any(String) });
        expect(shownReviews[0]?.chrome).not.toHaveProperty('subtitle');
        // The confirm button carries the approval presentation's verb and destructive styling, never a bare OK (5b4ff8f3a5).
        expect(shownReviews[0]?.props).toMatchObject({ confirmLabel: 'Delete', irreversible: true });
        expect(harness.artifacts(serverId).list()).toEqual([]);
    });

    it('keeps the Account Delete review and typed challenge in one dialog before any deletion', async () => {
        const serverId = await harness.addHome({ name: 'Delete Home', serverUrl: 'https://delete-review.test', accountId: 'alice' });
        await harness.requireUiApproval(serverId, 'account.delete');
        vi.mocked(Modal.prompt).mockClear();
        const input = getActionSpec('account.delete').inputSchema.parse({ serverId, accountId: 'alice' });
        const result = await createDefaultActionExecutor().execute('account.delete', input,
            { surface: 'ui', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(Modal.prompt).not.toHaveBeenCalled();
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(shownReviews).toHaveLength(1);
        expect(shownReviews[0]?.props).toMatchObject({ actionId: 'account.delete', actionArgs: input,
            irreversible: true, preview: expect.any(Object), typedConfirmation: {
                text: 'DELETE', placeholder: 'DELETE', instruction: t('settingsAccount.deleteAccountTypeToContinue'),
            } });
        // R19-D6: what goes is the card's lead sentence, above the reviewed facts and their Technical details.
        expect(shownReviews[0]?.chrome).toMatchObject({ subtitle: t('settingsAccount.deleteAccountConsequence') });
        expect(harness.requestsFor(ACCOUNT_ERASURE_HTTP_PATH_V1)).toEqual([]);
        expect(harness.artifacts(serverId).list()).toEqual([]);
    });

    it('localizes a Reset confirmation using the captured Role source without applying a declined reset', async () => {
        const serverId = await harness.addHome({ name: 'Roles', serverUrl: 'https://role-confirmation.test', accountId: 'alice' });
        const executor = createDefaultActionExecutor();
        const roleId = '6780a145-8590-47fa-b294-c5a90aef4041';
        const created = await executor.execute('roles.create', {
            roleId, role: { ...BUILT_IN_ROLES_V1.reviewer, name: 'Payments reviewer' },
        }, { surface: 'ui', serverId });
        expect(created.ok).toBe(true);
        await preloadTranslations('fr');
        setPreferredLanguageFromSettings('fr');
        const before = harness.requests.length;
        const result = await executor.execute('roles.override.reset', { roleId }, { surface: 'ui', serverId });
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        const chrome = shownReviews.at(-1)?.chrome;
        if (chrome?.kind !== 'card') throw new Error('Expected the common review card');
        const { title, subtitle: summary } = chrome;
        for (const copy of [title, summary]) {
            expect(copy).toContain('Payments reviewer');
            expect(copy).toContain(t('roles.settings.sourceYours'));
        }
        expect(harness.requests.slice(before).filter(({ path, input }) => input && path.includes('/entity-rows/'))).toEqual([]);
    });

    it.each(['recoverable', 'persistent', 'claimed'] as const)('reconciles a failed approval claim through the real UI decision owner (%s)', async failure => {
        const serverId = await harness.addHome({ name: 'Approval recovery', serverUrl: 'https://claim-recovery.test', accountId: 'alice' });
        // A person's own UI Ask is a native confirmation, not an Artifact. The deferred
        // review that this claim reconciles is opened through the explicit request owner.
        const proposed = await createDefaultActionExecutor().execute('approval.request.create', {
            actionId: 'roles.create', actionArgs: { roleId: 'recovered-role', role: BUILT_IN_ROLES_V1.builder },
            summary: 'Create a role', createdBy: { surface: 'system' },
        }, { surface: 'ui', serverId });
        expect(proposed).toMatchObject({ ok: true, result: { artifactId: expect.any(String) } });
        const store = harness.artifacts(serverId);
        const artifact = store.list()[0];
        if (!artifact) throw new Error('Expected the deferred approval');
        const request = ApprovalRequestSchema.parse(JSON.parse(store.readPlainBody(artifact.id) ?? 'null'));
        const path = `/v1/artifacts/${artifact.id}`;
        let failedClaims = 0;
        let claimUnavailable = true;
        harness.answer(serverId, `GET ${path}`, { select: async (_input, incoming) => {
            // Recover only after the failed write's real HTTP retry owner has
            // finished and the approval owner reads its durable claim receipt.
            if (failedClaims > 0 && failure === 'recoverable') claimUnavailable = false;
            const response = await store.handle(path, incoming.init);
            if (!response) throw new Error('Expected Artifact read boundary');
            return { status: response.status, body: await response.json() };
        } });
        harness.answer(serverId, `POST ${path}`, { select: async (input, incoming) => {
            const encoded = input && typeof input === 'object' && 'body' in input && typeof input.body === 'string'
                ? decodePlainArtifactStoredContent(input.body) : null;
            const body = encoded && typeof encoded === 'object' && 'body' in encoded && typeof encoded.body === 'string'
                ? encoded.body : null;
            const proposal = body ? ApprovalRequestSchema.safeParse(JSON.parse(body)) : null;
            if (proposal?.success && proposal.data.status === 'executing' && claimUnavailable) {
                failedClaims += 1;
                // Genuine Home HTTP boundary: one case commits the claim once and loses
                // its acknowledgement across the claim retries; the others refuse before its CAS.
                if (failure === 'claimed' && failedClaims === 1) await store.handle(path, incoming.init);
                return { status: 500, body: { error: 'Failed to update artifact' } };
            }
            const response = await store.handle(path, incoming.init);
            if (!response) throw new Error('Expected Artifact update boundary');
            return { status: response.status, body: await response.json() };
        } });
        const { useApprovalDecisionHandler } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
        const hook = await renderHook(() => useApprovalDecisionHandler({ id: artifact.id, header: null }, request, '', serverId));
        expect(store.read('recovered-role')).toBeNull();
        if (failure === 'recoverable') {
            // 0edec5eadf0 preserves consent until execution is claimed. Once
            // storage recovers, the explicit approval can claim and execute it.
            await expect(hook.getCurrent()('approve')).resolves.toBeDefined();
            expect(JSON.parse(store.readPlainBody(artifact.id) ?? 'null')).toMatchObject({ status: 'executed',
                execution: { ok: true } });
            expect(store.read('recovered-role')).not.toBeNull();
        } else if (failure === 'persistent') {
            await expect(hook.getCurrent()('approve')).rejects.toMatchObject({ code: 'approval_context_unavailable' });
            const retained = JSON.parse(store.readPlainBody(artifact.id) ?? 'null');
            expect(retained).toMatchObject({ status: 'approved', decision: { kind: 'approve' } });
            expect(retained.execution).toBeUndefined();
            await expect(hook.getCurrent()('approve')).rejects.toMatchObject({ code: 'approval_context_unavailable' });
            expect(store.read('recovered-role')).toBeNull();
        } else {
            await expect(hook.getCurrent()('approve')).rejects.toMatchObject({
                code: 'approval_execution_outcome_unknown',
            });
            expect(JSON.parse(store.readPlainBody(artifact.id) ?? 'null')).toMatchObject({ status: 'outcome_unknown',
                execution: { ok: false, errorCode: 'approval_execution_outcome_unknown' } });
            // 2d29685e1f4 leaves effect evidence unknown after a lost claim ACK.
            expect(JSON.parse(store.readPlainBody(artifact.id) ?? 'null').execution.effectAttempted).toBeUndefined();
            expect(store.read('recovered-role')).toBeNull();
        }
        expect(failedClaims).toBeGreaterThan(0);
    });

    // Only an irreversible declaration confirms a person's own UI press by default; a
    // reversible one confirms when the person saved Ask (docs/actions.md native confirmation).
    it.each([
        ['localServices.actions.stopManaged', 'stop_managed', 'ask'],
        ['localServices.actions.terminateDetected', 'terminate_detected', 'default'],
        ['projects.trust.revoke', null, 'ask'],
    ] as const)('declining the UI confirmation prevents %s effects', async (actionId, action, confirmation) => {
        const serverId = await harness.addHome({ name: 'Danger Home', serverUrl: 'https://danger-origin.test', accountId: 'alice' });
        if (confirmation === 'ask') await harness.requireUiApproval(serverId, actionId);
        const input = getActionSpec(actionId).inputSchema.parse(action === null
            ? { project: { serverId, projectId: 'project-a' }, expectedRevision: 1, expectedEffectDigest: 'effect-a' }
            : { requestId: 'service-request', action, target: action === 'terminate_detected'
                ? { kind: 'inventory_entry', inventoryEntryId: 'detected-a', machineId: 'machine-a' }
                : { kind: 'managed_service', managedServiceId: 'managed-a', machineId: 'machine-a' } });
        const result = await createDefaultActionExecutor().execute(actionId, input, { surface: 'ui', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(shownReviews).toHaveLength(1);
        expect(harness.requests.filter(({ path }) => path.includes('/project-trust/') || path.includes('/actions/execute'))).toEqual([]);
        expect(harness.artifacts(serverId).list()).toEqual([]);
    });

    it.each([
        ['daemon.filesystem.delete', { rootPath: '/tmp', path: 'fin-qa-variants-a-1112-repo', recursive: true }],
        ['daemon.filesystem.writeFile', { rootPath: '/tmp', path: 'reviewed.txt', content: 'bmV3' }],
        ['daemon.filesystem.rename', { rootPath: '/tmp', from: 'before.txt', to: 'after.txt', overwrite: false }],
    ] as const)('carries the one in-flow confirmation through the real receiving executor for %s', async (actionId, input) => {
        const machineId = 'filesystem-machine';
        const serverIdentityId = 'srv_filesystem_review';
        const serverId = await harness.addHome({ name: 'Filesystem Home', serverUrl: 'https://filesystem-review.test',
            accountId: 'alice', serverIdentityId, currentAccount: true });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { createUiActionAutomationPortV1 } = await import('./actionAutomations');
        const account = await captureLazyActionAccountContext(serverId);
        onTestFinished(account.dispose);

        let effects = 0;
        // The Home harness serves the automation index over the existing HTTP boundary.
        const receiver = createActionExecutor({
            actionAutomations: createUiActionAutomationPortV1(account),
            filesystemActionExecute: async () => {
                effects++;
                return actionId === 'daemon.filesystem.writeFile' ? { success: true, hash: 'a'.repeat(64) } : { success: true };
            },
        });
        await answerExternalActionAccountForHome(harness, serverId, { machineId, actionId, tokenEpoch: 0,
            requesterInvocation: 'optional',
            failure: result => {
                const failure = ActionExecuteFailureSchema.safeParse(result);
                return failure.success ? failure.data : null;
            },
            execute: async (received, context) => {
                const invocation = context.invocation;
                expect(invocation?.presentUserConfirmation).toBeDefined();
                const receiverContext = {
                    surface: invocation?.surface, authority: invocation?.authority, actionCaller: invocation?.caller,
                    presentUserConfirmation: invocation?.presentUserConfirmation,
                    serverId, serverIdentityId, runtimeAccountId: 'alice', actionRequestId: context.requestId,
                    externalActionTarget: context.target, externalActionExecutionAuthorization: context.authorization,
                    interactivePresentation: 'unavailable' as const,
                };
                if (actionId === 'daemon.filesystem.delete' && invocation?.presentUserConfirmation) {
                    expect(await receiver.execute(actionId, received, { ...receiverContext, presentUserConfirmation: undefined }))
                        .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
                    const changed = { ...input, path: 'unreviewed.txt' };
                    expect(await receiver.execute(actionId, changed, { ...receiverContext,
                        presentUserConfirmation: { ...invocation.presentUserConfirmation } }))
                        .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
                    expect(effects).toBe(0);
                }
                const result = await receiver.execute(actionId, received, receiverContext);
                return result.ok ? result.result : result;
            } });
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui', serverId, externalActionTarget: { kind: 'machine', machineId } } as const;
        if (actionId === 'daemon.filesystem.delete') {
            confirmationAnswer = false;
            expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
            expect(effects).toBe(0);
            shownReviews.length = 0;
        }
        confirmationAnswer = true;
        // Write/rename have a designed direct confirmation; Delete presents it at admission.
        const result = actionId === 'daemon.filesystem.delete' ? await executor.execute(actionId, input, context)
            : await executor.executeConfirmed(actionId, input, context);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { success: true } });
        expect(effects).toBe(1);
        expect(shownReviews).toHaveLength(actionId === 'daemon.filesystem.delete' ? 1 : 0);
    });

    it('confirms a native Restart with the Machine\'s own review, then restarts exactly that Service once', async () => {
        const actionId = 'localServices.actions.restartManaged' as const;
        const machineId = 'restart-machine';
        const serverId = await harness.addHome({ name: 'Restart Home', serverUrl: 'https://restart-review.test', accountId: 'alice',
            serverIdentityId: 'srv_restart_review', currentAccount: true });
        const input = getActionSpec(actionId).inputSchema.parse({ requestId: 'restart-native-review', action: 'restart_managed',
            target: { kind: 'managed_service', managedServiceId: 'running-service', machineId } });
        const received: boolean[] = [];
        // The Machine's own review: the exact child it would start (as its approval builder produces it).
        const workspace = { serverId: 'srv_restart_review', machineId, workspaceId: 'checkout', rootPath: '/repo' };
        const start = { machineId, workspace, targetId: 'web', declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'web' } },
            expectedEffectDigest: 'a'.repeat(64) };
        const restartPreview = { hostReviewedChildren: { children: [{ action: 'localServices.launcher.start', role: 'service.restart.start', input: start }] },
            hostReviewedContent: { serviceStartReview: LocalServiceStartApprovalReviewV1Schema.parse({ request: start, target: workspace,
                reviewedEffectDigest: start.expectedEffectDigest, setup: { required: false, project: { serverId: 'srv_restart_review', projectId: 'project' },
                    reviewedEffectDigest: 'b'.repeat(64), reviewedEffect: {} },
                reviewedEffect: { command: { source: { kind: 'command', command: 'serve web' } } } }) } };
        // The Machine cannot present the Restart review; it carries it back until the person's press confirms it.
        await answerExternalActionAccountForHome(harness, serverId, { machineId, actionId, tokenEpoch: 0, requesterInvocation: 'optional',
            failure: carriedMachineReview,
            execute: (received_, context) => {
                const confirmed = context.invocation?.presentUserConfirmation?.reviewDigest === REVIEW_DIGEST;
                received.push(confirmed);
                return confirmed ? { v: 1, requestId: input.requestId, action: 'restart_managed', status: 'succeeded', auditEvents: [] }
                    : { [refusedWithReview]: { input: received_, preview: restartPreview } };
            } });
        vi.mocked(Modal.confirm).mockReset();
        // The native confirmation presents the Machine's own review; the person confirms it once.
        const shown: Array<Readonly<{ title: unknown; preview: unknown; actionArgs: unknown }>> = [];
        vi.mocked(Modal.show).mockImplementationOnce(config => {
            const props = config.props as { preview: unknown; actionArgs: unknown; onAnswer(confirmed: boolean): void };
            shown.push({ title: config.chrome?.kind === 'card' ? config.chrome.title : null, preview: props.preview, actionArgs: props.actionArgs });
            queueMicrotask(() => props.onAnswer(true));
            return 'restart-review';
        });
        const result = await createDefaultActionExecutor().execute(actionId, input, { surface: 'ui', serverId });
        expect(result, JSON.stringify({ result, received })).toMatchObject({ ok: true, result: { status: 'succeeded' } });
        expect(received).toEqual([false, true]);
        // The Machine-discovered consequence (the command it will start) is what the person confirms: its review,
        // not a sentence restating the input. The review presenter renders `serve web` (ActionConfirmationReview.test).
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(shown).toEqual([{ title: expect.any(String), preview: restartPreview, actionArgs: input }]);
        expect(harness.artifacts(serverId).list()).toEqual([]);
    });

    it.each(['confirms', 'cancels'] as const)('asks with the Machine\'s own review and installs the exact updates plan once the person confirms, after the Machine refuses their own Install (%s)', async choice => {
        const actionId = 'machines.setup.updates.apply' as const;
        const machineId = 'updates-machine';
        const homeId = `srv_updates_review_${choice}`;
        const serverId = await harness.addHome({ name: 'Updates Home', serverUrl: `https://updates-review-${choice}.test`, accountId: 'alice',
            serverIdentityId: homeId, currentAccount: true });
        const input = getActionSpec(actionId).inputSchema.parse({ homeId, machineId, scope: 'all',
            plan: { v: 1, basis: { kind: 'updates', machineId, scope: 'all' }, steps: [], nativeFacts: [], planDigest: 'b'.repeat(64) } });
        const dispatched: Array<Readonly<{ input: unknown; confirmed: boolean }>> = [];
        // "Ask each time": the Machine cannot present the review, so it carries it back before any password prompt.
        await answerExternalActionAccountForHome(harness, serverId, { machineId, actionId, tokenEpoch: 0, requesterInvocation: 'optional',
            failure: carriedMachineReview,
            execute: (received, context) => {
                const confirmed = context.invocation?.presentUserConfirmation?.reviewDigest === REVIEW_DIGEST;
                dispatched.push({ input: received, confirmed });
                return confirmed ? { operationId: 'updates-operation', terminalId: 'updates-terminal' }
                    : refuseWithReview(received, 'Install 53 updates as the administrator you name');
            } });
        vi.mocked(Modal.confirm).mockReset();
        vi.mocked(Modal.confirm).mockResolvedValue(false);
        const shown: unknown[] = [];
        vi.mocked(Modal.show).mockImplementationOnce(config => {
            const props = config.props as { preview: unknown; onAnswer(confirmed: boolean): void };
            shown.push(props.preview);
            queueMicrotask(() => props.onAnswer(choice === 'confirms'));
            return 'updates-review';
        });
        const result = await createDefaultActionExecutor().execute(actionId, input, { surface: 'ui', serverId });
        if (choice === 'confirms') {
            expect(result, JSON.stringify({ result, dispatched })).toMatchObject({ ok: true, result: { operationId: 'updates-operation' } });
            expect(dispatched).toEqual([{ input, confirmed: false }, { input, confirmed: true }]);
        } else {
            expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
            expect(dispatched).toEqual([{ input, confirmed: false }]);
        }
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(shown).toEqual([{ summary: 'Install 53 updates as the administrator you name' }]);
        vi.mocked(Modal.show).mockReset();
        expect(harness.artifacts(serverId).list()).toEqual([]);
    });

    it('lets the Install updates step host the Machine\'s carried review, so no dialog follows its own press', async () => {
        const actionId = 'machines.setup.updates.apply' as const;
        const machineId = 'updates-step-machine';
        const homeId = 'srv_updates_step';
        const serverId = await harness.addHome({ name: 'Updates Home', serverUrl: 'https://updates-step.test', accountId: 'alice',
            serverIdentityId: homeId, currentAccount: true });
        const input = getActionSpec(actionId).inputSchema.parse({ homeId, machineId, scope: 'all',
            plan: { v: 1, basis: { kind: 'updates', machineId, scope: 'all' }, steps: [], nativeFacts: [], planDigest: 'c'.repeat(64) } });
        const dispatched: boolean[] = [];
        await answerExternalActionAccountForHome(harness, serverId, { machineId, actionId, tokenEpoch: 0, requesterInvocation: 'optional',
            failure: carriedMachineReview,
            execute: (received, context) => {
                const confirmed = context.invocation?.presentUserConfirmation?.reviewDigest === REVIEW_DIGEST;
                dispatched.push(confirmed);
                return confirmed ? { operationId: 'updates-operation', terminalId: 'updates-terminal' }
                    : refuseWithReview(received, 'Install 53 updates as the administrator you name');
            } });
        vi.mocked(Modal.confirm).mockReset();
        vi.mocked(Modal.show).mockClear();
        const shownInStep: unknown[] = [];
        const result = await createDefaultActionExecutor({ presentUserActionConfirmation: async ({ preview }) => {
            shownInStep.push(preview);
            return true;
        } }).execute(actionId, input, { surface: 'ui', serverId });
        expect(result).toMatchObject({ ok: true, result: { operationId: 'updates-operation' } });
        expect(dispatched).toEqual([false, true]);
        expect(shownInStep).toEqual([{ summary: 'Install 53 updates as the administrator you name' }]);
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(Modal.show).not.toHaveBeenCalled();
    });

    it('keeps the Machine\'s refusal when its review digest arrives without the review it binds', async () => {
        const actionId = 'machines.setup.updates.apply' as const;
        const machineId = 'updates-blind-machine';
        const homeId = 'srv_updates_blind';
        const serverId = await harness.addHome({ name: 'Updates Home', serverUrl: 'https://updates-blind.test', accountId: 'alice',
            serverIdentityId: homeId, currentAccount: true });
        const input = getActionSpec(actionId).inputSchema.parse({ homeId, machineId, scope: 'all',
            plan: { v: 1, basis: { kind: 'updates', machineId, scope: 'all' }, steps: [], nativeFacts: [], planDigest: 'd'.repeat(64) } });
        const dispatched: unknown[] = [];
        await answerExternalActionAccountForHome(harness, serverId, { machineId, actionId, tokenEpoch: 0, requesterInvocation: 'optional',
            failure: () => ({ errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required',
                details: { reviewDigest: REVIEW_DIGEST } }),
            execute: received => { dispatched.push(received); return {}; } });
        vi.mocked(Modal.confirm).mockReset();
        vi.mocked(Modal.show).mockClear();
        const result = await createDefaultActionExecutor().execute(actionId, input, { surface: 'ui', serverId });
        // A confirmation of consequences the person never saw would be blind approval: nothing is asked or re-run.
        expect(result).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
        expect(dispatched).toHaveLength(1);
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(Modal.show).not.toHaveBeenCalled();
    });

    it('executes the real Project trust mutation once after accepting its Ask confirmation', async () => {
        const actionId = 'projects.trust.revoke' as const;
        const serverId = await harness.addHome({ name: 'Trust Home', serverUrl: 'https://trust-origin.test', accountId: 'alice' });
        await harness.requireUiApproval(serverId, actionId);
        const project = { serverId, projectId: 'project-a' };
        const input = getActionSpec(actionId).inputSchema.parse({ project, expectedRevision: 1, expectedEffectDigest: 'effect-a' });
        harness.answer(serverId, `${PROJECT_TRUST_ROUTE_V1}/read`, { body: ProjectTrustReadResponseV1Schema.parse({
            status: 'present', revision: 1,
            content: { t: 'plain', v: { project, reviewedEffectDigest: 'effect-a', approvedAtMs: 1 } },
        }) });
        harness.answer(serverId, `${PROJECT_TRUST_ROUTE_V1}/mutate`, { body: { status: 'updated', revision: 2, cursor: 1 } });
        confirmationAnswer = true;
        const result = await createDefaultActionExecutor().execute(actionId, input, { surface: 'ui', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: true, result: { project, status: 'removed' } });
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(shownReviews).toHaveLength(1);
        expect(harness.requestsFor(`${PROJECT_TRUST_ROUTE_V1}/mutate`).map(({ input: mutation }) => ProjectTrustMutationRequestV1Schema.parse(mutation)))
            .toEqual([{ project, expectedRevision: 1, content: null }]);
        expect(harness.artifacts(serverId).list()).toEqual([]);
    });

    it('returns cancellation without effects when its invocation aborts during UI confirmation', async () => {
        const serverId = await harness.addHome({ name: 'Canceled Home', serverUrl: 'https://canceled-origin.test', accountId: 'alice' });
        await harness.requireUiApproval(serverId, 'projects.trust.revoke');
        const controller = new AbortController();
        confirmationAnswer = true;
        beforeConfirmationAnswer = () => controller.abort();
        await expect(createDefaultActionExecutor().execute('projects.trust.revoke', {
            project: { serverId, projectId: 'project-a' }, expectedRevision: 1, expectedEffectDigest: 'effect-a',
        }, { surface: 'ui', serverId, signal: controller.signal })).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(shownReviews).toHaveLength(1);
        expect(harness.requests.filter(({ path }) => path.includes('/project-trust/'))).toEqual([]);
        expect(harness.artifacts(serverId).list()).toEqual([]);
    });

    it.each([
        { actionId: 'roles.create', credential: 'account' },
        { actionId: 'artifact.access.grants.set', credential: 'account' },
        { actionId: 'roles.create', credential: 'terminal' },
        { actionId: 'artifact.access.grants.set', credential: 'terminal' },
    ] as const)(
        'admits $actionId with $credential credentials without caller-authored provenance', async ({ actionId, credential }) => {
            const serverId = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://ui-origin.test', accountId: 'alice' });
            let raw: Record<string, unknown> = {};
            let version = 0;
            // Role creation also migrates Account settings. Persist the real
            // HTTP CAS winner instead of answering a write with a read response.
            const settingsAnswer = { select: (input: unknown) => {
                if (input === null || input === undefined) return { body: { content: { t: 'plain', v: raw }, version } };
                const request = AccountSettingsV2UpdateRequestSchema.parse(input);
                if (request.expectedVersion !== version) return { body: { success: false, error: 'version-mismatch', currentVersion: version,
                    currentContent: { t: 'plain', v: raw } } };
                if (request.content?.t !== 'plain') throw new Error('Expected Plain Account settings');
                raw = request.content.v;
                return { body: { success: true, version: ++version } };
            } };
            harness.answer(serverId, '/v2/account/settings', settingsAnswer);
            const executor = createDefaultActionExecutor();
            if (actionId === 'artifact.access.grants.set') {
                const seeded = await executor.execute('roles.create', { roleId: 'shared-role', role: BUILT_IN_ROLES_V1.builder }, { serverId });
                expect(seeded, JSON.stringify(seeded))
                    .toMatchObject({ ok: true, result: { roleId: 'shared-role' } });
                const projection = { artifactId: 'shared-role', ownerAccountId: 'alice', access: 'owner', grants: [] };
                harness.answer(serverId, 'GET /v1/artifacts/shared-role/access/grants', { body: projection });
                harness.answer(serverId, 'PUT /v1/artifacts/shared-role/access/grants', { body: {
                    ...projection, changed: true, grants: [{ principal: { kind: 'account', accountId: 'bob' }, accessLevel: 'view',
                        createdByAccountId: 'alice', createdAt: 1, display: { name: 'Bob' } }],
                } });
            }
            if (credential === 'terminal') {
                // A structural bearer at the credential-store boundary; the real
                // provenance decoder and authority owner remain under test.
                await harness.switchAccount(serverId, 'alice', { token: `e30.${btoa(JSON.stringify({ sub: 'alice', session: 'terminal-test', provenance: {
                    v: 2, kind: 'terminal', authority: 'account_automation',
                    evidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
                } }))}.signature` });
            }
            await harness.requireUiApproval(serverId, actionId);
            raw = { ...raw, actionsSettingsV1: { v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } } };
            version += 1;
            harness.answer(serverId, '/v2/account/settings', settingsAnswer);
            const input = actionId === 'roles.create'
                ? { roleId: 'new-role', role: BUILT_IN_ROLES_V1.builder }
                : { artifactId: 'shared-role', principal: { kind: 'account', accountId: 'bob' }, accessLevel: 'view' };
            // Exactly the UI caller contract: no authority, Account or request id.
            if (credential === 'terminal') {
                const controller = new AbortController();
                // Automation keeps the policy-owned blocking waiter. Observe durable
                // custody before cancelling this test's invocation; do not waive policy.
                const pending = executor.execute(actionId, input, { surface: 'ui', serverId, signal: controller.signal });
                try {
                    const created = await waitForHomeGovernance(() => {
                        const approval = harness.artifacts(serverId).list().find((row) => {
                            const body = harness.artifacts(serverId).readPlainBody(row.id);
                            return body !== null && ApprovalRequestSchema.safeParse(JSON.parse(body)).success;
                        });
                        expect(approval).toBeDefined();
                        return approval!;
                    });
                    const request = ApprovalRequestSchema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(created.id) ?? 'null'));
                    expect(request).toMatchObject({ v: 2, status: 'open', actionId, executionOriginV1: {
                        authority: 'account_automation', surface: 'ui', serverId, accountId: 'alice', caller: { kind: 'host' },
                    } });
                    if (request.v !== 2) throw new Error('Expected durable approval provenance');
                    expect(request.executionOriginV1.requestId).not.toBe('');
                    // Nothing ran before the decision. The authenticated person's UI decision is
                    // admitted (no terminal present-user floor) and runs the operation exactly once.
                    expect(harness.artifacts(serverId).readPlainBody('new-role')).toBeNull();
                    expect(harness.requests.some(({ path }) => path.endsWith('/access/grants'))).toBe(false);
                    const { useApprovalDecisionHandler } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
                    const hook = await renderHook(() => useApprovalDecisionHandler({ id: created.id, header: null }, request, '', serverId));
                    await hook.getCurrent()('approve');
                    await waitForHomeGovernance(() => expect(JSON.parse(harness.artifacts(serverId).readPlainBody(created.id) ?? 'null'))
                        .toMatchObject({ status: 'executed' }));
                    if (actionId === 'roles.create') {
                        expect(JSON.parse(harness.artifacts(serverId).readPlainBody('new-role') ?? 'null')).toMatchObject({ name: BUILT_IN_ROLES_V1.builder.name });
                    } else {
                        expect(harness.requestsFor('/v1/artifacts/shared-role/access/grants').filter(({ input }) => input !== null)).toHaveLength(1);
                    }
                } finally {
                    controller.abort();
                    await pending;
                }
                return;
            }
            // The person's own press answers the saved Ask in place; declining it has no effect.
            const declined = await executor.execute(actionId, input, { surface: 'ui', serverId });
            expect(declined, JSON.stringify(declined)).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
            expect(harness.artifacts(serverId).list().filter(({ id }) => id !== 'shared-role')).toEqual([]);
            const result = await executor.execute('approval.request.create', { actionId, actionArgs: input, summary: 'Review',
                createdBy: { surface: 'system' } }, { surface: 'ui', serverId });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { artifactId: expect.any(String) } });
            if (!result.ok) throw new Error(result.error);
            const created = result.result as { artifactId: string };
            const body = harness.artifacts(serverId).readPlainBody(created.artifactId);
            if (body === null) throw new Error('Approval Artifact was not persisted');
            const request = ApprovalRequestSchema.parse(JSON.parse(body));
            expect(request).toMatchObject({ v: 2, actionId, status: 'open', executionOriginV1: {
                authority: 'present_user',
                surface: 'ui', serverId, accountId: 'alice', caller: { kind: 'host' },
            } });
            if (request.v !== 2) throw new Error('Expected durable approval provenance');
            expect(request.executionOriginV1.requestId).not.toBe('');
            expect(harness.requests.some(({ path }) => path.endsWith('/access/grants'))).toBe(false);
            expect(harness.artifacts(serverId).readPlainBody('new-role')).toBeNull();
            const decision = await executor.execute('approval.request.decide', { artifactId: created.artifactId, decision: 'approve' }, { surface: 'ui', serverId });
            expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed' } });
            if (actionId === 'roles.create') {
                expect(JSON.parse(harness.artifacts(serverId).readPlainBody('new-role') ?? 'null')).toMatchObject({ name: BUILT_IN_ROLES_V1.builder.name });
            } else {
                expect(harness.requestsFor('/v1/artifacts/shared-role/access/grants').filter(({ input }) => input !== null).map(({ input }) => input))
                    .toEqual([{ artifactId: 'shared-role', principal: { kind: 'account', accountId: 'bob' }, accessLevel: 'view' }]);
            }
        },
    );

    it('preserves an existing request identity through prepared UI approval admission', async () => {
        const serverId = await harness.addHome({ name: 'Prepared Home', serverUrl: 'https://prepared-origin.test', accountId: 'alice' });
        await harness.requireUiApproval(serverId, 'roles.create');
        const executor = createDefaultActionExecutor();
        // Preparation retains admission; the mounted native host asks only when the person runs it.
        const role = await executor.prepare('roles.create', { roleId: 'prepared-role', role: BUILT_IN_ROLES_V1.builder },
            { serverId, actionRequestId: 'stable-human-request' });
        expect(role.kind).toBe('ready');
        expect(shownReviews).toHaveLength(0);
        expect(harness.artifacts(serverId).list()).toEqual([]);
        if (role.kind !== 'ready') throw new Error(JSON.stringify(role));
        expect(await role.invocation.run()).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(shownReviews).toHaveLength(1);
        expect(harness.artifacts(serverId).list()).toEqual([]);
        const prepared = await executor.prepare('approval.request.create', { actionId: 'roles.create',
            actionArgs: { roleId: 'prepared-role', role: BUILT_IN_ROLES_V1.builder }, summary: 'Create a role',
            createdBy: { surface: 'system' } }, { serverId, actionRequestId: 'stable-human-request' });
        if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
        expect(await prepared.invocation.run()).toMatchObject({ ok: true, result: { artifactId: expect.any(String) } });
        const request = ApprovalRequestSchema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(harness.artifacts(serverId).list()[0]!.id) ?? 'null'));
        expect(request).toMatchObject({ v: 2, executionOriginV1: { authority: 'present_user', requestId: 'stable-human-request', accountId: 'alice' } });
    });

    it('refuses an unscoped UI approval when no active Account runtime is available', async () => {
        const serverId = await harness.addHome({ name: 'Unavailable Home', serverUrl: 'https://unavailable-origin.test', accountId: 'alice' });
        await harness.requireUiApproval(serverId, 'artifact.access.grants.set');
        const result = await createDefaultActionExecutor().execute('artifact.access.grants.set', {
            artifactId: 'shared-role', principal: { kind: 'account', accountId: 'bob' }, accessLevel: 'view',
        }, { surface: 'ui' });
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
        expect(harness.artifacts(serverId).list()).toEqual([]);
    });

    it('does not promote an Agent caller that claims present-user authority', async () => {
        const serverId = await harness.addHome({ name: 'Agent Home', serverUrl: 'https://agent-origin.test', accountId: 'alice' });
        const result = await createDefaultActionExecutor().execute('artifact.access.grants.set', {
            artifactId: 'shared-role', principal: { kind: 'account', accountId: 'bob' }, accessLevel: 'view',
        }, { surface: 'agent', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
        expect(harness.artifacts(serverId).list()).toEqual([]);
    });
});
