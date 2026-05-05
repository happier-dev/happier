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
    moves.get('apps/cli/src/plugins/plugins/store/pluginStateStore.ts'),
    'apps/cli/src/plugins/store/state.ts',
  );
  assert.equal(
    moves.get('apps/cli/src/plugins/plugins/install/installPluginFromSource.ts'),
    'apps/cli/src/plugins/install/source.ts',
  );
  assert.equal(
    moves.get('apps/cli/src/plugins/plugins/catalog/marketplaceCatalog.ts'),
    'apps/cli/src/plugins/marketplace/catalog.ts',
  );
  assert.equal(
    moves.get('apps/cli/src/plugins/plugins/loader/loadInstalledPlugins.ts'),
    'apps/cli/src/plugins/load/installed.ts',
  );
  assert.equal(
    moves.get('apps/cli/src/plugins/plugins/testkit/samplePluginFixture.ts'),
    'apps/cli/src/plugins/testkit/samplePackage.ts',
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
    rulesByFrom.get('@/plugins/plugins/store/pluginStateStore'),
    '@/plugins/store/state',
  );
  assert.equal(
    rulesByFrom.get('@/plugins/plugins/shared/resolvePluginDaemonEntryPath'),
    '@/plugins/manifest/daemonEntry',
  );
  assert.equal(
    rulesByFrom.get('@/plugins/plugins/catalog/pluginCatalog'),
    '@/plugins/catalog/installed',
  );
});

test('extension unification validation reports forbidden old paths', () => {
  const findings = collectForbiddenExtensionUnificationFindings([
    {
      filePath: 'apps/cli/src/cli/commands/plugins.ts',
      content: "import { readInstalledPluginCatalog } from '@/plugins/plugins/catalog/pluginCatalog';\n",
    },
    {
      filePath: 'apps/cli/src/plugins/store/state.ts',
      content: "import { readInstalledPluginCatalog } from '@/plugins/catalog/installed';\n",
    },
  ]);

  assert.deepEqual(findings, [
    {
      filePath: 'apps/cli/src/cli/commands/plugins.ts',
      pattern: '@/plugins/plugins/catalog/pluginCatalog',
      replacement: '@/plugins/catalog/installed',
    },
  ]);
});

test('extension unification import rewrite planner rewrites old packaging imports', () => {
  const plan = planExtensionUnificationImportRewrites([
    {
      filePath: 'apps/cli/src/cli/commands/plugins.ts',
      content: "import { readInstalledPluginCatalog } from '@/plugins/plugins/catalog/pluginCatalog';\n",
    },
    {
      filePath: 'apps/cli/src/plugins/catalog/installed.ts',
      content: "import { createPluginStateStore } from '../store/pluginStateStore';\n",
    },
    {
      filePath: 'apps/cli/src/agent/runtime/registry/engineRegistry.test.ts',
      content: "import { createPluginStateStore } from '../../../plugins/plugins/store/pluginStateStore';\n",
    },
  ]);

  assert.deepEqual(
    plan.edits.map((edit) => [edit.filePath, edit.after]),
    [
      [
        'apps/cli/src/cli/commands/plugins.ts',
        "import { readInstalledPluginCatalog } from '@/plugins/catalog/installed';\n",
      ],
      [
        'apps/cli/src/plugins/catalog/installed.ts',
        "import { createPluginStateStore } from '../store/state';\n",
      ],
      [
        'apps/cli/src/agent/runtime/registry/engineRegistry.test.ts',
        "import { createPluginStateStore } from '../../../plugins/store/state';\n",
      ],
    ],
  );
});
