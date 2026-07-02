import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

type AgentIdsGeneratedValidatorModule = typeof import('./validateAgentIdsGenerated.ts');

async function loadValidator(): Promise<AgentIdsGeneratedValidatorModule> {
  try {
    return await import('./validateAgentIdsGenerated.ts');
  } catch (error) {
    assert.fail(`validator module should load: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createRepo(): string {
  return mkdtempSync(join(tmpdir(), 'happier-agent-ids-generated-validator-'));
}

function writeRepoFile(rootDir: string, filePath: string, content: string): void {
  const absolutePath = join(rootDir, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

test('validateAgentIdsGenerated rejects production canonical agent id arrays', async () => {
  const { validateAgentIdsGenerated } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/agents/src/types.ts',
    [
      'export const CANONICAL_AGENT_IDS = [',
      "  'claude',",
      "  'codex',",
      '] as const;',
      '',
    ].join('\n'),
  );

  const result = validateAgentIdsGenerated({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('packages/agents/src/types.ts:1')));
  assert.ok(result.errors.some((error) => error.includes('CANONICAL_AGENT_IDS')));
});

test('validateAgentIdsGenerated rejects production protocol agent provider id arrays', async () => {
  const { validateAgentIdsGenerated } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/protocol/src/providers/agentProviderIdsV1.ts',
    "export const AGENT_PROVIDER_IDS_V1 = ['claude', 'codex'] as const;\n",
  );

  const result = validateAgentIdsGenerated({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('AGENT_PROVIDER_IDS_V1')));
});

test('validateAgentIdsGenerated accepts generated agent provider id output', async () => {
  const { validateAgentIdsGenerated } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/agents/src/generated/agentProviderIds.ts',
    [
      '/**',
      ' * GENERATED FILE CONTRACT (A.X-agent-ids-codegen)',
      ' */',
      'export const AGENT_PROVIDER_IDS = Object.freeze([',
      "  'claude',",
      "  'codex',",
      '] as const);',
      'export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];',
      '',
    ].join('\n'),
  );

  const result = validateAgentIdsGenerated({ rootDir });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateAgentIdsGenerated accepts test fixtures that mention canonical agent id arrays', async () => {
  const { validateAgentIdsGenerated } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'scripts/migrations/extensions/bootstrapExtensionPackage.test.ts',
    'const source = "export const CANONICAL_AGENT_IDS = Object.freeze([\'codex\'] as const);";\n',
  );

  const result = validateAgentIdsGenerated({ rootDir });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateAgentIdsGenerated does not reject non-agent provider id arrays', async () => {
  const { validateAgentIdsGenerated } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/protocol/src/providers/azure-devops/installables.ts',
    "export const SCM_PROVIDER_IDS = ['github', 'gitlab', 'azure-devops'] as const;\n",
  );

  const result = validateAgentIdsGenerated({ rootDir });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});
