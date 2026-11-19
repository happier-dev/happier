import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultCollectionSpaceV1,
  type CollectionSpaceV1,
} from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { ResourceSpaceMembershipMutationV1Schema } from '@happier-dev/protocol/collections/spaces/resourceSpaceMembershipV1';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);

const { resolveReviewSpaceDrop } = await import('./useReviewsCollectionView');

const scope = { serverId: 'home', accountId: 'alice' } as const;
const all = createDefaultCollectionSpaceV1('review', { name: 'All reviews' });
const space = (
  id: string,
  membership?: CollectionSpaceV1<'review'>['membership'],
): CollectionSpaceV1<'review'> => ({
  ...all,
  id,
  name: id === 'release' ? 'Release' : 'Mine',
  ...(membership ? { membership } : {}),
});
const spaces = [
  all,
  space('release', { mode: 'filter_or_manual' }),
  space('smart'),
];
const item = (artifactId: string, accountId = 'alice') => ({
  kind: 'artifact' as const,
  scope: { ...scope, accountId },
  artifactId,
});
const base = {
  scope,
  loadedReviewIds: new Set(['r1']),
  spaces,
  activeSpaceId: all.id,
};

describe('resolveReviewSpaceDrop', () => {
  it('adds a loaded Review to a space that keeps members through the canonical membership Action', () => {
    const admission = resolveReviewSpaceDrop({
      ...base,
      item: item('r1'),
      spaceId: 'release',
    });
    expect(admission.status).toBe('allowed');
    if (admission.status !== 'allowed') return;
    expect(admission.effect.actionId).toBe('collection.space.membership.set');
    expect(
      ResourceSpaceMembershipMutationV1Schema.parse(admission.effect.input),
    ).toEqual({
      resourceKind: 'artifact',
      resourceId: 'r1',
      operation: 'add',
      spaceId: 'release',
    });
  });

  it('refuses another Account, an unloaded item, a filter-only space and the space being viewed', () => {
    const code = (input: Parameters<typeof resolveReviewSpaceDrop>[0]) => {
      const admission = resolveReviewSpaceDrop(input);
      return admission.status === 'refused' ? admission.reason.code : 'allowed';
    };
    expect(code({ ...base, item: item('r1', 'bob'), spaceId: 'release' })).toBe(
      'scope-mismatch',
    );
    expect(code({ ...base, item: item('r2'), spaceId: 'release' })).toBe(
      'source-missing',
    );
    expect(code({ ...base, item: item('r1'), spaceId: 'smart' })).toBe(
      'unavailable',
    );
    expect(code({ ...base, item: item('r1'), spaceId: all.id })).toBe(
      'unavailable',
    );
    expect(
      code({
        ...base,
        activeSpaceId: 'release',
        item: item('r1'),
        spaceId: 'release',
      }),
    ).toBe('already-placed');
  });
});
