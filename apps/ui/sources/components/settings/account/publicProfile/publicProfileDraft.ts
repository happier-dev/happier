import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PUBLIC_PROFILE_FIELDS_V1, type PublicProfileField, type PublicProfileMetadataV1, type PublicProfilePolicyV1,
  type PublicProfileSnapshotV1 } from '@happier-dev/protocol/account/publicProfile';
import { resolvePublicProfileFieldDependencies } from '@happier-dev/protocol/account/projectPublicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, type PublicProfileAppearanceV1, type PublicProfileContextV1, type PublicProfileLayoutV1,
  type PublicProfileOwnerRecordV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { DEFAULT_HOME_ATMOSPHERE, type AtmospherePresentation } from '@happier-dev/protocol/account/settings/accountSettings';
import type { PublicProfileMetadataSelectionV1 } from '@happier-dev/protocol/account/publicProfileIntents';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** The applied edition's look is a reviewed copy; only a newly chosen candidate is prepared again. */
export type PublicProfileVisitorTheme = 'auto' | 'light' | 'dark';
export type PublicProfileAppearanceDraft =
  /** A theme alone can change on an applied planet or None look; its atmosphere stays the reviewed copy. */
  | Readonly<{ kind: 'applied'; value: PublicProfileAppearanceV1; theme?: PublicProfileVisitorTheme }>
  | Readonly<{ kind: 'candidate'; atmosphere: AtmospherePresentation; theme: 'auto' | 'light' | 'dark' }>;
/** The page's one public period: every number, the calendar, badges and card cover the same days. */
export const PUBLIC_PROFILE_PERIODS = ['30days', '90days', 'year'] as const;
export type PublicProfilePeriod = typeof PUBLIC_PROFILE_PERIODS[number];
/**
 * The owner's private draft: consent, placement, look, period and the words about them stay on this
 * device until Publish or Apply. Project choices are repository references; the host decides publicity.
 */
export type PublicProfileDraft = Readonly<{ policy: PublicProfilePolicyV1; layout: PublicProfileLayoutV1; appearance: PublicProfileAppearanceDraft;
  metadata: PublicProfileMetadataSelectionV1; period: PublicProfilePeriod }>;
export type PublicProfileDraftChanges = Readonly<{ policy: boolean; layout: boolean; appearance: boolean; metadata: boolean; period: boolean }>;
/** Whether an item is shared, and how many placed blocks need it to be drawn. */
/** Where a shared item appears: in how many placed blocks, and whether the page heading shows it. */
export type PublicFieldPlacement = Readonly<{ shown: boolean; blocks: number; heading: boolean }>;

export const DEFAULT_PUBLIC_PROFILE_QUERY = { period: { relative: '90days' } } as const;

const DEFAULT_CANDIDATE_ATMOSPHERE: AtmospherePresentation = {
  source: 'planet', planet: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1.atmosphere.source === 'planet'
    ? DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1.atmosphere.planet : DEFAULT_HOME_ATMOSPHERE.planet,
  picture: DEFAULT_HOME_ATMOSPHERE.picture, looks: {},
};

/** The period the record's applied edition covers (the default before the first Publish). */
export function publicProfileRecordPeriod(record: PublicProfileOwnerRecordV1 | null): PublicProfilePeriod {
  const relative = record?.query?.period && 'relative' in record.query.period ? record.query.period.relative : undefined;
  return PUBLIC_PROFILE_PERIODS.find(period => period === relative) ?? DEFAULT_PUBLIC_PROFILE_QUERY.period.relative;
}

/** The selection Publish or Apply sends for the record's own metadata: its words, links, photo and repositories. */
function recordMetadata(record: PublicProfileOwnerRecordV1 | null): PublicProfileMetadataSelectionV1 {
  const { projects: _projects, ...metadata } = record?.metadata ?? {};
  return { ...metadata, ...(record?.projectSelections?.length ? { projectSelections: record.projectSelections } : {}) };
}

export function publicProfileDraftQuery(draft: Pick<PublicProfileDraft, 'period'>) {
  return { period: { relative: draft.period } } as const;
}

export function createPublicProfileDraft(record: PublicProfileOwnerRecordV1 | null, defaults: Readonly<{ layout: PublicProfileLayoutV1 }>): PublicProfileDraft {
  return {
    metadata: recordMetadata(record),
    period: publicProfileRecordPeriod(record),
    policy: record?.policy ?? DEFAULT_PUBLIC_PROFILE_POLICY_V1,
    layout: record?.layout ?? defaults.layout,
    appearance: record?.appearance ? { kind: 'applied', value: record.appearance }
      : { kind: 'candidate', atmosphere: DEFAULT_CANDIDATE_ATMOSPHERE, theme: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1.theme },
  };
}

/**
 * The presentation the Look panel edits: the candidate, or the applied planet/none look as its source
 * settings. An applied picture is a reviewed public copy without local pixels, so choosing a look
 * again starts from the default planet.
 */
export function draftLookPresentation(draft: PublicProfileDraft): AtmospherePresentation {
  if (draft.appearance.kind === 'candidate') return draft.appearance.atmosphere;
  const atmosphere = draft.appearance.value.atmosphere;
  if (atmosphere?.source === 'planet') return { ...DEFAULT_CANDIDATE_ATMOSPHERE, planet: atmosphere.planet };
  if (atmosphere?.source === 'none') return { ...DEFAULT_CANDIDATE_ATMOSPHERE, source: 'none' };
  return DEFAULT_CANDIDATE_ATMOSPHERE;
}

/** The theme visitors' pages use; an applied picture keeps its reviewed theme until its look is chosen again. */
export function draftVisitorTheme(draft: PublicProfileDraft): PublicProfileVisitorTheme {
  return draft.appearance.kind === 'candidate' ? draft.appearance.theme : draft.appearance.theme ?? draft.appearance.value.theme;
}

export function setPublicProfileDraftTheme(draft: PublicProfileDraft, theme: PublicProfileVisitorTheme): PublicProfileDraft {
  return { ...draft, appearance: { ...draft.appearance, theme } };
}

export function setPublicProfileDraftField(draft: PublicProfileDraft, field: PublicProfileField, shown: boolean): PublicProfileDraft {
  if (draft.policy.fields[field] === shown) return draft;
  return { ...draft, policy: { ...draft.policy, fields: { ...draft.policy.fields, [field]: shown } } };
}

function samePolicy(a: PublicProfilePolicyV1, b: PublicProfilePolicyV1): boolean {
  return a.indexable === b.indexable && PUBLIC_PROFILE_FIELDS_V1.every(field => a.fields[field] === b.fields[field]);
}

/** What Publish or Apply would send; an untouched member keeps the server's current value. */
export function resolvePublicProfileDraftChanges(record: PublicProfileOwnerRecordV1 | null, draft: PublicProfileDraft): PublicProfileDraftChanges {
  return {
    policy: !record?.policy || !samePolicy(record.policy, draft.policy),
    layout: !record?.layout || JSON.stringify(record.layout) !== JSON.stringify(draft.layout),
    appearance: draft.appearance.kind === 'candidate' || !sameStrictJsonValue(
      { ...draft.appearance.value, theme: draftVisitorTheme(draft) }, record?.appearance ?? null),
    metadata: !sameStrictJsonValue(recordMetadata(record), draft.metadata),
    period: !record || publicProfileRecordPeriod(record) !== draft.period,
  };
}

/** Explains every field the projector's bodies consume, including independently optional figures. */
export function resolvePublicFieldPlacements(input: Readonly<{ context: PublicProfileContextV1; snapshot: PublicProfileSnapshotV1;
  draft: PublicProfileDraft }>): Readonly<Record<PublicProfileField, PublicFieldPlacement>> {
  const dependencies = resolvePublicProfileFieldDependencies(input.draft.layout);
  const policy = input.draft.policy;
  const { identity } = input.context;
  const { metadata } = input.draft;
  // The page heading shows identity and the about line whenever they exist, whatever the layout.
  const heading: Partial<Record<PublicProfileField, boolean>> = { name: identity.name !== undefined, since: identity.sinceMs !== undefined,
    // A photo or its explained planet fallback (U3) sits beside the name.
    avatar: identity.avatarUrl !== undefined || identity.avatar !== undefined, bio: Boolean(metadata.bio), links: Boolean(metadata.links?.length) };
  return Object.fromEntries(PUBLIC_PROFILE_FIELDS_V1.map(field => {
    return [field, { shown: policy.fields[field], blocks: [...dependencies.values()].filter(used => used.has(field)).length,
      heading: heading[field] ?? false }];
  })) as Record<PublicProfileField, PublicFieldPlacement>;
}

/**
 * The page's own preview of the draft's metadata. Repository choices show as the link the applied
 * edition already holds, or the repository's own address until Publish or Apply asks the hosting owner
 * again; the reviewed write still goes through the canonical preparer, which refuses anything not public.
 */
export function draftPreviewMetadata(draft: Pick<PublicProfileDraft, 'metadata'>,
  record: PublicProfileOwnerRecordV1 | null): PublicProfileMetadataV1 {
  const { projectSelections = [], ...metadata } = draft.metadata;
  const known = record?.metadata?.projects ?? [];
  const projects = projectSelections.flatMap(selection => {
    const label = selection.repository.nameWithOwner;
    const url = known.find(link => link.label === label)?.url ?? selection.repository.webUrl;
    return url ? [{ label, url }] : [];
  });
  return { ...metadata, ...(projects.length ? { projects } : {}) };
}
