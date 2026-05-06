import { describe, expect, it } from 'vitest';

import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol';

import {
    clearMachineRpcPeerMediationReceiptsForTest,
    getMachineRpcPeerMediationReceiptsSnapshot,
    recordMachineRpcPeerMediationReceipt,
} from './receiptLog';

describe('machine RPC peer mediation receipt log', () => {
    it('records deterministic receipt entries without mutating caller objects', () => {
        clearMachineRpcPeerMediationReceiptsForTest();
        const receipt = {
            receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded,
            method: 'daemon.memory.status',
            requestId: 'request_1',
        };

        recordMachineRpcPeerMediationReceipt(receipt);
        receipt.method = 'mutated';

        expect(getMachineRpcPeerMediationReceiptsSnapshot()).toEqual([{
            receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded,
            method: 'daemon.memory.status',
            requestId: 'request_1',
        }]);
    });
});
