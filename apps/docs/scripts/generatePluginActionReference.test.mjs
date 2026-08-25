import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderPluginActionReferenceMarkdown } from './generatePluginActionReference.mjs';
import { GENERATORS } from './generateReference.mjs';

test('the docs generator registry owns the published Plugin host Action reference', () => {
  const expectedOutput = fileURLToPath(
    new URL('../content/docs/plugins/api/host-actions.mdx', import.meta.url),
  );

  assert.equal(
    GENERATORS.filter((generator) => generator.outputPath === expectedOutput).length,
    1,
    'host-actions.mdx must have exactly one registered docs generator',
  );
});

test('the Action reference prepares the canonical built Protocol owner before loading it', async () => {
  const events = [];
  const rendered = await renderPluginActionReferenceMarkdown({
    ensureWorkspacePackagesBuiltByName: async (_root, packageNames, options) => {
      events.push(`prepare:${packageNames.join(',')}`);
      assert.equal(options.force, true, 'the published reference must render from a fresh Protocol build');
    },
    loadRenderer: async () => {
      events.push('load');
      return { renderPluginActionReferenceMarkdown: () => '# Actions\n' };
    },
  });

  assert.equal(rendered, '# Actions\n');
  assert.deepEqual(events, ['prepare:@happier-dev/protocol', 'load']);
});
