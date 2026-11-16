import { describe, expect, it, vi } from "vitest";

import { selectRpcTarget } from "./rpcTargetSelection";
import type { Socket } from 'socket.io';
import { registerUiFocusSocketEvent } from '../registerUiFocusSocketEvent';

function createCandidate(id: string) {
    return {
        id,
        timeout: vi.fn(),
    };
}

describe("selectRpcTarget", () => {
    it('projects candidates only for discovery or ambiguity, never ordinary successful calls', () => {
        let labelReads = 0;
        const target = { ...createCandidate('app'), data: { get rpcDeviceLabel() { labelReads += 1; return 'My phone'; } } };
        const targets = [target];
        expect(selectRpcTarget({ targets, answeringClient: { requireSingle: true } })).not.toHaveProperty('clients');
        expect(labelReads).toBe(0);
        expect(selectRpcTarget({ targets, answeringClient: { requireSingle: true, includeCandidates: true } }))
            .toMatchObject({ clients: [{ id: 'app', deviceLabel: 'My phone' }] });
        expect(labelReads).toBeGreaterThan(0);
    });

    it('uses the latest pushed focus fact, but never overrides an exact client or breaks ties', () => {
        const clock = vi.spyOn(Date, 'now');
        const candidate = (id: string) => {
            let receive!: (input: unknown) => void;
            const socket = { ...createCandidate(id), connected: true,
                data: { clientType: 'user-scoped', clientPurpose: 'sync' } as Record<string, unknown>,
                on: (_event: string, listener: typeof receive) => { receive = listener; } };
            registerUiFocusSocketEvent(socket as unknown as Socket);
            return { socket, focus: (focused: boolean) => receive({ computer: true, focused }) };
        };
        try {
            const older = candidate('client-a');
            const latest = candidate('client-b');
            clock.mockReturnValue(10);
            older.focus(true);
            older.focus(false);
            clock.mockReturnValue(20);
            latest.focus(true);
            const targets = [latest.socket, older.socket];
            expect(selectRpcTarget({ targets, answeringClient: { requireSingle: true } }))
                .toMatchObject({ type: 'target', target: latest.socket });
            expect(selectRpcTarget({ targets, answeringClient: { requireSingle: true, clientId: older.socket.id } }))
                .toMatchObject({ type: 'target', target: older.socket });
            older.focus(true);
            expect(selectRpcTarget({ targets, answeringClient: { requireSingle: true } })).toMatchObject({ type: 'ambiguous' });
        } finally { clock.mockRestore(); }
    });
    it('selects only the exact answering client and never substitutes a disconnected selection', () => {
        const first = createCandidate('client-a');
        const selected = createCandidate('client-b');
        expect(selectRpcTarget({ targets: [first, selected], answeringClient: { clientId: selected.id } }))
            .toMatchObject({ type: 'target', target: selected });
        expect(selectRpcTarget({ targets: [first], answeringClient: { clientId: selected.id } }))
            .toEqual({ type: 'not-available' });
    });

    it('refuses ambiguous mutations while preserving unselected reads and sole eligible clients', () => {
        const first = createCandidate('client-a');
        const second = createCandidate('client-b');
        expect(selectRpcTarget({ targets: [first, second], answeringClient: { requireSingle: true } }))
            .toEqual({ type: 'ambiguous', clientIds: ['client-a', 'client-b'],
                clients: [{ id: 'client-a', deviceLabel: null }, { id: 'client-b', deviceLabel: null }] });
        expect(selectRpcTarget({ targets: [first, second] })).toMatchObject({ type: 'target', target: first });
        expect(selectRpcTarget({ targets: [first, second], excludedSocketId: first.id, answeringClient: { requireSingle: true } }))
            .toMatchObject({ type: 'target', target: second });
    });
    it("rejects a self-call when the caller is the only available target", () => {
        expect(selectRpcTarget({
            targets: [createCandidate("caller-socket")],
            excludedSocketId: "caller-socket",
        })).toEqual({
            type: "self-call",
        });
    });

    it("chooses a non-caller target when both the caller and another socket are present", () => {
        const caller = createCandidate("caller-socket");
        const target = createCandidate("target-socket");

        expect(selectRpcTarget({
            targets: [caller, target],
            excludedSocketId: "caller-socket",
        })).toEqual({
            type: "target",
            target,
            hadMultipleTargets: true,
        });
    });

    it("chooses deterministically when more than one non-caller target is present", () => {
        const targetB = createCandidate("target-b");
        const targetA = createCandidate("target-a");

        expect(selectRpcTarget({
            targets: [targetB, targetA],
        })).toEqual({
            type: "target",
            target: targetA,
            hadMultipleTargets: true,
        });
    });
});
