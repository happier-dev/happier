import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { startExplicitSessionStopRedisServer } from '@/testkit/explicitSessionStopRedisServer.testkit';

describe('explicit Session stop through a Redis cluster with an unrelated silent peer', () => {
    it.each([{ targetNode: 0, installed: false }, { targetNode: 1, installed: false }, { targetNode: 1, installed: true }] as const)(
        'stops the exact Session on node $targetNode (installed=$installed) without relaxing Session or installation authority', async ({ targetNode, installed }) => {
        const fixture = await startExplicitSessionStopRedisServer({ targetNode, installed });
        try {
            const { installationId, targetSocket, stop } = fixture;
            const call = (sessionId: string) => fixture.call({ method: `${fixture.machineId}:${RPC_METHODS.STOP_SESSION}`,
                params: { sessionId }, authorization: { kind: 'session.write', sessionId } });

            expect(await call(fixture.foreignSessionId)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
            expect(stop).not.toHaveBeenCalled();
            if (installationId) {
                targetSocket.data.verifiedMachineInstallationId = randomUUID();
                expect(await call(fixture.sessionId)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE });
                expect(stop).not.toHaveBeenCalled();
                targetSocket.data.verifiedMachineInstallationId = installationId;
            }
            expect(await call(fixture.sessionId)).toEqual({ ok: true, result: { status: 'stopped' } });
            expect(stop).toHaveBeenCalledOnce();
            expect(await fixture.readSessionActive()).toBe(false);
            if (targetNode === 1) expect(fixture.heldCount).toBeGreaterThan(0);
        } finally {
            await fixture.close();
        }
    });
});
