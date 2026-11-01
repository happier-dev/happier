/** systemd's export framing is binary-safe, permits repeated fields and has no
 * field ordering guarantee. Retain only the requested decoded MESSAGE slice;
 * even a single native field may exceed the host's entire captured-output budget.
 * https://systemd.io/JOURNAL_EXPORT_FORMATS/ */
export function createJournalExportPage(maxBytes: number, resume?: Readonly<{ cursor: string; offset: number; after: boolean }>) {
    let mode: 'name' | 'text' | 'size' | 'binary' | 'separator' = 'name';
    let name = '';
    let field = '';
    let size = 0n;
    let sizeBytes = 0;
    let remaining = 0n;
    let decoder = new TextDecoder();
    let cursor = '';
    let value = '';
    let entryBytes = 0;
    let pageBytes = 0;
    let text = '';
    let first = true;
    let next: Readonly<{ cursor: string; offset: number; after: boolean }> | null = resume ?? null;
    let full = false;
    let invalid = false;
    let retainedInEntry = 0;
    const encoder = new TextEncoder();

    const message = (chunk: string) => {
        for (const character of chunk) {
            const bytes = encoder.encode(character).byteLength;
            const skip = first && resume && !resume.after ? resume.offset : 0;
            if (entryBytes < skip && entryBytes + bytes > skip) invalid = true;
            if (entryBytes >= skip && pageBytes + bytes <= maxBytes && !full) {
                text += character;
                pageBytes += bytes;
                retainedInEntry += bytes;
            } else if (entryBytes >= skip) full = true;
            entryBytes += bytes;
        }
    };
    const data = (bytes: Uint8Array) => {
        if (field === 'MESSAGE') message(decoder.decode(bytes, { stream: true }));
        else if (field === '__CURSOR') value += decoder.decode(bytes, { stream: true });
    };
    const finishField = () => {
        if (field === 'MESSAGE') { message(decoder.decode()); message('\n'); }
        if (field === '__CURSOR') { value += decoder.decode(); cursor = value; }
        field = ''; value = ''; decoder = new TextDecoder();
    };
    const finishEntry = () => {
        if (!cursor || first && resume && !resume.after && cursor !== resume.cursor) invalid = true;
        const skip = first && resume && !resume.after ? resume.offset : 0;
        if (skip > entryBytes) invalid = true;
        const consumed = entryBytes - skip;
        // The prefix belongs to this entry even when its cursor followed MESSAGE.
        next = full ? { cursor, offset: skip + retainedInEntry, after: false } : { cursor, offset: 0, after: true };
        if (consumed > retainedInEntry) full = true;
        if (pageBytes === maxBytes) full = true;
        entryBytes = 0; retainedInEntry = 0; cursor = ''; first = false;
    };
    return {
        push(bytes: Uint8Array) {
            let at = 0;
            while (at < bytes.length && !invalid && !(full && mode === 'name' && name === '' && !cursor && entryBytes === 0)) {
                if (mode === 'name') {
                    const byte = bytes[at++]!;
                    if (byte === 61) { field = name; name = ''; mode = 'text'; }
                    else if (byte === 10) {
                        if (!name) { finishEntry(); }
                        else { field = name; name = ''; size = 0n; sizeBytes = 0; mode = 'size'; }
                    } else if (name.length <= 8) name += String.fromCharCode(byte);
                } else if (mode === 'size') {
                    size |= BigInt(bytes[at++]!) << BigInt(sizeBytes++ * 8);
                    if (sizeBytes === 8) { remaining = size; mode = remaining ? 'binary' : 'separator'; }
                } else if (mode === 'separator') {
                    if (bytes[at++] !== 10) { invalid = true; break; }
                    finishField(); mode = 'name';
                } else {
                    let end: number;
                    if (mode === 'text') {
                        const newline = bytes.indexOf(10, at);
                        end = newline < 0 ? bytes.length : newline;
                    } else end = at + Number(remaining < BigInt(bytes.length - at) ? remaining : BigInt(bytes.length - at));
                    data(bytes.subarray(at, end));
                    const length = end - at;
                    at = end;
                    if (mode === 'binary') { remaining -= BigInt(length); if (!remaining) mode = 'separator'; }
                    else if (at < bytes.length) {
                        finishField();
                        at += 1; mode = 'name';
                    }
                }
            }
        },
        get done() { return full && !cursor && entryBytes === 0; },
        result() {
            if (invalid || mode !== 'name' || name || cursor || entryBytes) return null;
            return { text, next, truncated: full };
        },
    };
}
