import type { ScmComparison, ScmDiffSummaryAnalysisCoverage, ScmDiffSummaryWalkthrough } from '@happier-dev/protocol';
import { SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH } from './walkthroughSpecimenFixture';

/** Dev illustration only; the real hosted capture owner supplies these facts. */
const id = 'specimen-pull-request';
const ref = (value: string) => `${id}:${value}`;
export const PR_SPECIMEN_COMPARISON: ScmComparison = {
    ...SPECIMEN_COMPARISON, id,
    source: { kind: 'pullRequest', locator: { providerId: 'github', repository: 'happier-dev/happier', number: 2481,
        baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) } },
    endpoints: { before: 'a'.repeat(40), after: 'b'.repeat(40) }, freshness: 'current',
    inventory: { ...SPECIMEN_COMPARISON.inventory, files: SPECIMEN_COMPARISON.inventory.files.map((file) => ({
        ...file, occurrences: file.occurrences.map((occurrence) => ({ ...occurrence, id: ref(occurrence.id) })),
    })) },
};
export const PR_SPECIMEN_WALKTHROUGH: ScmDiffSummaryWalkthrough = {
    ...SPECIMEN_WALKTHROUGH,
    stops: SPECIMEN_WALKTHROUGH.stops.map((stop) => ({ ...stop, changeRefs: stop.changeRefs.map(ref) })),
    otherChangeRefs: SPECIMEN_WALKTHROUGH.otherChangeRefs.map(ref),
};
const refs = PR_SPECIMEN_COMPARISON.inventory.files.flatMap((file) => file.occurrences.map((occurrence) => occurrence.id));
export const PR_SPECIMEN_ANALYSIS: ScmDiffSummaryAnalysisCoverage = { suppliedChangeRefs: refs, analysedChangeRefs: refs, remainingChangeRefs: [] };
export const PR_SPECIMEN_INCOMPLETE: ScmComparison = {
    ...PR_SPECIMEN_COMPARISON,
    inventory: { ...PR_SPECIMEN_COMPARISON.inventory, state: 'incomplete', reasons: ['GitHub did not supply the yarn.lock patch'],
        files: PR_SPECIMEN_COMPARISON.inventory.files.map((file) => file.path === 'yarn.lock' ? {
            ...file, binary: null, evidence: { state: 'unavailable', reason: 'provider_patch_missing' },
            occurrences: file.occurrences.map((occurrence) => ({ ...occurrence, evidence: { state: 'unavailable', reason: 'provider_patch_missing' } })),
        } : file) },
};
