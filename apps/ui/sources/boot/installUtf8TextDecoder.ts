/** Browsers and Node ship a native TextDecoder; only Hermes needs the bulk decoder (`.native.ts`). */
export function installUtf8TextDecoder(): void {}
