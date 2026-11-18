import assert from 'node:assert/strict';
import test from 'node:test';
import { WEB_BOOT_WEIGHT_VERSION, WEB_BOOT_WEIGHT_COMMENT_MARKER, compareWebBootWeight, renderWebBootWeightComment } from './web-boot-weight.mjs';

const measurement = (sha, modules, extra = {}) => ({ version: WEB_BOOT_WEIGHT_VERSION, sha, bytes: 1000,
  boot: { modules, bytes: 500, brotliBytes: 100, files: [{ kind: 'script', file: '_expo/static/js/web/entry.js', modules, bytes: 500, brotliBytes: 100 }] }, ...extra });

test('the PR diff names each boot change against the exact base', () => {
  const result = compareWebBootWeight(measurement('b'.repeat(40), 11), measurement('a'.repeat(40), 10));
  assert.equal(result.status, 'FAIL');
  assert.match(result.markdown, /Changed against base: modules before Home \+1\./);
  assert.match(result.markdown, /modules before Home \| 10 \| 11 \| 1 /);
  assert.ok(result.markdown.includes('a'.repeat(40)));
});

test('a missing base or a base measured under another definition shows this commit without deltas', () => {
  for (const baseline of [null, measurement('a'.repeat(40), 10, { version: WEB_BOOT_WEIGHT_VERSION + 1 })]) {
    const result = compareWebBootWeight(measurement('b'.repeat(40), 11), baseline);
    assert.equal(result.status, 'UNAVAILABLE');
    assert.deepEqual(result.boot.map(row => row.delta), [null, null, null]);
    assert.match(result.markdown, /modules before Home \| unavailable \| 11 \| unavailable /);
  }
});

test('the sticky PR comment renders only plain measurement data from CI artifacts', () => {
  const comment = renderWebBootWeightComment(measurement('b'.repeat(40), 11), measurement('a'.repeat(40), 10));
  assert.ok(comment.startsWith(WEB_BOOT_WEIGHT_COMMENT_MARKER));
  assert.match(comment, /Changed against base: modules before Home \+1\./);
  // Artifacts come from runs that executed pull-request code: text that is not a plain
  // identifier (links, markup, mentions, table breaks) is refused, never posted.
  for (const file of ['[x](https://example.invalid)', '<img src=x>', 'a|b', '@someone', 'a`b']) {
    const hostile = measurement('b'.repeat(40), 11);
    hostile.boot.files[0].file = file;
    assert.throws(() => renderWebBootWeightComment(hostile, null), /plain/);
  }
  assert.throws(() => renderWebBootWeightComment({ ...measurement('b'.repeat(40), 11), bytes: '**big**' }, null), /plain/);
  // An unusable base is dropped, not trusted: the comment shows this commit only.
  const unusableBase = { ...measurement('a'.repeat(40), 10), sha: '<b>' };
  assert.match(renderWebBootWeightComment(measurement('b'.repeat(40), 11), unusableBase), /No exact-base measurement/);
});
