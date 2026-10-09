export function formatByteSize(bytes: number): string {
    const value = Number.isFinite(bytes) ? bytes : 0;
    if (value < 1024) return `${Math.max(0, Math.floor(value))} B`;
    const kb = value / 1024;
    if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`;
}


/** A size of a thing (a machine's memory or disk), not a transfer in progress: "8 GB", not "8.0 GB". */
export function formatByteCapacity(bytes: number): string {
    return formatByteSize(bytes).replace(/\.0 /, ' ');
}
