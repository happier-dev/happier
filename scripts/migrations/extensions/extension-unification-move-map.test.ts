import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTENSION_UNIFICATION_MOVE_MAP,
  buildExtensionUnificationRewriteRules,
  collectForbiddenExtensionUnificationFindings,
} from './extension-unification-move-map.ts';
import { planExtensionUnificationImportRewrites } from './rewrite-extension-imports.ts';

test('extension unification move map includes the CLI packaging lane moves', () => {
  const moves = new Map(EXTENSION_UNIFICATION_MOVE_MAP.map((entry) => [entry.from, entry.to]));

  assert.equal(
    moves.get('apps/cli/src/extensions/plugins/store/pluginStateStore.ts'),
    'apps/cli/src/extensions/store/state.ts',
  );
  assert.equal(
    moves.get('apps/cli/src/extensions/plugins/install/installPluginFromSource.ts'),
    'apps/cli/src/extensions/install/source.ts',
  );
  assert.equal(
    moves.get('apps/cli/src/extensions/plugins/catalog/marketplaceCatalog.ts'),
    'apps/cli/src/extensions/marketplace/catalog.ts',
  );
  assert.equal(
    moves.get('apps/cli/src/extensions/plugins/loader/loadInstalledPlugins.ts'),
    'apps/cli/src/extensions/load/installed.ts',
  );
  assert.equal(
    moves.get('apps/cli/src/extensions/plugins/testkit/samplePluginFixture.ts'),
    'apps/cli/src/extensions/testkit/samplePackage.ts',
  );
  assert.equal(
    EXTENSION_UNIFICATION_MOVE_MAP.some((entry) => entry.to.includes('/plugins/')),
    false,
  );
});

test('extension unification rewrite rules rewrite old absolute plugin packaging imports', () => {
  const rules = buildExtensionUnificationRewriteRules();
  const rulesByFrom = new Map(rules.map((rule) => [rule.from, rule.to]));

  assert.equal(
    rulesByFrom.get('@/extensions/plugins/store/pluginStateStore'),
    '@/extensions/store/state',
  );
  assert.equal(
    rulesByFrom.get('@/extensions/plugins/shared/resolvePluginDaemonEntryPath'),
    '@/extensions/manifest/daemonEntry',
  );
  assert.equal(
    rulesByFrom.get('@/extensions/plugins/catalog/pluginCatalog'),
    '@/extensions/catalog/installed',
  );
});

test('extension unification validation reports forbidden old paths', () => {
  const findings = collectForbiddenExtensionUnificationFindings([
    {
      filePath: 'apps/cli/src/cli/commands/plugins.ts',
      content: "import { readInstalledPluginCatalog } from '@/extensions/plugins/catalog/pluginCatalog';\n",
    },
    {
      filePath: 'apps/cli/src/extensions/store/state.ts',
      content: "import { readInstalledPluginCatalog } from '@/extensions/catalog/installed';\n",
    },
  ]);

  assert.deepEqual(findings, [
    {
      filePath: 'apps/cli/src/cli/commands/plugins.ts',
      pattern: '@/extensions/plugins/catalog/pluginCatalog',
      replacement: '@/extensions/catalog/installed',
    },
  ]);
});

test('extension unification import rewrite planner rewrites old packaging imports', () => {
  const plan = planExtensionUnificationImportRewrites([
    {
      filePath: 'apps/cli/src/cli/commands/plugins.ts',
      content: "import { readInstalledPluginCatalog } from '@/extensions/plugins/catalog/pluginCatalog';\n",
    },
    {
      filePath: 'apps/cli/src/extensions/catalog/installed.ts',
      content: "import { createPluginStateStore } from '../store/pluginStateStore';\n",
    },
    {
      filePath: 'apps/cli/src/agent/runtime/registry/engineRegistry.test.ts',
      content: "import { createPluginStateStore } from '../../../extensions/plugins/store/pluginStateStore';\n",
    },
  ]);

  assert.deepEqual(
    plan.edits.map((edit) => [edit.filePath, edit.after]),
    [
      [
        'apps/cli/src/cli/commands/plugins.ts',
        "import { readInstalledPluginCatalog } from '@/extensions/catalog/installed';\n",
      ],
      [
        'apps/cli/src/extensions/catalog/installed.ts',
        "import { createPluginStateStore } from '../store/state';\n",
      ],
      [
        'apps/cli/src/agent/runtime/registry/engineRegistry.test.ts',
        "import { createPluginStateStore } from '../../../extensions/store/state';\n",
      ],
    ],
  );
});
