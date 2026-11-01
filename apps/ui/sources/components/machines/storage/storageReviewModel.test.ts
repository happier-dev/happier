import { describe, expect, it } from 'vitest';
import type {
  PileApplyResultV1,
  PileItemRefV1,
  PileReviewV1,
  StorageItemCheckV1,
} from '@happier-dev/protocol/storage/storageV1';

import {
  buildStorageReview,
  describeStorageApplyResult,
  selectStorageReviewApply,
  selectStorageReviewTicks,
} from './storageReviewModel';

const size = (frees: number) => ({
  allocatedBytes: frees + 1,
  freesBytes: frees,
  sharedBytes: 0,
  sharedExtentsUnmeasured: false,
  atLeast: false,
});
const ref = (itemId: string, path: string): PileItemRefV1 => ({
  itemId,
  path,
  identity: { dev: '1', ino: '2', kind: 'directory' },
  collectedAt: 1,
  collectedBy: { accountId: 'a', kind: 'person' },
});
const check = (
  itemId: string,
  path: string,
  frees: number,
  verdict: StorageItemCheckV1['verdict'] = 'safe',
  extra: Partial<StorageItemCheckV1> = {},
): StorageItemCheckV1 => ({
  ref: ref(itemId, path),
  expect: `expect-${itemId}`,
  verdict,
  reason: { code: verdict === 'keep' ? 'changed_files' : 'rebuilds' },
  size: size(frees),
  absorbs: [],
  ...extra,
});
const volumes = [
  { volume: { volumeId: 'mac', mountPath: '/', label: 'Macintosh HD' } },
  { volume: { volumeId: 'work', mountPath: '/Volumes/Work', label: 'Work' } },
];

function review(): PileReviewV1 {
  return {
    items: [
      check('pnpm', '/Users/l/Library/pnpm', 9_800),
      check('nm', '/Users/l/dev/nm', 11_200),
      check('main', '/Users/l/dev/happier', 21_600, 'keep', {
        loses: [{ code: 'changed_files', detail: { count: 3 } }],
      }),
      check('wt', '/Users/l/dev/.dev/worktree/a', 2_400, 'safe', {
        absorbs: ['nm-inside'],
      }),
      check('ext', '/Volumes/Work/cache', 1_000),
    ],
    staying: [
      {
        item: { itemId: 'tidy', path: '/Users/l/dev/.dev/worktree/tidy' },
        reason: { code: 'in_use' },
      },
    ],
    countedOnceBytes: 300,
    totalFreesBytes: 46_000,
    trashVolumes: [
      { volumeId: 'mac', trashAvailable: true },
      {
        volumeId: 'work',
        trashAvailable: false,
        reason: { code: 'trash_unavailable' },
      },
    ],
  };
}

describe('the review sheet model (plan 40 STO-12, lab rs R)', () => {
  it('uses canonical daemon titles for going and staying rows and opens titleless older reviews', () => {
    const value = review();
    const titled = { ...value.items[0]!, title: 'pnpm store', ref: { ...value.items[0]!.ref, title: 'pnpm store' } };
    const staying = { ...value.staying[0]!, item: { ...value.staying[0]!.item, title: 'tidy · main checkout' } };
    const model = buildStorageReview({ ...value, items: [titled], staying: [staying] }, volumes);
    expect(model.going[0]).toHaveProperty('title', 'pnpm store');
    expect(model.staying[0]).toHaveProperty('title', 'tidy · main checkout');
    const old = buildStorageReview(value, volumes);
    expect(old.going.find(row => row.itemId === 'pnpm')).toHaveProperty('title', 'pnpm');
    expect(old.staying[0]).toHaveProperty('title', 'tidy');
  });
  it('lists what goes biggest first with its frees and what is lost, what stays with its reason, and which disks have no Trash', () => {
    const model = buildStorageReview(review(), volumes);
    expect(model.going.map((row) => row.itemId)).toEqual([
      'main',
      'nm',
      'pnpm',
      'wt',
      'ext',
    ]);
    expect(model.going.find((row) => row.itemId === 'main')).toMatchObject({
      verdict: 'keep',
      loses: [{ code: 'changed_files' }],
    });
    expect(model.going.find((row) => row.itemId === 'ext')).toMatchObject({
      volumeId: 'work',
      trashAvailable: false,
    });
    expect(model.going.find((row) => row.itemId === 'pnpm')).toMatchObject({
      volumeId: 'mac',
      trashAvailable: true,
    });
    expect(model.staying).toEqual([
      {
        itemId: 'tidy',
        title: 'tidy',
        path: '/Users/l/dev/.dev/worktree/tidy',
        reason: { code: 'in_use' },
      },
    ]);
    expect(model.countedOnceBytes).toBe(300);
    expect(model.absorbedCount).toBe(1);
  });

  it('moves to the Trash only what the person still has ticked (approve 4 of 5), passing each review token back unchanged', () => {
    const model = buildStorageReview(review(), volumes);
    const all = new Set(model.going.map((row) => row.itemId));
    const trash = selectStorageReviewApply(model, all, 'trash');
    // The disk without a Trash cannot take a Trash move: it is left out and said so.
    expect(trash.items.map((entry) => entry.ref.itemId)).toEqual([
      'main',
      'nm',
      'pnpm',
      'wt',
    ]);
    expect(trash.withoutTrash).toEqual(['ext']);
    expect(trash.items[0]).toEqual({
      ref: ref('main', '/Users/l/dev/happier'),
      expect: 'expect-main',
      claimedVerdict: 'keep',
      reason: { code: 'changed_files' },
    });
    expect(trash.freesBytes).toBe(21_600 + 11_200 + 9_800 + 2_400);

    const narrowed = new Set([...all].filter((id) => id !== 'main'));
    const fewer = selectStorageReviewApply(model, narrowed, 'trash');
    expect(fewer.items.map((entry) => entry.ref.itemId)).toEqual([
      'nm',
      'pnpm',
      'wt',
    ]);
    expect(fewer.count).toBe(3);
    expect(fewer.freesBytes).toBe(11_200 + 9_800 + 2_400);
  });

  it('says what the ticked items take as well as what they free, the page pile\'s two quantities', () => {
    const model = buildStorageReview(review(), volumes);
    const ticked = new Set(['nm', 'pnpm']);
    const plan = selectStorageReviewApply(model, ticked, 'trash');
    // `size()` allocates one byte more than it frees; the pile legend reads allocated, the total reads frees.
    expect(plan.allocatedBytes).toBe(11_200 + 1 + 9_800 + 1);
    expect(plan.freesBytes).toBe(11_200 + 9_800);
  });

  it('deletes now every ticked item, including those on a disk without a Trash, with no verdict claim', () => {
    const model = buildStorageReview(review(), volumes);
    const picked = new Set(['nm', 'ext']);
    const deleting = selectStorageReviewApply(model, picked, 'delete');
    expect(deleting.items).toEqual([
      { ref: ref('nm', '/Users/l/dev/nm'), expect: 'expect-nm' },
      { ref: ref('ext', '/Volumes/Work/cache'), expect: 'expect-ext' },
    ]);
    expect(deleting.withoutTrash).toEqual([]);
    expect(deleting.freesBytes).toBe(12_200);
  });

  it('names the sessions holding an in-use item the person still has ticked, once each, so they stop before it goes', () => {
    const inUse = (sessionId: string) => ({ code: 'in_use' as const, detail: { sessionId } });
    const model = buildStorageReview(
      {
        ...review(),
        items: [
          check('wt-a', '/Users/l/dev/.dev/worktree/a', 10, 'keep', {
            reason: inUse('s-1'),
            loses: [inUse('s-1'), inUse('s-2')],
          }),
          check('wt-b', '/Users/l/dev/.dev/worktree/b', 10, 'keep', {
            reason: inUse('s-2'),
            loses: [inUse('s-2')],
          }),
          check('wt-c', '/Users/l/dev/.dev/worktree/c', 10, 'keep', {
            reason: inUse('s-3'),
            loses: [inUse('s-3')],
          }),
          // In use, but by nothing Happier can stop: no holder to name.
          check('tmp', '/Users/l/tmp/x', 10, 'keep', { reason: { code: 'in_use' } }),
        ],
      },
      volumes,
    );
    const ticked = new Set(['wt-a', 'wt-b', 'tmp']);
    expect(selectStorageReviewApply(model, ticked, 'trash').holders).toEqual(['s-1', 's-2']);
    expect(selectStorageReviewApply(model, ticked, 'delete').holders).toEqual(['s-1', 's-2']);
    expect(selectStorageReviewApply(model, new Set(['tmp']), 'trash').holders).toEqual([]);
  });

  it('starts with the verdict default (only Safe ticked) and carries a tick across a re-check only while its verdict holds', () => {
    const first = buildStorageReview(
      {
        ...review(),
        items: [
          check('safe', '/Users/l/cache/a', 30),
          check('caution', '/Users/l/Dropbox/x', 20, 'caution'),
          check('held', '/tmp/held', 10, 'keep', { reason: { code: 'in_use' } }),
          check('root', '/', 10, 'forbidden', { title: 'System disk' }),
          check('unknown', '/Users/l/x', 10, 'check'),
        ],
      },
      volumes,
    );
    expect([...selectStorageReviewTicks(first)].sort()).toEqual(['safe']);
    expect(first.staying.find((row) => row.itemId === 'root')).toMatchObject({ title: 'System disk' });
    expect(selectStorageReviewApply(first, new Set(['root']), 'delete').count).toBe(0);
    // The person unticks Safe and explicitly ticks the Keep row (its loss text is on the row).
    const chosen = new Set(['caution', 'held']);
    const again = buildStorageReview(
      {
        ...review(),
        items: [
          check('safe', '/Users/l/cache/a', 30),
          // Came into use since the first check: back to the Keep default, never carried over ticked.
          check('caution', '/Users/l/Dropbox/x', 20, 'keep', { reason: { code: 'in_use' } }),
          // Its holder stopped: the Safe default.
          check('held', '/tmp/held', 10),
        ],
      },
      volumes,
    );
    expect([...selectStorageReviewTicks(again, { review: first, selected: chosen })].sort()).toEqual(['held']);
    expect([...selectStorageReviewTicks(first, { review: first, selected: chosen })].sort()).toEqual(['caution', 'held']);
  });

  it('never claims more than the counted-once total frees', () => {
    const value = review();
    value.totalFreesBytes = 10_000;
    const model = buildStorageReview(value, volumes);
    expect(
      selectStorageReviewApply(
        model,
        new Set(model.going.map((row) => row.itemId)),
        'delete',
      ).freesBytes,
    ).toBe(10_000);
  });

  it('uses the measured union when every reviewed root is selected, including cross-root hardlinks', () => {
    const value = { ...review(), items: [check('a', '/cache/a', 10), check('b', '/cache/b', 20)],
      staying: [], totalFreesBytes: 100 };
    const model = buildStorageReview(value, volumes);
    expect(selectStorageReviewApply(model, new Set(['a', 'b']), 'delete').freesBytes).toBe(100);
    // A subset has only the conservative per-root measurement from this review.
    expect(selectStorageReviewApply(model, new Set(['a']), 'delete').freesBytes).toBe(10);
  });
});

describe('the apply result (lab rs RD)', () => {
  it('counts what moved, was skipped, refused or failed, so the count shown equals the set acted on', () => {
    const result: PileApplyResultV1 = {
      batchId: 'b',
      mode: 'trash',
      inTrashBytes: 34_500,
      freedBytes: 0,
      outcomes: [
        { itemId: 'a', status: 'moved' },
        { itemId: 'b', status: 'moved' },
        {
          itemId: 'c',
          status: 'skipped',
          reason: { code: 'changed_since_review' },
        },
        { itemId: 'd', status: 'refused', reason: { code: 'home_folder' } },
        { itemId: 'e', status: 'failed', reason: { code: 'operation_failed' } },
      ],
    };
    expect(describeStorageApplyResult(result)).toEqual({
      acted: 2,
      skipped: 1,
      refused: 1,
      failed: 1,
      notActed: [
        {
          itemId: 'c',
          status: 'skipped',
          reason: { code: 'changed_since_review' },
        },
        { itemId: 'd', status: 'refused', reason: { code: 'home_folder' } },
        { itemId: 'e', status: 'failed', reason: { code: 'operation_failed' } },
      ],
    });
  });
});
