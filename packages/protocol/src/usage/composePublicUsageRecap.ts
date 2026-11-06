import { PUBLIC_PROFILE_FIELDS_V1, type PublicProfileField, type PublicProfilePolicyV1 } from '../account/publicProfile.js';
import { PublicProfileReadResultV1Schema, type PublicProfileReadResultV1 } from '../account/publicProfilePublication.js';
import { projectPublicProfileSnapshot } from '../account/projectPublicProfile.js';
import { UsageRecapComposeResultSchema, USAGE_RECAP_FIELDS, type UsageRecapComposeResult,
  type UsageRecapPublicComposeInput } from './usageRecap.js';

/** Select within an already admitted current public view; never opens private Usage. */
export function composePublicUsageRecap(input: UsageRecapPublicComposeInput, raw: PublicProfileReadResultV1): UsageRecapComposeResult {
  const source = PublicProfileReadResultV1Schema.parse(raw);
  if (source.kind !== 'published') return { kind: 'unavailable', reason: 'public_profile_unavailable' };
  const selectedFields = USAGE_RECAP_FIELDS.filter(field => input.selectedFields.some(selected => selected === field));
  const selected = new Set(selectedFields);
  const allowed: PublicProfileField[] = [];
  if (selected.has('tokens')) allowed.push('tokens');
  if (selected.has('activeDays')) allowed.push('activeDays');
  if (selected.has('streak')) allowed.push('bestStreak');
  if (selected.has('agentMix')) allowed.push('agentMix');
  if (selected.has('parallel')) allowed.push('agentTime', 'peakParallel');
  if (selected.has('work')) allowed.push('mergedPrs');
  if (selected.has('rhythm')) allowed.push('calendar', 'punch');
  if (selected.has('highlights')) allowed.push('highlights');
  const policy: PublicProfilePolicyV1 = { indexable: false,
    fields: Object.fromEntries(PUBLIC_PROFILE_FIELDS_V1.map(field => [field, allowed.includes(field)])) as Record<PublicProfileField, boolean> };
  const publicSnapshot = projectPublicProfileSnapshot(source.view.snapshot, policy);
  // Consent dependencies were already enforced by the current public reader.
  // Selecting a highlight need not also display its separate summary metric.
  if (selected.has('highlights') && source.view.snapshot.facts.highlights) {
    publicSnapshot.facts.highlights = source.view.snapshot.facts.highlights;
  }
  const facts = publicSnapshot.facts;
  const available = { tokens: facts.tokens !== undefined, activeDays: facts.activeDays !== undefined,
    streak: facts.bestStreakDays !== undefined, agentMix: facts.agentMix !== undefined,
    parallel: facts.agentTimeMs !== undefined || facts.peakParallel !== undefined,
    work: facts.mergedPrs !== undefined, rhythm: facts.calendar !== undefined || facts.punch !== undefined,
    highlights: (facts.highlights?.length ?? 0) > 0 };
  return UsageRecapComposeResultSchema.parse({ kind: 'composed', v: 1, source: 'public_profile',
    style: input.style, format: input.format, selectedFields,
    unavailableFields: selectedFields.filter(field => !available[field as keyof typeof available]),
    period: publicSnapshot.period, asOfMs: null,
    coverage: { accounting: null, sourceCoverage: [], sourceStatuses: [], pending: false },
    facts: {}, publicSnapshot,
  });
}
