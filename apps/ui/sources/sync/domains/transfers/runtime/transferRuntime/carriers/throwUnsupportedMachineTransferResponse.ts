export function throwUnsupportedMachineTransferResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}
