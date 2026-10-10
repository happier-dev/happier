// Unselected CLI-acquisition paths import these Node IO APIs. Keep their domain
// code real; fail immediately if saved-editor startup attempts any local IO.
function unavailable(): never {
    throw new Error('Saved-workflow browser startup attempted Node-only IO');
}

export const createRequire = unavailable;
export const request = unavailable;
export const createServer = unavailable;
export const createConnection = unavailable;
export const pipeline = unavailable;
export const createGunzip = unavailable;
export const createInflateRaw = unavailable;
export const setTimeout = unavailable;
export const getHeapStatistics = unavailable;
export const extract = unavailable;
export const x = unavailable;
export const create = unavailable;
export const c = unavailable;
export const open = unavailable;
export const fromBuffer = unavailable;

export class Readable {
    constructor() { unavailable(); }
    static from = unavailable;
    static fromWeb = unavailable;
}
export class Writable extends Readable {}
export class Transform extends Readable {}

export class AsyncLocalStorage {
    getStore = unavailable;
    run = unavailable;
    exit = unavailable;
    enterWith = unavailable;
    disable = unavailable;
}
