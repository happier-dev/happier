import { expect, it } from 'vitest';
import { createJournalExportPage } from './journalExport.js';

it('decodes binary journal messages across native stream chunks without disclosing other fields', () => {
    const message = Buffer.from('ready\n心拍');
    const size = Buffer.alloc(8);
    size.writeBigUInt64LE(BigInt(message.length));
    const bytes = Buffer.concat([
        Buffer.from('__CURSOR=cursor-1\nPRIVATE=not-a-message\nMESSAGE\n'), size, message, Buffer.from('\n\n'),
    ]);
    const page = createJournalExportPage(128);
    for (const byte of bytes) page.push(Uint8Array.of(byte));
    expect(page.result()).toEqual({ text: 'ready\n心拍\n', next: { cursor: 'cursor-1', offset: 0, after: true }, truncated: false });
});

it('resumes a bounded message at its Unicode byte boundary and rejects incomplete framing', () => {
    const bytes = Buffer.from('__CURSOR=cursor-1\nMESSAGE=心拍ready\n\n');
    const first = createJournalExportPage(6);
    first.push(bytes);
    expect(first.result()).toEqual({ text: '心拍', next: { cursor: 'cursor-1', offset: 6, after: false }, truncated: true });
    const resumed = createJournalExportPage(128, { cursor: 'cursor-1', offset: 6, after: false });
    resumed.push(bytes);
    expect(resumed.result()).toEqual({ text: 'ready\n', next: { cursor: 'cursor-1', offset: 0, after: true }, truncated: false });
    const incomplete = createJournalExportPage(128);
    incomplete.push(bytes.subarray(0, bytes.length - 1));
    expect(incomplete.result()).toBeNull();
});
