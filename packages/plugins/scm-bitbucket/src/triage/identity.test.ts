import { describe, expect, it } from 'vitest';

import {
  BITBUCKET_COLLISION_SCOPE_PREFIX,
  buildBitbucketCollisionScope,
  buildBitbucketRepositoryKey,
  encodeBitbucketPathSegment,
  readBitbucketBracedUuid,
  readBitbucketEntryId,
} from './identity.js';

describe('Bitbucket triage identity', () => {
  it('keeps the literal curly braces that Bitbucket path segments require', () => {
    const raw = '{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}';

    expect(readBitbucketBracedUuid(raw)).toBe(raw);
    expect(readBitbucketBracedUuid('1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9')).toBeNull();
    expect(readBitbucketBracedUuid('{not-a-uuid}')).toBeNull();
    expect(readBitbucketBracedUuid(42)).toBeNull();

    expect(buildBitbucketCollisionScope(raw)).toBe(`${BITBUCKET_COLLISION_SCOPE_PREFIX}${raw}`);
    expect(buildBitbucketCollisionScope('1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9')).toBeNull();
  });

  it('percent-encodes the braces instead of stripping them, because a stripped brace 404s silently', () => {
    expect(encodeBitbucketPathSegment('{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}'))
      .toBe('%7B1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9%7D');
  });

  it('derives the entry id from the provider integer and refuses non-integral ids', () => {
    expect(readBitbucketEntryId(42)).toBe('42');
    expect(readBitbucketEntryId('42')).toBeNull();
    expect(readBitbucketEntryId(4.2)).toBeNull();
    expect(readBitbucketEntryId(0)).toBeNull();
    expect(readBitbucketEntryId(-1)).toBeNull();
    expect(readBitbucketEntryId(undefined)).toBeNull();
  });

  it('lowercases the mutable slug locator and rejects a shape that is not workspace/repo', () => {
    expect(buildBitbucketRepositoryKey('Example-Workspace/Deploy-Tools'))
      .toBe('example-workspace/deploy-tools');
    expect(buildBitbucketRepositoryKey('deploy-tools')).toBeNull();
    expect(buildBitbucketRepositoryKey('a/b/c')).toBeNull();
    expect(buildBitbucketRepositoryKey(null)).toBeNull();
  });
});
