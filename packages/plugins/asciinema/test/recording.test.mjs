import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRecording } from '../src/ui/recording.ts';
const ref = { kind: 'workspaceFile', handle: 'test' };
const cast = '{"version":2,"width":80,"height":24}\n[0.1,"o","hello\\r\\n"]\n';
function boundary(text = cast, sizeBytes = Buffer.byteLength(text)) {
    const reads = [];
    return { reads, host: {
        async statOpenableContent() { return { status: 'ready', mimeType: 'text/plain', contentClass: 'text', sizeBytes, revision: 'r1' }; },
        async readOpenableContent(request) { reads.push(request); return { status: 'ready', revision: 'r1', content: { kind: 'utf8', text } }; },
    } };
}
test('reads one full-cap revision-bound snapshot, including valid content beyond the default', async () => {
    const text = cast + JSON.stringify([1, 'o', 'x'.repeat(300_000)]) + '\n';
    const { host, reads } = boundary(text);
    assert.deepEqual(await readRecording(host, ref), { status: 'ready', text });
    assert.deepEqual(reads, [{ ref, expectedRevision: 'r1', maxBytes: 10_000_000 }]);
});
test('invalid JSON, invalid event and unsupported header show invalid recording', async () => {
    for (const text of ['bad', '{"version":1}', cast + 'bad', '{"version":2,"width":80,"height":24}\n["bad","o","x"]']) {
        assert.equal((await readRecording(boundary(text).host, ref)).status, 'invalid');
    }
});
test('oversize does not read; exact cap remains valid', async () => {
    const { host, reads } = boundary(cast, 10_000_001);
    assert.equal((await readRecording(host, ref)).status, 'tooLarge');
    assert.equal(reads.length, 0);
    assert.equal((await readRecording(boundary(cast, 10_000_000).host, ref)).status, 'ready');
});
test('host revision changes remain visible without retry', async () => {
    const { host } = boundary();
    host.readOpenableContent = async () => ({ status: 'changed' });
    assert.equal((await readRecording(host, ref)).status, 'changed');
});

test('v3 comments and exit events stay recording data', async () => {
    const text = '{"version":3,"term":{"cols":80,"rows":24}}\n# recording\n[0.2,"o","echo safe"]\n[0.1,"x","0"]\n';
    assert.deepEqual(await readRecording(boundary(text).host, ref), { status: 'ready', text });
});
