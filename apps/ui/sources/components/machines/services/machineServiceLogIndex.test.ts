import { describe, expect, it } from 'vitest';
import { buildMachineServiceLogIndex } from './machineServiceLogIndex';

const project = `happier-${'2465b043f150a6ed'.repeat(4)}`;

function page(text: string) {
    return { kind: 'page' as const, page: { sourceRevision: 'source', text, nextCursor: null, truncated: false } };
}

describe('buildMachineServiceLogIndex', () => {
    it('names Compose resources by their service, volume or network, not by Happier\'s project identifier', () => {
        const projection = buildMachineServiceLogIndex({
            sourceKey: 'deployment-step',
            first: page([
                ` Volume ${project}_postgres-data Creating`,
                ` Network ${project}_default Created`,
                ` Container ${project}-database-1 Started`,
                `${project}-web-1  | listening on :8080`,
            ].join('\n')),
        });
        if (projection.kind !== 'index') throw new Error(`expected an index, got ${projection.kind}`);
        expect(projection.index.lines.map((line) => line.plainText)).toEqual([
            ' Volume postgres-data Creating',
            ' Network default Created',
            ' Container database-1 Started',
            'web-1  | listening on :8080',
        ]);
    });

    it('keeps every other identifier as the program wrote it', () => {
        const digest = 'postgres:17@sha256:6f7593c161689b6b02c78668b314af7da8811b592c5519108c0123456789abcd';
        const projection = buildMachineServiceLogIndex({ sourceKey: 'service', first: page(`pulled ${digest}\nhappier-cli 0.3.0`) });
        if (projection.kind !== 'index') throw new Error(`expected an index, got ${projection.kind}`);
        expect(projection.index.lines.map((line) => line.plainText)).toEqual([`pulled ${digest}`, 'happier-cli 0.3.0']);
    });
});
