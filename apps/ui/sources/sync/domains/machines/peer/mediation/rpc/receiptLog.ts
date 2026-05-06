const MAX_MACHINE_RPC_PEER_MEDIATION_RECEIPTS = 512;

const receipts: Array<Readonly<Record<string, unknown>>> = [];

export function recordMachineRpcPeerMediationReceipt(
    receipt: Readonly<Record<string, unknown>>,
): void {
    receipts.push({ ...receipt });
    if (receipts.length > MAX_MACHINE_RPC_PEER_MEDIATION_RECEIPTS) {
        receipts.splice(0, receipts.length - MAX_MACHINE_RPC_PEER_MEDIATION_RECEIPTS);
    }
}

export function getMachineRpcPeerMediationReceiptsSnapshot(): readonly Readonly<Record<string, unknown>>[] {
    return receipts.map((receipt) => ({ ...receipt }));
}

export function clearMachineRpcPeerMediationReceiptsForTest(): void {
    receipts.length = 0;
}
