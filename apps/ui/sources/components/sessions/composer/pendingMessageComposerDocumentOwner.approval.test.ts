import { afterEach, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { ActionsSettingsV1Schema} from '@happier-dev/protocol/actions/actionSettings';
import { buildApprovalRequestArtifactHeaderV1} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { resetPendingQueueState } from '@/sync/engine/pending/pendingQueueV2.testHelpers';
import { storage } from '@/sync/domains/state/storage';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { createEphemeralComposerDocumentOwner } from './composerDocumentOwner';
import { withdrawPendingMessageToComposerWithActionApproval } from './pendingMessageComposerDocumentOwner';

installApprovalCommonModuleMocks();
beforeAll(loadSyncSingletonForTests);
afterEach(() => { resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); vi.restoreAllMocks(); });

describe('pending withdrawal persisted Ask continuation', () => {
    it.each(['removed', 'canceled'] as const)('retains the original document until actual approval settlement (%s)', async (settlement) => {
        const scope = { serverId: 'server-a', accountId: 'approval-owner' };
        await resetPendingQueueState(scope);
        expect(await setServerProfileIdentityForUrl('https://server-a', 'srv_composer_approval')).toMatchObject({ serverIdentityId: 'srv_composer_approval' });
        // The active Account's live Settings are the canonical policy owner;
        // an HTTP baseline alone does not replace that already-mounted record.
        storage.getState().applySettings({ ...storage.getState().settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.pending.withdraw': { approvalRequiredSurfaces: ['ui'] } } }),
        }, 1);
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests(scope.accountId) });
        let recordedRequest: ApprovalRequestV2 | null = null;
        let registered: ActionApprovalContinuation | null = null;
        const mutations: string[] = [];
        const requestPaths: string[] = [];
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            requestPaths.push(url.pathname);
            expect(url.origin).toBe('https://server-a');
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'session.pending.withdraw': { approvalRequiredSurfaces: ['ui'] } } },
            } }, version: 1 });
            const response = artifacts.handle(url.pathname, init);
            if (!response) throw new Error(`Unexpected pending withdrawal boundary: ${url.pathname}`);
            const served = await response;
            if (init?.method === 'POST' && url.pathname === '/v1/artifacts') {
                mutations.push(url.pathname);
                const created = artifacts.list()[0];
                if (!created) throw new Error('Missing persisted approval body');
                const request = StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(created.id)!));
                if (request.v !== 2) throw new Error('Expected current approval origin');
                recordedRequest = request;
            }
            return served;
        });
        const composer = createEphemeralComposerDocumentOwner({
            ref: { kind: 'session', sessionId: 'session-a' }, capabilities: { text: true, references: true, attachments: true, submit: true },
        });
        const original = { text: 'Original typed input', structuredInputMentions: [], composerAttachments: [] };
        const cancellation = new AbortController();
        let settled = false;
        const executor = createDefaultActionExecutor();
        let refusalCode: string | undefined;
        onTestFailed(() => console.error('Pending withdrawal admission boundary', { refusalCode, requestPaths, settled }));
        const result = withdrawPendingMessageToComposerWithActionApproval({
            composer, document: original, isCurrent: () => !cancellation.signal.aborted,
            actionExecutor: { execute: async (...args: Parameters<typeof executor.execute>) => {
                const outcome = await executor.execute(...args);
                if (!outcome.ok) refusalCode = outcome.errorCode;
                return outcome;
            } }, scope, signal: cancellation.signal,
            withdrawInput: { sessionId: 'session-a', localId: 'pending-a', serverId: scope.serverId },
            context: { serverId: scope.serverId, expectedAccountId: scope.accountId, surface: 'ui', defaultSessionId: 'session-a' },
            registerApproval: (continuation) => { registered = continuation; },
        }).then((value) => { settled = true; return value; });
        onTestFinished(async () => { cancellation.abort(); await result; });
        await vi.waitFor(() => expect(registered).not.toBeNull());
        expect(settled).toBe(false);
        expect(composer.read().document.text).toBe('');
        const getContinuation = (): ActionApprovalContinuation => { if (!registered) throw new Error('Missing registration'); return registered; };
        const getRecordedRequest = (): ApprovalRequestV2 => { if (!recordedRequest) throw new Error('Missing request'); return recordedRequest; };
        if (settlement === 'canceled') cancellation.abort();
        else {
            const executed: ApprovalRequestV2 = { ...getRecordedRequest(), status: 'executed', updatedAtMs: 2,
                decision: { kind: 'approve', decidedAtMs: 2 }, execution: { ok: true, executedAtMs: 2, result: { outcome: 'removed' } } };
            const artifact: DecryptedArtifact = { id: getContinuation().artifactId, title: null,
                header: buildApprovalRequestArtifactHeaderV1(executed), body: JSON.stringify(executed), isDecrypted: true,
                headerVersion: 1, bodyVersion: 2, seq: 1, createdAt: 1, updatedAt: 2 };
            await getContinuation().onExecuted(artifact);
        }
        await expect(result).resolves.toEqual(settlement === 'removed'
            ? { outcome: 'removed', status: 'restored' }
            : { outcome: 'delivery_unknown', status: 'not_removed' });
        expect(composer.read().document.text).toBe(settlement === 'removed' ? original.text : '');
        expect(mutations).toEqual(['/v1/artifacts']);
    });
});
