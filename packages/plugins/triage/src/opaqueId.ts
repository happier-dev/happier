/**
 * The one place Triage mints an opaque local identity.
 *
 * Three writers need one: a saved view, a configured action, and one logical
 * new-Session request. None of them is a secret — each is a distinctness
 * requirement, and each is minted at the writer so two devices can never claim
 * the same id — so they share one mechanism rather than three spellings of it.
 *
 * It reads WebCrypto off `globalThis` rather than importing `node:crypto`,
 * because the writers above now run in both realms: the daemon, and a mounted
 * surface writing the reader's Account state directly with no daemon reachable.
 * A module that imported `node:crypto` could not be bundled into that surface
 * at all, which is what previously forced a second minting site into the UI.
 */
export function mintTriageOpaqueIdV1(): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
    // React Native has no WebCrypto, so the shape is produced here.
    //
    // The shape is load-bearing, not cosmetic: `settings/savedViews.ts` reads a
    // stored view back through a UUID pattern, and a view minted in any other
    // spelling would be written successfully and then make the WHOLE saved-view
    // value unreadable on the next read — durable user state lost with no
    // upstream owner to recover it from. A collision here would be a duplicate
    // id rather than a disclosure, so ordinary randomness is enough entropy;
    // the format is what must not vary.
    const bytes = new Uint8Array(16);
    const fill = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
    if (fill) fill(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
    ].join('-');
}
