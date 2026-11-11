import type { TriageListSortV1 } from '@happier-dev/triage-protocol/v1';

/** Native field names are the source's capability and request-ordering authority. */
export const BITBUCKET_NATIVE_SORT_FIELDS = Object.freeze({ updated: 'updated_on', created: 'created_on' } as const);
export type BitbucketSortField = keyof typeof BITBUCKET_NATIVE_SORT_FIELDS;
export type BitbucketFieldSort = Readonly<{ field: BitbucketSortField; direction: TriageListSortV1['direction'] }>;
export const BITBUCKET_TRIAGE_SORT_FIELDS = Object.freeze(Object.keys(BITBUCKET_NATIVE_SORT_FIELDS) as BitbucketSortField[]);
export function isBitbucketSortField(field: string): field is BitbucketSortField {
  return Object.prototype.hasOwnProperty.call(BITBUCKET_NATIVE_SORT_FIELDS, field);
}
