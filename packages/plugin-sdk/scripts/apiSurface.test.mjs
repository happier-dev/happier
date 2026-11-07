import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

import {
  ApiSurfaceValidationError,
  createApiSurfaceGenerationPlan,
  projectPublishedApiSurfaceInventory,
  projectApiSurfaceInventory,
  readValidatedApiSurfaceInventory,
  validateApiSurfaceInventory,
} from './apiSurface.mjs';
import { readCurrentApiSurfaceInventory } from './apiSurfaceCli.mjs';

test('public package resolution rejects retired host and first-party facades', () => {
  const require = createRequire(import.meta.url);
  for (const specifier of [
    'host/registration', 'host/fs/json-owner-file-lock', 'host/ui',
    'first-party/claude', 'first-party/connected-accounts',
  ]) {
    assert.throws(() => require.resolve(`@happier-dev/plugin-sdk/${specifier}`), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
  }
  for (const specifier of ['', '/actions', '/testing']) {
    assert.equal(typeof require.resolve(`@happier-dev/plugin-sdk${specifier}`), 'string');
  }
});

test('runtime entrypoint follows additions and removals in the authored export list without regeneration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sdk-export-owner-'));
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    const plan = createApiSurfaceGenerationPlan(validInventory({
      symbols: [{ ...AUTHOR_SYMBOL, kind: 'value' }],
    }));
    await writeFile(join(root, 'index.js'), plan.sourceBarrels['src/actions/index.ts']);
    await writeFile(join(root, 'service.js'), 'export const ActionsService = 1;\nexport const CurrentActionsService = 2;\n');
    await writeFile(join(root, 'index.public.js'), "export { ActionsService } from './service.js';\n");
    const readExports = () => {
      const result = spawnSync(process.execPath, [
        '--input-type=module', '-e',
        "import * as api from './index.js'; console.log(JSON.stringify(api));",
      ], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.deepEqual(readExports(), { ActionsService: 1 });
    await writeFile(join(root, 'index.public.js'), "export { CurrentActionsService } from './service.js';\n");
    assert.deepEqual(readExports(), { CurrentActionsService: 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('collection declaration projection is author-visible from its canonical definition owner', () => {
  const inventory = validateApiSurfaceInventory(validInventory({
    entrypoints: [AUTHOR_ENTRYPOINT, {
      specifier: './collections',
      sourceModule: 'src/collections/index.ts',
      visibility: 'author',
      realm: 'any',
      conditions: { types: './dist/collections/index.d.ts', default: './dist/collections/index.js' },
    }],
    symbols: [AUTHOR_SYMBOL, {
      specifier: './collections',
      exportName: 'projectPluginAccountCollectionDeclaration',
      sourceExport: 'projectPluginAccountCollectionDeclaration',
      sourceModule: 'src/definePlugin.ts',
      realm: 'any',
      kind: 'value',
    }],
  }));
  assert.equal(inventory.symbols.some(({ specifier, exportName }) => (
    specifier === './collections' && exportName === 'projectPluginAccountCollectionDeclaration'
  )), true);
});

const AUTHOR_ENTRYPOINT = Object.freeze({
  specifier: './actions',
  sourceModule: 'src/actions/index.ts',
  visibility: 'author',
  realm: 'any',
  conditions: Object.freeze({
    types: './dist/actions/index.d.ts',
    default: './dist/actions/index.js',
  }),
});

const AUTHOR_SYMBOL = Object.freeze({
  specifier: './actions',
  exportName: 'ActionsService',
  kind: 'type',
  sourceModule: 'src/actions/service.ts',
  sourceExport: 'ActionsService',
  realm: 'any',
});

function validInventory(overrides = {}) {
  return {
    schemaVersion: 1,
    entrypoints: [
      AUTHOR_ENTRYPOINT,
    ],
    symbols: [
      AUTHOR_SYMBOL,
    ],
    ...overrides,
  };
}

test('validated inventory file reading rejects duplicate author and host specifiers', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-api-surface-reader-'));
  const fixturePath = join(fixtureRoot, 'api-surface.json');
  try {
    await writeFile(fixturePath, JSON.stringify(validInventory({
      entrypoints: [
        AUTHOR_ENTRYPOINT,
        {
          ...AUTHOR_ENTRYPOINT,
          visibility: 'host',
          realm: 'daemon',
        }
      ],
    })));

    await assert.rejects(
      readValidatedApiSurfaceInventory(fixturePath),
      (error) => error instanceof ApiSurfaceValidationError
        && error.diagnostics.includes('duplicate entrypoint specifier ./actions'),
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('validated inventory file reading rejects retired per-symbol posture metadata', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-api-surface-reader-'));
  const fixturePath = join(fixtureRoot, 'api-surface.json');
  try {
    await writeFile(fixturePath, JSON.stringify(validInventory({
      symbols: [
        { ...AUTHOR_SYMBOL, stability: 'stable' }
      ],
    })));

    await assert.rejects(
      readValidatedApiSurfaceInventory(fixturePath),
      (error) => error instanceof ApiSurfaceValidationError
        && error.diagnostics.includes('symbols[0] has unknown property stability'),
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('generic Agent publication source excludes Claude-specific policy', async () => {
  const [publicSpec, declarations] = await Promise.all([
    readFile(new URL('../src/agents/index.public.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/agents.ts', import.meta.url), 'utf8'),
  ]);
  for (const name of [
    'CLAUDE_EFFORT_LEVELS',
    'CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE',
    'ClaudeEffortLevel',
    'buildClaudeModelOptions',
    'formatClaudeEffortLevelLabel',
    'normalizeClaudeEffortLevel',
  ]) {
    const pattern = new RegExp(`\\b${name}\\b`, 'u');
    assert.doesNotMatch(publicSpec, pattern);
    assert.doesNotMatch(declarations, pattern);
  }
});

test('Session target authoring has one public owner beside its canonical schema', async () => {
  const publications = await Promise.all(['actions', 'sessions'].map(async (entrypoint) => {
    const path = `../src/${entrypoint}/index.public.ts`;
    const source = ts.createSourceFile(path, await readFile(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest);
    return source.statements.flatMap((statement) => (
      ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map(({ name }) => ({ entrypoint, name: name.text }))
        : []
    ));
  }));

  for (const name of [
    'SessionTargetV1', 'SessionTargetSelectorV1', 'ActionSessionTargetDeclarationV1',
    'SessionTargetV1Schema', 'ActionSessionAddressV1', 'ActionSessionAddressV1Schema',
  ]) {
    assert.deepEqual(
      publications.flat().filter((publication) => publication.name === name),
      [{ entrypoint: 'sessions', name }],
      `${name} must be published only through /sessions`,
    );
  }
});

test('checked schema fixes the approved package-owned inventory vocabulary', async () => {
  const schema = JSON.parse(await readFile(new URL('../api-surface.schema.json', import.meta.url), 'utf8'));

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.$defs.entrypoint.properties.visibility.enum, ['author']);
  assert.deepEqual(
    schema.$defs.realm.enum,
    ['any', 'browser', 'react-native', 'client', 'daemon', 'build'],
  );
  assert.deepEqual(schema.$defs.symbol.properties.kind.enum, ['type', 'value']);
  assert.equal(schema.$defs.symbol.properties.stability, undefined);
  assert.deepEqual(schema.$defs.symbol.properties.since, {
    type: 'string',
    pattern: '^[0-9A-Za-z][0-9A-Za-z.+-]*$',
  });
  assert.deepEqual(schema.$defs.symbol.dependentRequired, {
    replacement: ['removalCondition'],
    removalCondition: ['replacement'],
  });
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.entrypoint.additionalProperties, false);
  assert.equal(schema.$defs.symbol.additionalProperties, false);
  assert.equal(
    schema.$defs.entrypoint.allOf[0].then.properties.specifier.not.pattern,
    '^\\./(?:experimental|internal|host|first-party)(?:/|$)',
  );

});

test('projects structured deprecation without per-symbol posture metadata', () => {
  const inventory = validateApiSurfaceInventory(validInventory({
    symbols: [
      {
        ...AUTHOR_SYMBOL,
        replacement: 'CurrentActionsService',
        removalCondition: 'the documented migration completes',
      }
    ],
  }));
  const generated = createApiSurfaceGenerationPlan(inventory);

  assert.equal(Object.hasOwn(inventory.symbols[0], 'stability'), false);
  assert.equal(inventory.symbols[0].replacement, 'CurrentActionsService');
  assert.equal(inventory.symbols[0].removalCondition, 'the documented migration completes');
  assert.doesNotMatch(generated.sourceBarrels['src/actions/index.ts'], /@preview|@experimental|@stable/u);
  assert.equal(generated.sourceBarrels['src/actions/index.ts'], "export * from './index.public.js';\n");
  assert.match(generated.authorApiMarkdown, /> This package is Developer Preview\./u);
  assert.doesNotMatch(generated.authorApiMarkdown, /\| Stability \||\| preview \|/u);
});

test('derives symbol @since from the immediately previous retained published inventory', () => {
  const firstPublished = projectPublishedApiSurfaceInventory({
    inventory: validInventory(),
    publishedVersion: '0.1.0',
  });
  const newlyPublishedSymbol = {
    ...AUTHOR_SYMBOL,
    exportName: 'CurrentActionsService',
    sourceExport: 'CurrentActionsService',
  };

  const nextPublished = projectPublishedApiSurfaceInventory({
    inventory: validInventory({
      symbols: [
        AUTHOR_SYMBOL,
        newlyPublishedSymbol
      ],
    }),
    publishedVersion: '0.2.0',
    previousPublishedInventory: firstPublished,
  });

  assert.equal(
    nextPublished.symbols.find((symbol) => symbol.exportName === 'ActionsService')?.since,
    '0.1.0',
  );
  assert.equal(
    nextPublished.symbols.find((symbol) => symbol.exportName === 'CurrentActionsService')?.since,
    '0.2.0',
  );

  const generated = createApiSurfaceGenerationPlan(nextPublished);
  assert.equal(generated.sourceBarrels['src/actions/index.ts'], "export * from './index.public.js';\n");
  assert.match(
    generated.authorApiMarkdown,
    /\| Specifier \| Export \| Kind \| Realm \| Since \|/u,
  );
  assert.match(
    generated.authorApiMarkdown,
    /\| `\.\/actions` \| `CurrentActionsService` \| type \| any \| 0\.2\.0 \|/u,
  );
});

test('composes publication-derived @since with structured deprecation', () => {
  const published = projectPublishedApiSurfaceInventory({
    inventory: validInventory({
      symbols: [
        {
          ...AUTHOR_SYMBOL,
          replacement: 'CurrentActionsService',
          removalCondition: 'the documented migration completes',
        }
      ],
    }),
    publishedVersion: '0.1.0',
  });

  assert.deepEqual(published.symbols.find(({ exportName }) => exportName === 'ActionsService'), {
    ...AUTHOR_SYMBOL,
    since: '0.1.0',
    replacement: 'CurrentActionsService',
    removalCondition: 'the documented migration completes',
  });
});

test('rejects author-supplied @since and incomplete prior published provenance', () => {
  assert.throws(
    () => projectPublishedApiSurfaceInventory({
      inventory: validInventory({
        symbols: [
          { ...AUTHOR_SYMBOL, since: '0.1.0' }
        ],
      }),
      publishedVersion: '0.2.0',
    }),
    /current source inventory symbol \.\/actions:ActionsService must not declare publisher-owned @since/u,
  );

  assert.throws(
    () => projectPublishedApiSurfaceInventory({
      inventory: validInventory(),
      publishedVersion: '0.2.0',
      previousPublishedInventory: validInventory(),
    }),
    /previous published inventory symbol \.\/actions:ActionsService is missing @since/u,
  );

  assert.throws(
    () => projectPublishedApiSurfaceInventory({
      inventory: validInventory(),
      publishedVersion: '0.2.0 */',
    }),
    /publishedVersion must be exact canonical semver/u,
  );
});

test('publication inventory requires exact canonical semver and forbids future prior provenance', () => {
  for (const publishedVersion of ['1.2', 'v1.2.3', '1.2.3+build.1']) {
    assert.throws(
      () => projectPublishedApiSurfaceInventory({
        inventory: validInventory(),
        publishedVersion,
      }),
      /publishedVersion must be exact canonical semver/u,
    );
  }

  const futurePreviousInventory = validInventory({
    symbols: [AUTHOR_SYMBOL].map((symbol) => ({
      ...symbol,
      since: '2.0.0',
    })),
  });
  assert.throws(
    () => projectPublishedApiSurfaceInventory({
      inventory: validInventory(),
      publishedVersion: '1.2.3-preview.1',
      previousPublishedInventory: futurePreviousInventory,
    }),
    /previous published inventory symbol \.\/actions:ActionsService has @since 2\.0\.0 after publishedVersion 1\.2\.3-preview\.1/u,
  );
});
test('projects authored symbols with their structured deprecation', () => {
  const symbol = { ...AUTHOR_SYMBOL, replacement: 'CurrentActionsService', removalCondition: 'migration completes' };
  const inventory = projectApiSurfaceInventory({ entrypoints: [{ specifier: './actions', symbols: [symbol] }] });
  assert.deepEqual(inventory.symbols, [symbol]);
});

test('client inventory entrypoints require browser, React Native, and default outputs', () => {
  const completeConditions = {
    types: './dist/actions/index.d.ts',
    browser: './dist/actions/index.js',
    'react-native': './dist/actions/index.js',
    default: './dist/actions/index.js',
  };

  for (const condition of ['browser', 'react-native', 'default']) {
    const conditions = { ...completeConditions };
    delete conditions[condition];
    assert.throws(
      () => validateApiSurfaceInventory(validInventory({
        entrypoints: [
          { ...AUTHOR_ENTRYPOINT, realm: 'client', conditions }
        ],
      })),
      (error) => error instanceof ApiSurfaceValidationError
        && error.diagnostics.includes(`entrypoints[0] client entrypoint needs ${condition} output`),
      condition,
    );
  }
});

test('the approved errors subpath republishes only the two canonical root error values', () => {
  const entrypoint = (specifier, sourceModule, directory) => ({
    ...AUTHOR_ENTRYPOINT, specifier, sourceModule,
    conditions: { types: `./dist/${directory}index.d.ts`, default: `./dist/${directory}index.js` },
  });
  const symbols = ['PluginError', 'isPluginError'].flatMap(exportName => ['.', './errors'].map(specifier => ({
    specifier, exportName, sourceExport: exportName, sourceModule: 'src/errors.ts', kind: 'value', realm: 'any',
  })));
  const inventory = validInventory({
    entrypoints: [entrypoint('.', 'src/index.ts', ''), entrypoint('./errors', 'src/errors/index.ts', 'errors/')],
    symbols: [...symbols],
  });
  assert.doesNotThrow(() => validateApiSurfaceInventory(inventory));
  for (const replacement of [{ sourceModule: 'src/otherErrors.ts' }, { sourceExport: 'OtherPluginError' }, { kind: 'type' }]) {
    assert.throws(() => validateApiSurfaceInventory({ ...inventory, symbols: inventory.symbols.map(symbol => (
      symbol.specifier === './errors' && symbol.exportName === 'PluginError' ? { ...symbol, ...replacement } : symbol
    )) }), ApiSurfaceValidationError, 'a duplicate name must retain the exact existing implementation');
  }
});

test('the preparation schema leaf preserves its identical public root contract', () => {
  const exportName = 'DeploymentTargetPreparationBaseV1ProtocolSchema';
  const inventory = validInventory({
    entrypoints: [
      { ...AUTHOR_ENTRYPOINT, specifier: '.', sourceModule: 'src/index.ts',
        conditions: { types: './dist/index.d.ts', default: './dist/index.js' } },
      { ...AUTHOR_ENTRYPOINT, specifier: './protocol', sourceModule: 'src/protocol/index.ts',
        conditions: { types: './dist/protocol/index.d.ts', default: './dist/protocol/index.js' } },
    ],
    symbols: ['.', './protocol'].map(specifier => ({
      specifier, exportName, sourceExport: exportName, sourceModule: 'src/deploymentTargets.ts', kind: 'value', realm: 'any',
    })),
  });
  assert.doesNotThrow(() => validateApiSurfaceInventory(inventory));
  for (const replacement of [{ sourceModule: 'src/otherTargets.ts' }, { sourceExport: 'OtherPreparation' }, { kind: 'type' }]) {
    assert.throws(() => validateApiSurfaceInventory({ ...inventory, symbols: inventory.symbols.map(symbol => (
      symbol.specifier === './protocol' ? { ...symbol, ...replacement } : symbol
    )) }), ApiSurfaceValidationError);
  }
});

test('inventory validation owns uniqueness, audience, deprecation, and canonical source rules', () => {
  assert.throws(
    () => validateApiSurfaceInventory(validInventory({
      entrypoints: [
        AUTHOR_ENTRYPOINT,
        {
          ...AUTHOR_ENTRYPOINT,
          specifier: './mcp',
          sourceModule: 'src/mcp/index.ts',
          conditions: {
            types: './dist/mcp/index.d.ts',
            default: './dist/mcp/index.js',
          },
        }
      ],
      symbols: [
        AUTHOR_SYMBOL,
        {
          ...AUTHOR_SYMBOL,
          specifier: './mcp',
          sourceModule: 'src/mcp/service.ts',
        }
      ],
    })),
    (error) => error instanceof ApiSurfaceValidationError
      && error.diagnostics.some((diagnostic) => diagnostic.includes('author-visible name ActionsService')),
  );

  assert.throws(
    () => validateApiSurfaceInventory(validInventory({
      symbols: [
        { ...AUTHOR_SYMBOL, stability: 'preview' }
      ],
    })),
    (error) => error instanceof ApiSurfaceValidationError
      && error.diagnostics.some((diagnostic) => diagnostic.includes('unknown property stability')),
  );

  assert.throws(
    () => validateApiSurfaceInventory(validInventory({
      entrypoints: [
        AUTHOR_ENTRYPOINT,
        {
          ...AUTHOR_ENTRYPOINT,
          specifier: './mcp',
        }
      ],
      symbols: [
        AUTHOR_SYMBOL,
        {
          ...AUTHOR_SYMBOL,
          specifier: './mcp',
          exportName: 'McpService',
          sourceExport: 'McpService',
        }
      ],
    })),
    (error) => error instanceof ApiSurfaceValidationError
      && error.diagnostics.includes(
        'entrypoint sourceModule src/actions/index.ts is owned by both ./actions and ./mcp',
      ),
  );

  assert.throws(
    () => validateApiSurfaceInventory(validInventory({
      entrypoints: [
        AUTHOR_ENTRYPOINT,
        {
          ...AUTHOR_ENTRYPOINT,
          specifier: './mcp',
          sourceModule: 'src/Actions/index.ts',
        }
      ],
      symbols: [
        AUTHOR_SYMBOL,
        {
          ...AUTHOR_SYMBOL,
          specifier: './mcp',
          exportName: 'McpService',
          sourceExport: 'McpService',
          sourceModule: 'src/Actions/service.ts',
        }
      ],
    })),
    (error) => error instanceof ApiSurfaceValidationError
      && error.diagnostics.includes(
        'entrypoint sourceModule src/Actions/index.ts has a case-insensitive collision with src/actions/index.ts',
      ),
  );
});

test('author inventory rejects retired/private specifier namespaces and host source owners', () => {
  for (const specifier of ['./experimental/actions', './internal/actions', './host/registration', './first-party/claude', './first-party/connected-accounts']) {
    assert.throws(
      () => validateApiSurfaceInventory(validInventory({
        entrypoints: [
          { ...AUTHOR_ENTRYPOINT, specifier }
        ],
        symbols: [
          { ...AUTHOR_SYMBOL, specifier }
        ],
      })),
      (error) => error instanceof ApiSurfaceValidationError
        && error.diagnostics.includes(
          `entrypoints[0] author entrypoint cannot use reserved namespace ${specifier}`,
        ),
    );
  }

  assert.throws(
    () => validateApiSurfaceInventory(validInventory({
      symbols: [
        { ...AUTHOR_SYMBOL, sourceModule: 'src/host/actions/service.ts' }
      ],
    })),
    (error) => error instanceof ApiSurfaceValidationError
      && error.diagnostics.includes(
        'symbols[0] author symbol cannot project a src/host/** source owner',
      ),
  );

  assert.doesNotThrow(
    () => validateApiSurfaceInventory(validInventory({
      symbols: [
        {
          ...AUTHOR_SYMBOL,
          exportName: 'createPluginRegistrationScope',
          sourceExport: 'createPluginRegistrationScope',
          kind: 'value',
        }
      ],
    })),
  );
});

test('one generation plan publishes only author package seams', () => {
  const inventory = validateApiSurfaceInventory(validInventory());
  const generated = createApiSurfaceGenerationPlan(inventory);

  assert.deepEqual(Object.keys(generated.packageExports), [
    './actions',
  ]);
  assert.doesNotMatch(generated.sourceBarrels['src/actions/index.ts'], /@preview|@experimental|@stable/u);
  assert.equal(generated.sourceBarrels['src/actions/index.ts'], "export * from './index.public.js';\n");
  assert.deepEqual(generated.authorDeclarationAssertions, {
    './actions': ['ActionsService'],
  });
  assert.deepEqual(generated.testkitAssertions, {
    './actions': ['ActionsService'],
  });
  assert.match(
    generated.authorApiMarkdown,
    /> This package is Developer Preview\./u,
  );
  assert.match(
    generated.authorApiMarkdown,
    /`capability-matrix\.json` records realm-specific public-family availability separately from optional consumer and loaded proof\./u,
  );
  assert.match(generated.authorApiMarkdown, /ActionsService/u);
  assert.doesNotMatch(generated.authorApiMarkdown, /createPluginRegistrationScope/u);
  assert.doesNotMatch(generated.authorApiMarkdown, /withJsonOwnerFileLock/u);
});

test('generation exposes canonical source entries before packaged realm conditions', async () => {
  const inventory = await readCurrentApiSurfaceInventory();
  const generated = createApiSurfaceGenerationPlan(inventory);

  assert.deepEqual(Object.keys(generated.packageExports['.']), ['happier-source', 'types', 'browser', 'default']);
  assert.deepEqual(
    Object.keys(generated.packageExports['./ui/client']),
    ['happier-source', 'types', 'browser', 'default'],
  );
  assert.deepEqual(
    Object.keys(generated.packageExports['./voice/client']),
    ['happier-source', 'types', 'browser', 'react-native', 'default'],
  );
  assert.deepEqual(
    Object.keys(generated.packageExports['./scm/backend']),
    ['happier-source', 'types', 'default'],
  );

  assert.deepEqual(generated.packageExports['./protocol'].browser, {
    'happier-source': './src/protocol/index.browser.ts',
    default: './dist/protocol/index.browser.js',
  });
  for (const specifier of ['./ui/client', './voice/client']) {
    const entrypoint = inventory.entrypoints.find((entry) => entry.specifier === specifier);
    for (const condition of ['browser', 'react-native']) {
      const runtimeTarget = entrypoint.conditions[condition];
      if (!runtimeTarget) continue;
      assert.deepEqual(generated.packageExports[specifier][condition], {
        'happier-source': `./${entrypoint.sourceModule}`,
        default: runtimeTarget,
      });
    }
  }

  for (const [specifier, conditions] of Object.entries(generated.packageExports)) {
    assert.equal(conditions['happier-source'], `./${inventory.entrypoints.find((entry) => entry.specifier === specifier).sourceModule}`);
    assert.equal(
      Object.keys(conditions).at(-1),
      'default',
      `${specifier} must keep default as its last matching condition`,
    );
  }
});

test('generation projects split browser barrels from canonical symbol realms', () => {
  const realms = ['any', 'browser', 'client', 'react-native', 'daemon', 'build'];
  const generated = createApiSurfaceGenerationPlan(validInventory({
    entrypoints: [{
      ...AUTHOR_ENTRYPOINT,
      conditions: {
        ...AUTHOR_ENTRYPOINT.conditions,
        browser: './dist/actions/index.browser.js',
      },
    }],
    symbols: [
      ...realms.map((realm) => ({
        ...AUTHOR_SYMBOL,
        exportName: `${realm.replace('-', '')}Service`,
        realm,
      }))
    ],
  }));

  assert.equal(generated.sourceBarrels['src/actions/index.browser.ts'], [
    "export type { ActionsService as anyService } from './service.js';",
    "export type { ActionsService as browserService } from './service.js';",
    "export type { ActionsService as clientService } from './service.js';",
    '',
  ].join('\n'));
  assert.equal(generated.sourceBarrels['src/actions/index.ts'], "export * from './index.public.js';\n");
});

test('generation is deterministic regardless of inventory row ordering', () => {
  const forward = createApiSurfaceGenerationPlan(validateApiSurfaceInventory(validInventory()));
  const reverse = createApiSurfaceGenerationPlan(validateApiSurfaceInventory(validInventory({
    entrypoints: [...validInventory().entrypoints].reverse(),
    symbols: [...validInventory().symbols].reverse(),
  })));

  assert.deepEqual(reverse, forward);
});

test('generation uses locale-independent code-point ordering for emitted symbols', () => {
  const generated = createApiSurfaceGenerationPlan(validateApiSurfaceInventory(validInventory({
    symbols: [
      {
        ...AUTHOR_SYMBOL,
        exportName: 'aService',
        sourceExport: 'aService',
      },
      {
        ...AUTHOR_SYMBOL,
        exportName: 'AService',
        sourceExport: 'AService',
      }
    ],
  })));

  assert.deepEqual(generated.authorDeclarationAssertions['./actions'], ['AService', 'aService']);
});
