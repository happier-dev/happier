import { expect, it } from 'vitest';
import { inspectJsonCell } from './cellInspection.js';
it('loads a JSON value through existing cell continuation ranges and formats without rounding numeric tokens', async () => {
    const calls: unknown[] = [];
    const result = await inspectJsonCell({ type: 'partial', valueType: 'json', value: '{', encoding: 'utf8', range: { offset: 0, length: 1, unit: 'utf8_bytes', total: 25 } }, async range => {
        calls.push(range);
        return { value: { type: 'json', value: '{"id":9007199254740993,"text":"a\\\"b"}' }, completeness: { complete: true } };
    });
    expect(calls).toEqual([{ offset: 0, length: 25, unit: 'utf8_bytes', total: 25 }]);
    expect(result).toMatchObject({ status: 'complete', formatted: '{\n  "id": 9007199254740993,\n  "text": "a\\\"b"\n}' });
});
it('keeps an incomplete JSON read explicit instead of parsing a retained prefix as a complete value', async () => {
    const cell = { type: 'partial' as const, valueType: 'json' as const, value: '{', encoding: 'utf8' as const, range: { offset: 0, length: 1, unit: 'utf8_bytes' as const } };
    expect(await inspectJsonCell(cell, async () => ({ value: cell, completeness: { complete: false, reason: 'transport_unproven' } }))).toMatchObject({ status: 'incomplete' });
});

it('formats the full JSON string read from a clipped grid cell without losing any bytes', async () => {
    const body = 'x'.repeat(24_000_001) + '\\"tail';
    const encoded = JSON.stringify(body);
    const value = `{"id":9007199254740993,"body":${encoded}}`;
    const result = await inspectJsonCell({
        type: 'partial', valueType: 'json', value: '{', encoding: 'utf8',
        range: { offset: 0, length: 1, total: value.length, unit: 'utf8_bytes' },
    }, async () => ({ value: { type: 'json', value }, completeness: { complete: true } }));

    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.value === value).toBe(true);
    expect(result.formatted === `{\n  "id": 9007199254740993,\n  "body": ${encoded}\n}`).toBe(true);
});

it('assembles contiguous cell continuation slices and does not read an already complete JSON cell', async () => {
    const reads: number[] = [];
    const initial = { type: 'partial' as const, valueType: 'json' as const, value: '[', encoding: 'utf8' as const, range: { offset: 0, length: 1, total: 5, unit: 'utf8_bytes' as const } };
    const result = await inspectJsonCell(initial, async range => {
        reads.push(range.offset);
        return range.offset === 0 ? { value: initial, completeness: { complete: false, reason: 'response_envelope', continuation: {
            kind: 'cell', input: { target: { kind: 'manual', accountId: 'a', installationId: 'i', projectKey: 'p', workspace: { serverId: 's', machineId: 'm', workspaceId: 'w', rootPath: '/p' }, savedSecretId: 'connection' }, relation: { schema: 'public', name: 'items' }, key: [{ column: 'id', value: { type: 'integer', value: '1' } }], column: 'json' },
            range: { offset: 1, length: 4, unit: 'utf8_bytes', total: 5 } } } }
            : { value: { ...initial, value: '1,2]', range: { offset: 1, length: 4, unit: 'utf8_bytes', total: 5 } }, completeness: { complete: false, reason: 'page' } };
    });
    expect(result).toMatchObject({ status: 'complete', value: '[1,2]' });
    expect(reads).toEqual([0, 1]);
    expect(await inspectJsonCell({ type: 'json', value: '[]' }, async () => { throw new Error('Complete cells need zero reads'); })).toEqual({ status: 'complete', value: '[]', formatted: '[]' });
});
