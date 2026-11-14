import { describe, expect, it } from "vitest";

import { mapPendingMessageRow } from "./mapPendingMessageRow";
import { PendingDeliveryRecoveryV1Schema } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import { SessionMessageReplyProgressV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';

describe("mapPendingMessageRow", () => {
    it('drops a stored refusal detail that is not the typed cause instead of failing the Pending list', () => {
        const now = new Date('2026-11-14T00:00:00Z');
        const row = { localId: 'refused', messageRole: 'user', content: { t: 'encrypted' as const, c: 'opaque' },
            status: 'discarded' as const, position: 0, createdAt: now, updatedAt: now, discardedAt: now,
            discardedReason: 'resume_failed', authorAccountId: null, replyProgress: null,
            deliveryFailure: { code: 'resume_failed', errorDetail: { kind: 'launch_error', code: 'spawn_failed',
                message: 'Runner exited in /home/alice/private-repo', childExit: { code: 1, signal: null, stderrHead: 'boom' } } } };
        expect(mapPendingMessageRow(row)).toHaveProperty('failure', { code: 'resume_failed' });
        const typed = { code: 'resume_failed', errorDetail: { kind: 'spawn_failure', reason: 'process_limit', errno: 'EAGAIN' } };
        expect(mapPendingMessageRow({ ...row, deliveryFailure: typed })).toHaveProperty('failure', typed);
    });

    it('projects host Follow identity only from admitted custody, never from authored content', () => {
        const follow = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn',
            original: { sourceSessionId: 'worker', sourceTurn: { id: 'turn-1', status: 'completed' } },
            event: { kind: 'finished' } });
        const now = new Date('2026-10-25T00:00:00Z');
        const row = { localId: 'follow-input', messageRole: 'user',
            content: { t: 'plain' as const, v: { role: 'user', meta: {
                happierInputRequestV1: { v: 1, producer: 'sessionAction', caller: { kind: 'host' },
                    permission: {}, followDeliveryV1: follow },
                happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
                hostFollowInput: follow,
            } } }, status: 'queued' as const, position: 1,
            createdAt: now, updatedAt: now, discardedAt: null, discardedReason: null,
            authorAccountId: null, replyProgress: null };
        expect(mapPendingMessageRow(row)).not.toHaveProperty('hostFollowInput');
        for (const inputAdmissionReceipt of [{ v: 1, issuer: 'authenticatedMachine', followDeliveryV1: follow },
            { v: 99, issuer: 'authenticatedMachine', followDeliveryV1: follow }]) {
            expect(mapPendingMessageRow({ ...row, inputAdmissionReceipt })).not.toHaveProperty('hostFollowInput');
        }
        const admitted = mapPendingMessageRow({ ...row, inputAdmissionReceipt: {
            v: 1, issuer: 'authenticatedMachine', followDeliveryV1: follow,
            admittedTarget: { homeId: 'srv_home', accountId: 'owner', sessionId: 'receiver',
                machineId: 'machine', installationId: 'installation' },
        } });
        expect(admitted).toHaveProperty('hostFollowInput', follow);
        expect(admitted).not.toHaveProperty('inputAdmissionReceipt');
        // E2EE follows the same server custody without opening the encrypted input.
        expect(mapPendingMessageRow({ ...row, content: { t: 'encrypted', c: 'opaque' },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', followDeliveryV1: follow,
                admittedTarget: { homeId: 'srv_home', accountId: 'owner', sessionId: 'receiver',
                    machineId: 'machine', installationId: 'installation' } } }))
            .toHaveProperty('hostFollowInput', follow);
    });
    it.each([null, SessionMessageReplyProgressV1Schema.parse({ v: 1, mode: 'wait', disposition: 'observing' }), {}, undefined])("projects Send as new eligibility without exposing reply custody (%j)", replyProgress => {
        const now = new Date("2026-07-12T00:00:00.000Z");
        const row = {
            localId: "uncertain-input", messageRole: "user", content: { t: "plain" as const, v: "hello" },
            status: "queued" as const, deliveryState: "blocked", deliveryBlockedReason: "delivery_outcome_uncertain",
            position: 0, createdAt: now, updatedAt: now, discardedAt: null, discardedReason: null,
            authorAccountId: "account-1", replyProgress,
        };
        const mapped = mapPendingMessageRow(row);
        expect(mapped).toMatchObject({ recovery: { canSendAsNew: replyProgress === null } });
        expect(PendingDeliveryRecoveryV1Schema.parse(mapped.recovery)).toEqual({ canSendAsNew: replyProgress === null });
        expect(mapped).not.toHaveProperty('replyProgress');
    });

    it.each([
        { requestedAction: { v: 1, kind: "enqueue", retired: true }, expectedAction: { v: 1, kind: "enqueue" } },
        {
            requestedAction: { v: 1, kind: "reset_start", retired: true, reset: {
                source: { bindingKind: "account", retired: true, ref: { retired: true,
                    service: { pluginId: "happier.agent.codex", localId: "openai", retired: true }, accountId: "account" } },
                recordId: "paug_v1_abcdefgh", meterId: "weekly", retired: true,
                witness: { id: "accepted-history-entry", observedAtMs: 1000, retired: true },
            } },
            expectedAction: { v: 1, kind: "reset_start", reset: {
                source: { bindingKind: "account", ref: { service: { pluginId: "happier.agent.codex", localId: "openai" }, accountId: "account" } },
                recordId: "paug_v1_abcdefgh", meterId: "weekly",
                witness: { id: "accepted-history-entry", observedAtMs: 1000 },
            } },
        },
    ])("projects retained annotated actions as publicly queued without copying unknown fields", ({ requestedAction, expectedAction }) => {
        const now = new Date("2026-07-12T00:00:00.000Z");
        const mapped = mapPendingMessageRow({
            localId: "local-1",
            messageRole: "user",
            content: { t: "plain", v: "hello" },
            requestedAction,
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            position: 1,
            createdAt: now,
            updatedAt: now,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "account-1",
            replyProgress: null,
        });
        expect(mapped).toMatchObject({
            status: "queued",
            deliveryStatus: { status: "queued" },
        });
        expect(mapped.requestedAction).toEqual(expectedAction);
        expect(mapped.requestedActionMalformed).toBeUndefined();
    });

    it.each([
        { v: 1, kind: "future_action" },
        { v: 1, kind: "reset_start", reset: {
            source: { bindingKind: "account", ref: { service: { pluginId: " ", localId: "openai" }, accountId: "account" } },
            recordId: "paug_v1_abcdefgh", meterId: "weekly", witness: { id: "accepted-history-entry", observedAtMs: 1000 },
        } },
    ])("retains an explicit malformed action as a non-executable unsupported row", requestedAction => {
        const now = new Date("2026-07-12T00:00:00.000Z");
        const mapped = mapPendingMessageRow({
            localId: "malformed-action",
            messageRole: "user",
            content: { t: "plain", v: "hello" },
            requestedAction,
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            position: 2,
            createdAt: now,
            updatedAt: now,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "account-1",
            replyProgress: null,
        });

        expect(mapped).toMatchObject({
            localId: "malformed-action",
            requestedActionMalformed: true,
            deliveryStatus: { status: "blocked", reason: "unsupported_action" },
        });
        expect(mapped.requestedAction).toBeUndefined();
    });

    it("projects claimed rows as awaiting provider acceptance without adding persisted state", () => {
        const now = new Date("2026-07-12T00:00:00.000Z");
        expect(mapPendingMessageRow({
            localId: "delivering-local",
            messageRole: "user",
            content: { t: "plain", v: "hello" },
            requestedAction: { v: 1, kind: "enqueue" },
            status: "queued",
            deliveryState: "delivering",
            deliveryBlockedReason: null,
            position: 3,
            createdAt: now,
            updatedAt: now,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "account-1",
            replyProgress: null,
        })).toMatchObject({
            deliveryState: "delivering",
            deliveryStatus: { status: "delivering", detail: "awaiting_acceptance" },
        });
    });
});
