import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ApiSurfaceValidationError,
  createApiSurfaceGenerationPlan,
  projectPublishedApiSurfaceInventory,
  projectApiSurfaceInventory,
  readValidatedApiSurfaceInventory,
  validateApiSurfaceInventory,
} from './apiSurface.mjs';

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

const HOST_REGISTRATION_ENTRYPOINT = Object.freeze({
  specifier: './host/registration',
  sourceModule: 'src/host/registration/index.ts',
  visibility: 'host',
  realm: 'any',
  conditions: Object.freeze({
    types: './dist/host/registration/index.d.ts',
    browser: './dist/host/registration/index.js',
    'react-native': './dist/host/registration/index.js',
    default: './dist/host/registration/index.js',
  }),
});

const HOST_FILE_LOCK_ENTRYPOINT = Object.freeze({
  specifier: './host/fs/json-owner-file-lock',
  sourceModule: 'src/host/fs/json-owner-file-lock/index.ts',
  visibility: 'host',
  realm: 'daemon',
  conditions: Object.freeze({
    types: './dist/host/fs/json-owner-file-lock/index.d.ts',
    default: './dist/host/fs/json-owner-file-lock/index.js',
  }),
});

const HOST_TARGETED_CONTRIBUTIONS_ENTRYPOINT = Object.freeze({
  specifier: './host/targeted-contributions',
  sourceModule: 'src/host/targeted-contributions/index.ts',
  visibility: 'host',
  realm: 'daemon',
  conditions: Object.freeze({
    types: './dist/host/targeted-contributions/index.d.ts',
    default: './dist/host/targeted-contributions/index.js',
  }),
});

const HOST_ENTRYPOINTS = Object.freeze([
  HOST_REGISTRATION_ENTRYPOINT,
  HOST_FILE_LOCK_ENTRYPOINT,
  HOST_TARGETED_CONTRIBUTIONS_ENTRYPOINT,
]);

const AUTHOR_SYMBOL = Object.freeze({
  specifier: './actions',
  exportName: 'ActionsService',
  kind: 'type',
  sourceModule: 'src/actions/service.ts',
  sourceExport: 'ActionsService',
  realm: 'any',
});

const HOST_REGISTRATION_SYMBOL = Object.freeze({
  specifier: './host/registration',
  exportName: 'createPluginRegistrationScope',
  kind: 'value',
  sourceModule: 'src/host/registration/scope.ts',
  sourceExport: 'createPluginRegistrationScope',
  realm: 'any',
});

const HOST_REGISTRATION_TYPE_SYMBOLS = Object.freeze([
  'PluginRegistrationRight',
  'PluginAgentRuntimeRegistration',
  'PluginRuntimeRegistration',
].map((exportName) => Object.freeze({
  ...HOST_REGISTRATION_SYMBOL,
  exportName,
  kind: 'type',
  sourceExport: exportName,
})));

const HOST_FILE_LOCK_RECLAIM_SYMBOL = Object.freeze({
  specifier: './host/fs/json-owner-file-lock',
  exportName: 'reclaimJsonOwnerFileLockSnapshot',
  kind: 'value',
  sourceModule: 'src/host/fs/jsonOwnerFileLock.ts',
  sourceExport: 'reclaimJsonOwnerFileLockSnapshot',
  realm: 'daemon',
});

const HOST_FILE_LOCK_SYMBOL = Object.freeze({
  specifier: './host/fs/json-owner-file-lock',
  exportName: 'withJsonOwnerFileLock',
  kind: 'value',
  sourceModule: 'src/host/fs/jsonOwnerFileLock.ts',
  sourceExport: 'withJsonOwnerFileLock',
  realm: 'daemon',
});

const HOST_TARGETED_CONTRIBUTIONS_SYMBOL = Object.freeze({
  specifier: './host/targeted-contributions',
  exportName: 'decodeTargetedContributionPointSemantics',
  kind: 'value',
  sourceModule: 'src/targetedContributionAuthoring.ts',
  sourceExport: 'decodeTargetedContributionPointSemantics',
  realm: 'daemon',
});

const HOST_TARGETED_CONTRIBUTIONS_SEMANTIC_REFS_SYMBOL = Object.freeze({
  ...HOST_TARGETED_CONTRIBUTIONS_SYMBOL,
  exportName: 'readTargetedContributionPointSemanticRefs',
  sourceExport: 'readTargetedContributionPointSemanticRefs',
});

const HOST_TARGETED_CONTRIBUTIONS_TYPE_SYMBOLS = Object.freeze([
  'TargetedContributionPointSemanticInput',
  'TargetedContributionPointSemanticOperation',
  'TargetedContributionPointSemanticProjection',
  'TargetedContributionPointSemanticSurface',
].map((exportName) => Object.freeze({
  ...HOST_TARGETED_CONTRIBUTIONS_SYMBOL,
  exportName,
  kind: 'type',
  sourceExport: exportName,
})));

const HOST_SYMBOLS = Object.freeze([
  HOST_REGISTRATION_SYMBOL,
  ...HOST_REGISTRATION_TYPE_SYMBOLS,
  HOST_FILE_LOCK_RECLAIM_SYMBOL,
  HOST_FILE_LOCK_SYMBOL,
  HOST_TARGETED_CONTRIBUTIONS_SYMBOL,
  HOST_TARGETED_CONTRIBUTIONS_SEMANTIC_REFS_SYMBOL,
  ...HOST_TARGETED_CONTRIBUTIONS_TYPE_SYMBOLS,
]);

function validInventory(overrides = {}) {
  return {
    schemaVersion: 1,
    entrypoints: [
      AUTHOR_ENTRYPOINT,
      ...HOST_ENTRYPOINTS,
    ],
    symbols: [
      AUTHOR_SYMBOL,
      ...HOST_SYMBOLS,
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
        },
        ...HOST_ENTRYPOINTS,
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
        { ...AUTHOR_SYMBOL, stability: 'stable' },
        ...HOST_SYMBOLS.map((symbol) => ({ ...symbol, stability: 'host-internal' })),
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

test('checked schema fixes the approved package-owned inventory vocabulary', async () => {
  const schema = JSON.parse(await readFile(new URL('../api-surface.schema.json', import.meta.url), 'utf8'));

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.$defs.entrypoint.properties.visibility.enum, ['author', 'host']);
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
    '^\\./(?:experimental|internal|host)(?:/|$)',
  );
  assert.deepEqual(
    schema.$defs.entrypoint.allOf[1].then.properties.specifier.enum,
    [
      './host/registration',
      './host/fs/json-owner-file-lock',
      './host/targeted-contributions',
    ],
  );
  assert.equal(
    schema.$defs.entrypoint.allOf[2].then.properties.realm.const,
    'any',
  );
  assert.equal(
    schema.$defs.entrypoint.allOf[3].then.properties.realm.const,
    'daemon',
  );
});

test('projects structured deprecation without per-symbol posture metadata', () => {
  const inventory = validateApiSurfaceInventory(validInventory({
    symbols: [
      {
        ...AUTHOR_SYMBOL,
        replacement: 'CurrentActionsService',
        removalCondition: 'the documented migration completes',
      },
      ...HOST_SYMBOLS,
    ],
  }));
  const generated = createApiSurfaceGenerationPlan(inventory);

  assert.equal(Object.hasOwn(inventory.symbols[0], 'stability'), false);
  assert.equal(inventory.symbols[0].replacement, 'CurrentActionsService');
  assert.equal(inventory.symbols[0].removalCondition, 'the documented migration completes');
  assert.doesNotMatch(generated.sourceBarrels['src/actions/index.ts'], /@preview|@experimental|@stable/u);
  assert.match(
    generated.sourceBarrels['src/actions/index.ts'],
    /@deprecated CurrentActionsService; remove when the documented migration completes/u,
  );
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
        newlyPublishedSymbol,
        ...HOST_SYMBOLS,
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
  assert.match(
    generated.sourceBarrels['src/actions/index.ts'],
    /\/\*\* @since 0\.1\.0 \*\/\nexport type \{ ActionsService \}/u,
  );
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
        },
        ...HOST_SYMBOLS,
      ],
    }),
    publishedVersion: '0.1.0',
  });

  assert.match(
    createApiSurfaceGenerationPlan(published).sourceBarrels['src/actions/index.ts'],
    /\/\*\*\n \* @since 0\.1\.0\n \* @deprecated CurrentActionsService; remove when the documented migration completes\n \*\/\nexport type \{ ActionsService \}/u,
  );
});

test('rejects author-supplied @since and incomplete prior published provenance', () => {
  assert.throws(
    () => projectPublishedApiSurfaceInventory({
      inventory: validInventory({
        symbols: [
          { ...AUTHOR_SYMBOL, since: '0.1.0' },
          ...HOST_SYMBOLS,
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
    symbols: [AUTHOR_SYMBOL, ...HOST_SYMBOLS].map((symbol) => ({
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

test('projects the approved daemon-only targeted-contribution semantic decoder host seam', () => {
  const inventory = validateApiSurfaceInventory(validInventory());
  const generated = createApiSurfaceGenerationPlan(inventory);

  assert.deepEqual(generated.packageExports['./host/targeted-contributions'], {
    types: './dist/host/targeted-contributions/index.d.ts',
    default: './dist/host/targeted-contributions/index.js',
  });
  assert.equal(
    generated.sourceBarrels['src/host/targeted-contributions/index.ts'],
    [
      "export type { TargetedContributionPointSemanticInput } from '../../targetedContributionAuthoring.js';",
      "export type { TargetedContributionPointSemanticOperation } from '../../targetedContributionAuthoring.js';",
      "export type { TargetedContributionPointSemanticProjection } from '../../targetedContributionAuthoring.js';",
      "export type { TargetedContributionPointSemanticSurface } from '../../targetedContributionAuthoring.js';",
      "export { decodeTargetedContributionPointSemantics } from '../../targetedContributionAuthoring.js';",
      "export { readTargetedContributionPointSemanticRefs } from '../../targetedContributionAuthoring.js';",
      '',
    ].join('\n'),
  );
});

test('admits the daemon-only targeted-contribution semantic-ref carrier', () => {
  const inventory = validateApiSurfaceInventory(validInventory());

  assert.ok(inventory.symbols.some((symbol) => (
    symbol.specifier === HOST_TARGETED_CONTRIBUTIONS_SEMANTIC_REFS_SYMBOL.specifier
    && symbol.exportName === HOST_TARGETED_CONTRIBUTIONS_SEMANTIC_REFS_SYMBOL.exportName
    && symbol.kind === HOST_TARGETED_CONTRIBUTIONS_SEMANTIC_REFS_SYMBOL.kind
    && symbol.realm === HOST_TARGETED_CONTRIBUTIONS_SEMANTIC_REFS_SYMBOL.realm
  )));
});

test('projects symbols without posture metadata while preserving structured deprecations', () => {
  const inventory = projectApiSurfaceInventory({
    entrypoints: [
      {
        specifier: './actions',
        symbols: [
          {
            exportName: 'LegacyExperimentalAuthorContract',
            kind: 'type',
            sourceModule: 'src/actions/service.ts',
            sourceExport: 'LegacyExperimentalAuthorContract',
            realm: 'any',
          },
          {
            exportName: 'LegacyStableAuthorContract',
            kind: 'type',
            sourceModule: 'src/actions/service.ts',
            sourceExport: 'LegacyStableAuthorContract',
            realm: 'any',
          },
          {
            exportName: 'RetiringAuthorContract',
            kind: 'type',
            sourceModule: 'src/actions/service.ts',
            sourceExport: 'RetiringAuthorContract',
            realm: 'any',
            replacement: 'CurrentAuthorContract',
            removalCondition: 'the documented migration completes',
          },
        ],
      },
      {
        specifier: './host/registration',
        symbols: [
          {
            exportName: 'createPluginRegistrationScope',
            kind: 'value',
            sourceModule: 'src/host/registration/scope.ts',
            sourceExport: 'createPluginRegistrationScope',
            realm: 'any',
          },
          ...HOST_REGISTRATION_TYPE_SYMBOLS.map((symbol) => ({
            ...symbol,
          })),
        ],
      },
      {
        specifier: './host/fs/json-owner-file-lock',
        symbols: HOST_SYMBOLS
          .filter((symbol) => symbol.specifier === './host/fs/json-owner-file-lock'),
      },
      {
        specifier: './host/targeted-contributions',
        symbols: [
          HOST_TARGETED_CONTRIBUTIONS_SYMBOL,
          HOST_TARGETED_CONTRIBUTIONS_SEMANTIC_REFS_SYMBOL,
          ...HOST_TARGETED_CONTRIBUTIONS_TYPE_SYMBOLS,
        ],
      },
    ],
  });

  assert.deepEqual(inventory.symbols.map((symbol) => ({
    exportName: symbol.exportName,
    replacement: symbol.replacement,
    removalCondition: symbol.removalCondition,
  })), [
    {
      exportName: 'LegacyExperimentalAuthorContract',
      replacement: undefined,
      removalCondition: undefined,
    },
    {
      exportName: 'LegacyStableAuthorContract',
      replacement: undefined,
      removalCondition: undefined,
    },
    {
      exportName: 'RetiringAuthorContract',
      replacement: 'CurrentAuthorContract',
      removalCondition: 'the documented migration completes',
    },
    {
      exportName: 'reclaimJsonOwnerFileLockSnapshot',
      replacement: undefined,
      removalCondition: undefined,
    },
    {
      exportName: 'withJsonOwnerFileLock',
      replacement: undefined,
      removalCondition: undefined,
    },
    {
      exportName: 'PluginAgentRuntimeRegistration',
      replacement: undefined,
      removalCondition: undefined,
    },
    {
      exportName: 'PluginRegistrationRight',
      replacement: undefined,
      removalCondition: undefined,
    },
    {
      exportName: 'PluginRuntimeRegistration',
      replacement: undefined,
      removalCondition: undefined,
    },
    {
      exportName: 'createPluginRegistrationScope',
      replacement: undefined,
      removalCondition: undefined,
    },
    {
      exportName: 'TargetedContributionPointSemanticInput',
      replacement: undefined,
      removalCondition: undefined,
    },
    {
      exportName: 'TargetedContributionPointSemanticOperation',
      replacement: undefined,
      removalCondition: undefined,
    },
    {
      exportName: 'TargetedContributionPointSemanticProjection',
      replacement: undefined,
      removalCondition: undefined,
    },
    {
      exportName: 'TargetedContributionPointSemanticSurface',
      replacement: undefined,
      removalCondition: undefined,
    },
    {
      exportName: 'decodeTargetedContributionPointSemantics',
      replacement: undefined,
      removalCondition: undefined,
    },
    {
      exportName: 'readTargetedContributionPointSemanticRefs',
      replacement: undefined,
      removalCondition: undefined,
    },
  ]);
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
          { ...AUTHOR_ENTRYPOINT, realm: 'client', conditions },
          ...HOST_ENTRYPOINTS,
        ],
      })),
      (error) => error instanceof ApiSurfaceValidationError
        && error.diagnostics.includes(`entrypoints[0] client entrypoint needs ${condition} output`),
      condition,
    );
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
        },
        ...HOST_ENTRYPOINTS,
      ],
      symbols: [
        AUTHOR_SYMBOL,
        {
          ...AUTHOR_SYMBOL,
          specifier: './mcp',
          sourceModule: 'src/mcp/service.ts',
        },
        ...HOST_SYMBOLS,
      ],
    })),
    (error) => error instanceof ApiSurfaceValidationError
      && error.diagnostics.some((diagnostic) => diagnostic.includes('author-visible name ActionsService')),
  );

  assert.throws(
    () => validateApiSurfaceInventory(validInventory({
      symbols: [
        { ...AUTHOR_SYMBOL, stability: 'preview' },
        ...HOST_SYMBOLS,
      ],
    })),
    (error) => error instanceof ApiSurfaceValidationError
      && error.diagnostics.some((diagnostic) => diagnostic.includes('unknown property stability')),
  );

  assert.throws(
    () => validateApiSurfaceInventory(validInventory({
      symbols: [
        AUTHOR_SYMBOL,
        { ...HOST_REGISTRATION_SYMBOL, sourceModule: HOST_REGISTRATION_ENTRYPOINT.sourceModule },
        ...HOST_REGISTRATION_TYPE_SYMBOLS,
        HOST_FILE_LOCK_RECLAIM_SYMBOL,
        HOST_FILE_LOCK_SYMBOL,
        HOST_TARGETED_CONTRIBUTIONS_SYMBOL,
        HOST_TARGETED_CONTRIBUTIONS_SEMANTIC_REFS_SYMBOL,
        ...HOST_TARGETED_CONTRIBUTIONS_TYPE_SYMBOLS,
      ],
    })),
    (error) => error instanceof ApiSurfaceValidationError
      && error.diagnostics.some((diagnostic) => diagnostic.includes('canonical sourceModule')),
  );

  assert.throws(
    () => validateApiSurfaceInventory(validInventory({
      entrypoints: [
        AUTHOR_ENTRYPOINT,
        {
          ...AUTHOR_ENTRYPOINT,
          specifier: './mcp',
        },
        ...HOST_ENTRYPOINTS,
      ],
      symbols: [
        AUTHOR_SYMBOL,
        {
          ...AUTHOR_SYMBOL,
          specifier: './mcp',
          exportName: 'McpService',
          sourceExport: 'McpService',
        },
        ...HOST_SYMBOLS,
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
        },
        ...HOST_ENTRYPOINTS,
      ],
      symbols: [
        AUTHOR_SYMBOL,
        {
          ...AUTHOR_SYMBOL,
          specifier: './mcp',
          exportName: 'McpService',
          sourceExport: 'McpService',
          sourceModule: 'src/Actions/service.ts',
        },
        ...HOST_SYMBOLS,
      ],
    })),
    (error) => error instanceof ApiSurfaceValidationError
      && error.diagnostics.includes(
        'entrypoint sourceModule src/Actions/index.ts has a case-insensitive collision with src/actions/index.ts',
      ),
  );

  assert.throws(
    () => validateApiSurfaceInventory(validInventory({
      symbols: [
        AUTHOR_SYMBOL,
        HOST_REGISTRATION_SYMBOL,
        {
          ...HOST_REGISTRATION_SYMBOL,
          exportName: 'PluginRegistrationScopeTarget',
          sourceExport: 'PluginRegistrationScopeTarget',
          kind: 'type',
        },
        ...HOST_REGISTRATION_TYPE_SYMBOLS,
        HOST_FILE_LOCK_RECLAIM_SYMBOL,
        HOST_FILE_LOCK_SYMBOL,
        HOST_TARGETED_CONTRIBUTIONS_SYMBOL,
        HOST_TARGETED_CONTRIBUTIONS_SEMANTIC_REFS_SYMBOL,
        ...HOST_TARGETED_CONTRIBUTIONS_TYPE_SYMBOLS,
      ],
    })),
    (error) => error instanceof ApiSurfaceValidationError
      && error.diagnostics.includes(
        'symbols[2] declares unapproved host export ./host/registration:PluginRegistrationScopeTarget',
      ),
  );
});

test('host inventory requires the exact complete approved symbol and kind set per entrypoint', () => {
  assert.throws(
    () => validateApiSurfaceInventory(validInventory({
      symbols: [
        AUTHOR_SYMBOL,
        HOST_REGISTRATION_SYMBOL,
        HOST_FILE_LOCK_SYMBOL,
      ],
    })),
    (error) => error instanceof ApiSurfaceValidationError
      && error.diagnostics.includes(
        'host entrypoint ./host/registration is missing approved export PluginAgentRuntimeRegistration (type)',
      )
      && error.diagnostics.includes(
        'host entrypoint ./host/registration is missing approved export PluginRegistrationRight (type)',
      )
      && error.diagnostics.includes(
        'host entrypoint ./host/registration is missing approved export PluginRuntimeRegistration (type)',
      )
      && error.diagnostics.includes(
        'host entrypoint ./host/fs/json-owner-file-lock is missing approved export reclaimJsonOwnerFileLockSnapshot (value)',
      ),
  );

  assert.throws(
    () => validateApiSurfaceInventory(validInventory({
      symbols: validInventory().symbols.map((symbol) => (
        symbol.exportName === 'reclaimJsonOwnerFileLockSnapshot'
          ? { ...symbol, kind: 'type' }
          : symbol
      )),
    })),
    (error) => error instanceof ApiSurfaceValidationError
      && error.diagnostics.includes(
        'symbols[5] host export ./host/fs/json-owner-file-lock:reclaimJsonOwnerFileLockSnapshot must have value kind',
      ),
  );
});

test('author inventory rejects retired/private specifier namespaces and host source owners', () => {
  for (const specifier of ['./experimental/actions', './internal/actions']) {
    assert.throws(
      () => validateApiSurfaceInventory(validInventory({
        entrypoints: [
          { ...AUTHOR_ENTRYPOINT, specifier },
          ...HOST_ENTRYPOINTS,
        ],
        symbols: [
          { ...AUTHOR_SYMBOL, specifier },
          ...HOST_SYMBOLS,
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
        { ...AUTHOR_SYMBOL, sourceModule: 'src/host/actions/service.ts' },
        ...HOST_SYMBOLS,
      ],
    })),
    (error) => error instanceof ApiSurfaceValidationError
      && error.diagnostics.includes(
        'symbols[0] author symbol cannot project a src/host/** source owner',
      ),
  );

  assert.throws(
    () => validateApiSurfaceInventory(validInventory({
      symbols: [
        {
          ...AUTHOR_SYMBOL,
          exportName: 'createPluginRegistrationScope',
          sourceExport: 'createPluginRegistrationScope',
          kind: 'value',
        },
        ...HOST_SYMBOLS,
      ],
    })),
    (error) => error instanceof ApiSurfaceValidationError
      && error.diagnostics.includes(
        'symbols[0] author symbol cannot expose host-only export createPluginRegistrationScope',
      ),
  );
});

test('one generation plan includes host package seams but excludes them from author outputs', () => {
  const inventory = validateApiSurfaceInventory(validInventory());
  const generated = createApiSurfaceGenerationPlan(inventory);

  assert.deepEqual(Object.keys(generated.packageExports), [
    './actions',
    './host/fs/json-owner-file-lock',
    './host/registration',
    './host/targeted-contributions',
  ]);
  assert.doesNotMatch(generated.sourceBarrels['src/actions/index.ts'], /@preview|@experimental|@stable/u);
  assert.match(
    generated.sourceBarrels['src/actions/index.ts'],
    /export type \{ ActionsService \} from '\.\/service\.js';/u,
  );
  assert.match(
    generated.sourceBarrels['src/host/registration/index.ts'],
    /createPluginRegistrationScope/u,
  );
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
    /`capability-matrix\.json` records public-family availability with its proving consumer or explicit deferred disposition\./u,
  );
  assert.match(generated.authorApiMarkdown, /ActionsService/u);
  assert.doesNotMatch(generated.authorApiMarkdown, /createPluginRegistrationScope/u);
  assert.doesNotMatch(generated.authorApiMarkdown, /withJsonOwnerFileLock/u);
});

test('generation orders package export conditions from types through realm targets to default', async () => {
  const inventory = await readValidatedApiSurfaceInventory(
    new URL('../api-surface.json', import.meta.url),
  );
  const generated = createApiSurfaceGenerationPlan(inventory);

  assert.deepEqual(Object.keys(generated.packageExports['.']), ['types', 'browser', 'default']);
  assert.deepEqual(
    Object.keys(generated.packageExports['./ui/client']),
    ['types', 'browser', 'default'],
  );
  assert.deepEqual(
    Object.keys(generated.packageExports['./voice/client']),
    ['types', 'browser', 'react-native', 'default'],
  );
  assert.deepEqual(
    Object.keys(generated.packageExports['./host/registration']),
    ['types', 'browser', 'react-native', 'default'],
  );
  assert.deepEqual(
    Object.keys(generated.packageExports['./scm/backend']),
    ['types', 'default'],
  );

  for (const [specifier, conditions] of Object.entries(generated.packageExports)) {
    assert.equal(
      Object.keys(conditions).at(-1),
      'default',
      `${specifier} must keep default as its last matching condition`,
    );
  }
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
      },
      HOST_REGISTRATION_SYMBOL,
      ...HOST_REGISTRATION_TYPE_SYMBOLS,
      HOST_FILE_LOCK_RECLAIM_SYMBOL,
      HOST_FILE_LOCK_SYMBOL,
      HOST_TARGETED_CONTRIBUTIONS_SYMBOL,
      HOST_TARGETED_CONTRIBUTIONS_SEMANTIC_REFS_SYMBOL,
      ...HOST_TARGETED_CONTRIBUTIONS_TYPE_SYMBOLS,
    ],
  })));

  const barrel = generated.sourceBarrels['src/actions/index.ts'];
  assert.ok(barrel.indexOf('AService') < barrel.indexOf('aService'));
  assert.deepEqual(generated.authorDeclarationAssertions['./actions'], ['AService', 'aService']);
});
