import { describe, expect, it } from 'vitest';

import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createMachineRpcPeerFallbackReceipt } from './fallback';

describe('machine RPC peer fallback receipt', () => {
    it('identifies the encrypted server relay used for an installed UI artifact byte read', () => {
        expect(createMachineRpcPeerFallbackReceipt({
            method: RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
            requestId: 'artifact-read-1',
            reasonCode: 'grant_missing',
            receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
        })).toEqual({
            receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
            method: RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
            requestId: 'artifact-read-1',
            reasonCode: 'grant_missing',
            routeKind: 'server_relay',
        });
    });
});
