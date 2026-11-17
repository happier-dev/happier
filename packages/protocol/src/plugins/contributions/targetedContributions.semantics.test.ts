import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { defineProtocolNumber, defineProtocolObject, defineProtocolString } from '../actions/protocolComposableSchema.js';
import { rehydratePluginContributionPointSemanticsV1, type PluginContributionPointProtocolV1 } from './targetedContributions.js';

// Distinct canonical documents: equal text would share one admitted document.
function protocolWithOperations(protocolIndex: number, operations: number): PluginContributionPointProtocolV1 {
    const schema = (kind: string, index: number) => defineProtocolObject({
        [`${kind}_${protocolIndex}_${index}`]: defineProtocolString(),
        [`count_${protocolIndex}_${index}`]: defineProtocolNumber(),
        [`nested_${protocolIndex}_${index}`]: defineProtocolObject({ label: defineProtocolString() }, { policy: 'closed' }),
    }, { policy: 'closed' }).jsonSchema;
    return {
        id: `protocol-${protocolIndex}`, version: 1,
        operations: Object.fromEntries(Array.from({ length: operations }, (_, index) => [`role${index}`, {
            required: true,
            input: { kind: 'protocolDefined', schema: schema('input', index) },
            resultSchema: schema('result', index),
            action: { surfaces: ['agent'], dangerLevel: 'safe' },
        }])),
    } as unknown as PluginContributionPointProtocolV1;
}

describe('targeted contribution point semantics', () => {
    it('decides validity at admission but builds each parser only on its first read', () => {
        // The idle daemon retained 6.47 MiB under rehydration, 4.24 of it parser trees, for
        // contribution points no running consumer read (LEAN-DAEMON U1d, sb1 sampling profile).
        v8.setFlagsFromString('--expose-gc');
        const gc = runInNewContext('gc') as () => void;
        const heapAfterGc = () => { for (let index = 0; index < 4; index += 1) gc(); return process.memoryUsage().heapUsed; };
        const protocols = Array.from({ length: 40 }, (_, index) => protocolWithOperations(index, 10));
        const before = heapAfterGc();
        const semantics = protocols.map(protocol => rehydratePluginContributionPointSemanticsV1(protocol));
        expect(semantics.every(value => value !== null && value.operations.length === 10)).toBe(true);
        const admitted = heapAfterGc() - before;
        const parsers = semantics.flatMap(value => value!.operations.flatMap(operation => [
            operation.resultSchema, operation.input.kind === 'protocolDefined' ? operation.input.schema : null,
        ]));
        const read = heapAfterGc() - before;
        // Admission keeps validity, not the parser trees: they appear on the first read.
        expect(admitted).toBeLessThan((read - admitted) / 2);
        const first = semantics[0]!.operations[0]!;
        expect(first.resultSchema).toBe(first.resultSchema);
        expect(first.resultSchema.safeParse({ result_0_0: 'a', count_0_0: 1, nested_0_0: { label: 'x' } }).success).toBe(true);
        expect(first.resultSchema.safeParse({ result_0_0: 1 }).success).toBe(false);
        expect(parsers.length).toBe(800);
    });

    it('still refuses a non-canonical schema at admission', () => {
        const protocol = protocolWithOperations(1000, 1) as unknown as { operations: Record<string, { resultSchema: unknown }> };
        protocol.operations.role0!.resultSchema = { not: { type: 'null' } };
        expect(rehydratePluginContributionPointSemanticsV1(protocol as unknown as PluginContributionPointProtocolV1)).toBeNull();
    });
});
