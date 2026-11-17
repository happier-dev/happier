/** Accept both cumulative input and replacement carrier batches without replaying a prefix. */
export function addedAvccChunks(previous: readonly Uint8Array[], current: readonly Uint8Array[]): readonly Uint8Array[] {
    const isAppend = previous.length <= current.length && previous.every((chunk, index) => current[index] === chunk);
    return isAppend ? current.slice(previous.length) : current;
}
