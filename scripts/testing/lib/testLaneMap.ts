import { FEATURE_IDS } from './protocolFeatureIds.ts';

export type LaneId =
  | 'test'
  | 'test:integration'
  | 'cli:test:slow'
  | 'website:test'
  | 'release-runtime:test'
  | 'test:db-contract:docker'
  | 'test:e2e:core:fast'
  | 'test:e2e:core:slow'
  | 'test:e2e:ui'
  | 'test:e2e:ui:wsrepl:lima'
  | 'test:e2e:ui:wsrepl:lima:self'
  | 'test:e2e:mobile'
  | 'test:providers'
  | 'test:stress'
  | 'stack:test:unit'
  | 'stack:test:integration'
  | 'stack:test:real-integration';

export interface TestLaneDefinition {
  id: LaneId;
  category: 'unit' | 'integration' | 'db-contract' | 'e2e' | 'provider' | 'stress' | 'website';
  rootScriptName: string | null;
  rootCommand: string | null;
  packageLocalOnly: boolean;
}

export const TEST_LANE_DEFINITIONS: readonly TestLaneDefinition[] = Object.freeze([
  { id: 'test', category: 'unit', rootScriptName: 'test', rootCommand: 'yarn test', packageLocalOnly: false },
  { id: 'test:integration', category: 'integration', rootScriptName: 'test:integration', rootCommand: 'yarn test:integration', packageLocalOnly: false },
  { id: 'cli:test:slow', category: 'integration', rootScriptName: null, rootCommand: null, packageLocalOnly: true },
  { id: 'website:test', category: 'website', rootScriptName: null, rootCommand: null, packageLocalOnly: true },
  { id: 'release-runtime:test', category: 'unit', rootScriptName: null, rootCommand: null, packageLocalOnly: true },
  {
    id: 'test:db-contract:docker',
    category: 'db-contract',
    rootScriptName: 'test:db-contract:docker',
    rootCommand: 'yarn test:db-contract:docker',
    packageLocalOnly: false,
  },
  {
    id: 'test:e2e:core:fast',
    category: 'e2e',
    rootScriptName: 'test:e2e:core:fast',
    rootCommand: 'yarn test:e2e:core:fast',
    packageLocalOnly: false,
  },
  {
    id: 'test:e2e:core:slow',
    category: 'e2e',
    rootScriptName: 'test:e2e:core:slow',
    rootCommand: 'yarn test:e2e:core:slow',
    packageLocalOnly: false,
  },
  { id: 'test:e2e:ui', category: 'e2e', rootScriptName: 'test:e2e:ui', rootCommand: 'yarn test:e2e:ui', packageLocalOnly: false },
  {
    id: 'test:e2e:ui:wsrepl:lima',
    category: 'e2e',
    rootScriptName: 'test:e2e:ui:wsrepl:lima',
    rootCommand: 'yarn test:e2e:ui:wsrepl:lima',
    packageLocalOnly: false,
  },
  {
    id: 'test:e2e:ui:wsrepl:lima:self',
    category: 'integration',
    rootScriptName: 'test:e2e:ui:wsrepl:lima:self',
    rootCommand: 'yarn test:e2e:ui:wsrepl:lima:self',
    packageLocalOnly: false,
  },
  { id: 'test:e2e:mobile', category: 'e2e', rootScriptName: 'test:e2e:mobile', rootCommand: 'yarn test:e2e:mobile', packageLocalOnly: false },
  { id: 'test:providers', category: 'provider', rootScriptName: 'test:providers', rootCommand: 'yarn test:providers', packageLocalOnly: false },
  { id: 'test:stress', category: 'stress', rootScriptName: 'test:stress', rootCommand: 'yarn test:stress', packageLocalOnly: false },
  { id: 'stack:test:unit', category: 'unit', rootScriptName: null, rootCommand: null, packageLocalOnly: true },
  { id: 'stack:test:integration', category: 'integration', rootScriptName: null, rootCommand: null, packageLocalOnly: true },
  { id: 'stack:test:real-integration', category: 'integration', rootScriptName: null, rootCommand: null, packageLocalOnly: true },
]);

export const LANE_ROOT_SCRIPTS: Readonly<Record<LaneId, string | null>> = Object.freeze(
  Object.fromEntries(TEST_LANE_DEFINITIONS.map((definition) => [definition.id, definition.rootCommand])) as Record<LaneId, string | null>,
);

const KNOWN_FEATURE_MATCHES = [...FEATURE_IDS]
  .sort((left, right) => right.length - left.length)
  .map((featureId) => `.feat.${featureId}.`);

const UI_INTEGRATION_RE = /\.(?:integration\.(?:test|spec)|real\.integration\.test|e2e\.test)\.[jt]sx?$/;
const CLI_INTEGRATION_RE = /\.(?:integration\.(?:test|spec)|real\.integration\.test|e2e\.test)\.ts$/;
const SERVER_INTEGRATION_RE = /\.(?:integration\.(?:test|spec)|real\.integration\.test)\.ts$/;
const UNIT_TEST_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const ROOT_UNIT_PACKAGE_PREFIXES = [
  'packages/protocol/',
  'packages/transfers/',
  'packages/agents/',
  'packages/cli-common/',
  'packages/connection-supervisor/',
  'packages/relay-server/',
];

export function resolveFeatureTagIssue(relativePath: string): string | null {
  if (!relativePath.includes('.feat.')) {
    return null;
  }

  if (KNOWN_FEATURE_MATCHES.some((needle) => relativePath.includes(needle))) {
    return null;
  }

  return `Invalid feature test tag in ${relativePath}`;
}

export function classifyTestFile(relativePath: string): LaneId | null {
  if (relativePath.startsWith('apps/stack/')) {
    if (/\.real\.integration\.test\.[cm]?[jt]s$/.test(relativePath)) return 'stack:test:real-integration';
    if (/\.integration\.test\.[cm]?[jt]s$/.test(relativePath)) return 'stack:test:integration';
    return /\.test\.[cm]?[jt]s$/.test(relativePath) ? 'stack:test:unit' : null;
  }

  if (relativePath.startsWith('apps/ui/')) {
    if (UI_INTEGRATION_RE.test(relativePath)) return 'test:integration';
    return UNIT_TEST_RE.test(relativePath) ? 'test' : null;
  }

  if (relativePath.startsWith('apps/website/')) {
    return UNIT_TEST_RE.test(relativePath) ? 'website:test' : null;
  }

  if (relativePath.startsWith('apps/cli/')) {
    if (/\.slow\.test\.ts$/.test(relativePath)) return 'cli:test:slow';
    if (CLI_INTEGRATION_RE.test(relativePath)) return 'test:integration';
    return UNIT_TEST_RE.test(relativePath) ? 'test' : null;
  }

  if (relativePath.startsWith('apps/server/')) {
    if (/\.dbcontract\.spec\.ts$/.test(relativePath)) return 'test:db-contract:docker';
    if (SERVER_INTEGRATION_RE.test(relativePath)) return 'test:integration';
    return UNIT_TEST_RE.test(relativePath) ? 'test' : null;
  }

  if (relativePath.startsWith('apps/bootstrap/')) {
    return UNIT_TEST_RE.test(relativePath) ? 'test' : null;
  }

  if (relativePath.startsWith('packages/tests/')) {
    if (relativePath.startsWith('packages/tests/scripts/') && /\.test\.mjs$/.test(relativePath)) {
      return 'test:e2e:ui:wsrepl:lima:self';
    }
    if (relativePath.includes('/suites/ui-e2e/')) return /\.spec\.ts$/.test(relativePath) ? 'test:e2e:ui' : null;
    if (relativePath.includes('/suites/providers/')) return /\.test\.ts$/.test(relativePath) ? 'test:providers' : null;
    if (relativePath.includes('/suites/stress/')) return /\.test\.ts$/.test(relativePath) ? 'test:stress' : null;
    if (relativePath.includes('/suites/core-e2e/')) {
      if (/\.slow\.e2e\.test\.ts$/.test(relativePath)) return 'test:e2e:core:slow';
      return /\.test\.ts$/.test(relativePath) ? 'test:e2e:core:fast' : null;
    }
    if (relativePath.includes('/src/testkit/')) return /\.(?:test|spec)\.ts$/.test(relativePath) ? 'test:e2e:core:fast' : null;
    return null;
  }

  if (relativePath.startsWith('packages/release-runtime/')) {
    return /\.test\.mjs$/.test(relativePath) ? 'release-runtime:test' : null;
  }

  if (ROOT_UNIT_PACKAGE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    return UNIT_TEST_RE.test(relativePath) ? 'test' : null;
  }

  return null;
}

export function collectLaneIssues(relativePath: string): string[] {
  const issues: string[] = [];

  if (relativePath.startsWith('packages/tests/suites/ui-e2e/') && !/\.spec\.ts$/.test(relativePath)) {
    issues.push('UI E2E tests must use *.spec.ts under packages/tests/suites/ui-e2e.');
  }

  if (relativePath.startsWith('packages/tests/suites/providers/') && !/\.test\.ts$/.test(relativePath)) {
    issues.push('Provider suite files must use *.test.ts under packages/tests/suites/providers.');
  }

  if (relativePath.startsWith('packages/tests/suites/stress/') && !/\.test\.ts$/.test(relativePath)) {
    issues.push('Stress suite files must use *.test.ts under packages/tests/suites/stress.');
  }

  if (relativePath.startsWith('packages/tests/suites/core-e2e/') && relativePath.includes('.slow.') && !/\.slow\.e2e\.test\.ts$/.test(relativePath)) {
    issues.push('Core E2E slow files must use *.slow.e2e.test.ts naming.');
  }

  if (relativePath.startsWith('packages/tests/suites/core-e2e/') && /\.spec\.ts$/.test(relativePath)) {
    issues.push('Core E2E files must use *.test.ts naming under packages/tests/suites/core-e2e.');
  }

  if (relativePath.startsWith('apps/stack/') && relativePath.includes('.real.integration.') && !/\.real\.integration\.test\.[cm]?[jt]s$/.test(relativePath)) {
    issues.push('Stack real integration tests must use *.real.integration.test.* naming.');
  }

  if (relativePath.startsWith('apps/stack/') && relativePath.includes('.integration.') && !relativePath.includes('.real.integration.') && !/\.integration\.test\.[cm]?[jt]s$/.test(relativePath)) {
    issues.push('Stack integration tests must use *.integration.test.* naming.');
  }

  if (relativePath.startsWith('apps/stack/') && !relativePath.includes('.integration.') && /\.(?:spec)\.[cm]?[jt]s$/.test(relativePath)) {
    issues.push('Stack unit tests must use *.test.* naming.');
  }

  const shouldSuppressGenericNoLaneIssue =
    issues.length > 0 &&
    ((relativePath.startsWith('apps/stack/') && relativePath.includes('.integration.')) ||
      (relativePath.startsWith('apps/stack/') && /\.spec\.[cm]?[jt]s$/.test(relativePath)) ||
      (relativePath.startsWith('packages/tests/suites/core-e2e/') && relativePath.includes('.slow.')));

  if (classifyTestFile(relativePath) === null && !shouldSuppressGenericNoLaneIssue) {
    issues.push(`No lane mapping matched ${relativePath}.`);
  }

  return issues;
}
