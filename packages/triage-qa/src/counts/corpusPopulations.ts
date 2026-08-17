import { parseContractIds } from '../plan/contractIds.ts';
import { parseQbMatrix } from '../plan/qbMatrix.ts';
import type { ComputablePopulation } from './computableCounts.ts';

/**
 * The populations this harness can compute from current corpus bytes, with the
 * noun phrases a document would use to state them.
 *
 * Deliberately closed and small: a population belongs here only when a command
 * in this package already computes it, so the check can always print the real
 * number beside the authored one instead of asserting a remembered value.
 */
export function computableCorpusPopulations(
    planMarkdown: string,
    protocolMarkdown: string,
): readonly ComputablePopulation[] {
    const contract = parseContractIds(planMarkdown);
    const matrix = parseQbMatrix(protocolMarkdown);
    return Object.freeze([
        Object.freeze({
            label: 'declared requirements',
            nouns: Object.freeze(['requirements']),
            computed: contract.requirements.length,
        }),
        Object.freeze({
            label: 'declared invariants',
            nouns: Object.freeze(['invariants']),
            computed: contract.invariants.length,
        }),
        Object.freeze({
            label: 'declared contract ids',
            nouns: Object.freeze(['contract ids']),
            computed: contract.all.length,
        }),
        Object.freeze({
            label: 'deciding QB rows',
            nouns: Object.freeze([
                'deciding rows',
                'deciding behaviour rows',
                'deciding behavior rows',
                'QB rows',
            ]),
            computed: matrix.rows.length,
        }),
        Object.freeze({
            label: 'retired QB rows',
            nouns: Object.freeze(['retired rows', 'retired ids']),
            computed: matrix.retired.length,
        }),
    ]);
}
