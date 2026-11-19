import assert from 'node:assert/strict';
import test from 'node:test';
import { WEB_BOOT_WEIGHT_VERSION, WEB_BOOT_WEIGHT_COMMENT_MARKER, compareWebBootWeight, renderWebBootWeightComment } from './web-boot-weight.mjs';

const routeRow = (name, bytes) => ({ files: [`_expo/static/js/web/${name}.js`], shared: ['_expo/static/js/web/__common-e.js'], bytes, brotliBytes: bytes / 10, modules: 2 });
const measurement = (sha, modules, extra = {}, routes = { './(app)/index.tsx': routeRow('index-c', 100), './(app)/settings/index.tsx': routeRow('settings-d', 200) }) => ({
  version: WEB_BOOT_WEIGHT_VERSION, sha, bytes: 1000,
  boot: { modules, bytes: 500, brotliBytes: 100, files: [{ kind: 'script', file: '_expo/static/js/web/entry.js', modules, bytes: 500, brotliBytes: 100 }], routes }, ...extra });

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

test('the PR diff lists each route whose own chunk changed against the base, and the full table on request', () => {
  const base = measurement('a'.repeat(40), 10);
  const candidate = measurement('b'.repeat(40), 10, {}, { './(app)/index.tsx': routeRow('index-c', 100),
    './(app)/settings/index.tsx': routeRow('settings-f', 260), './(app)/boards/index.tsx': routeRow('boards-g', 40) });
  const { markdown } = compareWebBootWeight(candidate, base);
  assert.match(markdown, /Routes whose own chunk changed: 2 of 3/);
  assert.match(markdown, /\| `\.\/\(app\)\/settings\/index\.tsx` \| 200 \| 260 \| 60 \| 20 \| 26 \|/);
  assert.match(markdown, /\| `\.\/\(app\)\/boards\/index\.tsx` \| unavailable \| 40 \| unavailable \|/);
  assert.doesNotMatch(markdown, /`\.\/\(app\)\/index\.tsx` \|/, 'an unchanged route stays out of the PR comment');
  const full = compareWebBootWeight(candidate, base, { allRoutes: true }).markdown;
  assert.match(full, /\| `\.\/\(app\)\/index\.tsx` \| `index-c\.js` \| 2 \| 100 \| 10 \| `__common-e\.js` \|/);
  // A baseline measured before routes existed shows this commit only.
  assert.match(compareWebBootWeight(candidate, null).markdown, /Routes: 3; no exact-base route measurement/);
});
