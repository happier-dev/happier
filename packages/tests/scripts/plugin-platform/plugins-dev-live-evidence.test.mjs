import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePluginsDevChangeLine } from './plugins-dev-live-evidence.mjs';

test('parses only complete plugins_dev_change JSON envelopes', () => {
  assert.equal(parsePluginsDevChangeLine('installing dependencies...'), null);
  assert.equal(parsePluginsDevChangeLine('{"ok":true,"kind":"plugins_dev"}'), null);
  assert.deepEqual(
    parsePluginsDevChangeLine('{"ok":true,"kind":"plugins_dev_change","data":{"observedFiles":4}}'),
    { ok: true, kind: 'plugins_dev_change', data: { observedFiles: 4 } },
  );
  assert.deepEqual(
    parsePluginsDevChangeLine('{"ok":false,"kind":"plugins_dev_change","error":{"code":"plugin_dev_candidate_rejected"}}'),
    {
      ok: false,
      kind: 'plugins_dev_change',
      error: { code: 'plugin_dev_candidate_rejected' },
    },
  );
});

test('rejects malformed plugins_dev_change envelopes instead of losing stream evidence', () => {
  assert.throws(
    () => parsePluginsDevChangeLine('{"kind":"plugins_dev_change","data":{}}'),
    /must carry a boolean ok result/u,
  );
  assert.throws(
    () => parsePluginsDevChangeLine('{"ok":true,"kind":"plugins_dev_change"}'),
    /successful .* envelope is missing data/iu,
  );
  assert.throws(
    () => parsePluginsDevChangeLine('{"ok":false,"kind":"plugins_dev_change"}'),
    /failed .* envelope is missing error/iu,
  );
});
