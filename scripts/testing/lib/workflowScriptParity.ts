import {
  describeWorkspaceScriptTarget,
  matchesWorkspaceScriptTarget,
  resolveRootScriptWorkspaceTargets,
  scanYarnInvocations,
} from './rootScriptWorkspaceTargets.ts';
import { ROOT_UNIT_LANE_SCRIPT_NAME, TEST_LANE_DEFINITIONS, type LaneId } from './testLaneMap.ts';

export interface WorkflowScriptParityIssue {
  laneId?: LaneId | GovernanceCommandId;
  message: string;
}

export interface WorkflowScriptParityReport {
  issues: readonly WorkflowScriptParityIssue[];
  packageLocalOnlyLaneIds: readonly LaneId[];
}

type TriggerMode = 'required' | 'optional' | 'report-only' | 'local-only';

interface ParityDefinition {
  id: LaneId | GovernanceCommandId;
  rootScriptName: string;
  docsCommands: readonly string[];
  workflowCommands: readonly string[];
  workflowMode: 'all' | 'any';
  triggerMode: TriggerMode;
  requiredScriptBodyPatterns?: readonly RegExp[];
}

export type GovernanceCommandId =
  | 'test:wiring:self'
  | 'test:wiring'
  | 'test:policy:self'
  | 'test:policy'
  | 'test:inventory'
  | 'test:migration:inventory'
  | 'test:migration:v2-zero:enforce'
  | 'test:migration:bundled-plugin-projections'
  | 'test:migration:bundled-plugin-runtime-determinism'
  | 'test:migration:governance';

const CANONICAL_LANE_PARITY: readonly ParityDefinition[] = Object.freeze([
  {
    // Workflow coverage for the root unit lane is derived from the root script itself
    // (see collectRootUnitLaneWorkflowIssues), not from a second maintained command list.
    id: 'test',
    rootScriptName: 'test',
    docsCommands: ['yarn test'],
    workflowCommands: [],
    workflowMode: 'all',
    triggerMode: 'required',
  },
  {
    id: 'test:plugin-workspaces',
    rootScriptName: 'test:plugin-workspaces',
    docsCommands: ['yarn test:plugin-workspaces'],
    workflowCommands: ['yarn test:plugin-workspaces'],
    workflowMode: 'any',
    triggerMode: 'required',
  },
  {
    id: 'test:plugin-platform:source',
    rootScriptName: 'test:plugin-platform:source',
    docsCommands: ['yarn test:plugin-platform:source'],
    workflowCommands: ['yarn workspace @happier-dev/tests test:plugin-platform:source'],
    workflowMode: 'any',
    triggerMode: 'required',
  },
  {
    id: 'test:integration',
    rootScriptName: 'test:integration',
    docsCommands: ['yarn test:integration'],
    workflowCommands: [
      'yarn workspace @happier-dev/app test:integration',
      'yarn workspace @happier-dev/cli test:integration',
      'yarn --cwd apps/server test:integration',
      'yarn --cwd apps/stack test:integration',
    ],
    workflowMode: 'all',
    triggerMode: 'required',
  },
  {
    id: 'test:db-contract:docker',
    rootScriptName: 'test:db-contract:docker',
    docsCommands: ['yarn test:db-contract:docker'],
    workflowCommands: ['yarn --cwd apps/server test:server:db-contract'],
    workflowMode: 'any',
    triggerMode: 'optional',
  },
  {
    id: 'test:e2e:core:fast',
    rootScriptName: 'test:e2e:core:fast',
    docsCommands: ['yarn test:e2e:core:fast'],
    workflowCommands: ['yarn test:e2e:core:fast'],
    workflowMode: 'any',
    triggerMode: 'required',
  },
  {
    id: 'test:e2e:core:slow',
    rootScriptName: 'test:e2e:core:slow',
    docsCommands: ['yarn test:e2e:core:slow'],
    workflowCommands: ['yarn test:e2e:core:slow'],
    workflowMode: 'any',
    triggerMode: 'optional',
  },
  {
    id: 'test:e2e:ui',
    rootScriptName: 'test:e2e:ui',
    docsCommands: ['yarn test:e2e:ui'],
    workflowCommands: ['yarn -s test:e2e:ui', 'yarn test:e2e:ui'],
    workflowMode: 'any',
    triggerMode: 'optional',
  },
  {
    id: 'test:e2e:desktop:native',
    rootScriptName: 'test:e2e:desktop:native',
    docsCommands: ['yarn test:e2e:desktop:native'],
    workflowCommands: [],
    workflowMode: 'any',
    triggerMode: 'local-only',
  },
  {
    id: 'test:e2e:ui:wsrepl:lima',
    rootScriptName: 'test:e2e:ui:wsrepl:lima',
    docsCommands: ['yarn test:e2e:ui:wsrepl:lima'],
    workflowCommands: ['yarn -s test:e2e:ui:wsrepl:lima', 'yarn test:e2e:ui:wsrepl:lima'],
    workflowMode: 'any',
    triggerMode: 'optional',
  },
  {
    id: 'test:e2e:ui:wsrepl:lima:self',
    rootScriptName: 'test:e2e:ui:wsrepl:lima:self',
    docsCommands: ['yarn test:e2e:ui:wsrepl:lima:self'],
    workflowCommands: [],
    workflowMode: 'any',
    triggerMode: 'local-only',
  },
  {
    id: 'test:e2e:mobile',
    rootScriptName: 'test:e2e:mobile',
    docsCommands: ['yarn test:e2e:mobile'],
    workflowCommands: ['yarn -s test:e2e:mobile', 'yarn test:e2e:mobile'],
    workflowMode: 'any',
    triggerMode: 'optional',
  },
  {
    id: 'test:agents',
    rootScriptName: 'test:agents',
    docsCommands: ['yarn test:agents'],
    workflowCommands: ['yarn workspace @happier-dev/tests providers:run'],
    workflowMode: 'any',
    triggerMode: 'optional',
  },
  {
    id: 'test:stress',
    rootScriptName: 'test:stress',
    docsCommands: ['yarn test:stress'],
    workflowCommands: ['yarn test:stress'],
    workflowMode: 'any',
    triggerMode: 'optional',
  },
]);

const GOVERNANCE_COMMAND_PARITY: readonly ParityDefinition[] = Object.freeze([
  {
    id: 'test:wiring:self',
    rootScriptName: 'test:wiring:self',
    docsCommands: ['yarn test:wiring:self'],
    workflowCommands: ['yarn test:wiring:self'],
    workflowMode: 'any',
    triggerMode: 'required',
  },
  {
    id: 'test:wiring',
    rootScriptName: 'test:wiring',
    docsCommands: ['yarn test:wiring'],
    workflowCommands: ['yarn test:wiring'],
    workflowMode: 'any',
    triggerMode: 'required',
  },
  {
    id: 'test:policy:self',
    rootScriptName: 'test:policy:self',
    docsCommands: ['yarn test:policy:self'],
    workflowCommands: [],
    workflowMode: 'any',
    triggerMode: 'local-only',
    requiredScriptBodyPatterns: [
      /scripts\/testing\/migrations\/lib\/\*\.test\.ts/,
      /scripts\/testing\/migrations\/runtimeUnification\/validators\/\*\.test\.ts/,
    ],
  },
  {
    id: 'test:policy',
    rootScriptName: 'test:policy',
    docsCommands: ['yarn test:policy'],
    workflowCommands: ['yarn test:policy'],
    workflowMode: 'any',
    triggerMode: 'required',
  },
  {
    id: 'test:inventory',
    rootScriptName: 'test:inventory',
    docsCommands: ['yarn test:inventory'],
    workflowCommands: ['yarn test:inventory'],
    workflowMode: 'any',
    triggerMode: 'report-only',
  },
  {
    id: 'test:migration:inventory',
    rootScriptName: 'test:migration:inventory',
    docsCommands: ['yarn test:migration:inventory'],
    workflowCommands: ['yarn test:migration:inventory'],
    workflowMode: 'any',
    triggerMode: 'report-only',
    requiredScriptBodyPatterns: [/scripts\/testing\/migrations\/validateMigrationInventory\.ts/],
  },
  {
    id: 'test:migration:v2-zero:enforce',
    rootScriptName: 'test:migration:v2-zero:enforce',
    docsCommands: ['yarn test:migration:v2-zero:enforce'],
    workflowCommands: ['yarn test:migration:v2-zero:enforce', 'yarn test:migration:governance'],
    workflowMode: 'any',
    triggerMode: 'required',
    requiredScriptBodyPatterns: [/scripts\/testing\/migrations\/validateV2ZeroInventory\.ts/, /--enforce/],
  },
  {
    id: 'test:migration:bundled-plugin-projections',
    rootScriptName: 'test:migration:bundled-plugin-projections',
    docsCommands: [],
    workflowCommands: ['yarn test:migration:governance'],
    workflowMode: 'any',
    triggerMode: 'local-only',
    requiredScriptBodyPatterns: [
      /scripts\/migrations\/extensions\/generateBundledPluginEntries\.ts/,
      /--mode check/,
      /--scope projections/,
    ],
  },
  {
    // Same publisher, the other question: the re-stage inlines the current
    // shared workspace output into every bundled runtime, so byte equality is a
    // whole-repo build-determinism signal and carries its own name.
    id: 'test:migration:bundled-plugin-runtime-determinism',
    rootScriptName: 'test:migration:bundled-plugin-runtime-determinism',
    docsCommands: [],
    workflowCommands: ['yarn test:migration:governance'],
    workflowMode: 'any',
    triggerMode: 'local-only',
    requiredScriptBodyPatterns: [
      /scripts\/migrations\/extensions\/generateBundledPluginEntries\.ts/,
      /--mode check/,
      /--scope all/,
    ],
  },
  {
    id: 'test:migration:governance',
    rootScriptName: 'test:migration:governance',
    docsCommands: ['yarn test:migration:governance'],
    workflowCommands: ['yarn test:migration:governance'],
    workflowMode: 'any',
    triggerMode: 'required',
    requiredScriptBodyPatterns: [
      /test:migration:v2-zero:enforce/,
      /test:migration:wire-compat/,
      /test:migration:bundled-plugin-projections/,
      /test:migration:bundled-plugin-runtime-determinism/,
    ],
  },
]);

export const FEATURE_GATING_CONFIG_PATHS: readonly string[] = Object.freeze([
  'apps/ui/vitest.config.ts',
  'apps/ui/vitest.integration.config.ts',
  'apps/cli/vitest.config.ts',
  'apps/cli/vitest.integration.config.ts',
  'apps/cli/vitest.slow.config.ts',
  'apps/server/vitest.config.ts',
  'apps/server/vitest.integration.config.ts',
  'apps/server/vitest.dbcontract.config.ts',
  'packages/tests/vitest.core.config.ts',
  'packages/tests/vitest.core.fast.config.ts',
  'packages/tests/vitest.agents.config.ts',
  'packages/tests/vitest.stress.config.ts',
]);

export interface WorkflowScriptParityInput {
  packageJsonText: string;
  workflowText: string;
  docsText: string;
  configTexts: Readonly<Record<string, string>>;
}

interface CommandMention {
  command: string;
  scriptName: string;
}

function parseScripts(packageJsonText: string): Record<string, string> {
  const parsed = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };
  return parsed.scripts ?? {};
}

function extractRootCommandMentions(text: string): CommandMention[] {
  const matches = text.matchAll(/\byarn(?:\s+-s)?\s+(test(?::[a-z0-9:-]+)?)(?=\s|$|`)/gi);
  return Array.from(matches, (match) => ({
    command: match[0]!.trim(),
    scriptName: match[1]!.trim(),
  }));
}

function hasAllCommands(text: string, commands: readonly string[]): boolean {
  return commands.every((command) => text.includes(command));
}

function hasAnyCommand(text: string, commands: readonly string[]): boolean {
  return commands.length === 0 ? true : commands.some((command) => text.includes(command));
}

const FINITE_PUBLIC_SDK_SCRIPT_NAME = 'check:public-sdk:finite:local';
const FINITE_PUBLIC_SDK_WORKSPACE_TEST_TASK = 'test:finite';

/**
 * The workflow substitutes one aggregate command for the per-workspace test steps, so its unit
 * coverage is exactly what that root script runs. Reading the turbo tasks and `--filter` targets out
 * of the script body keeps the allowance removal-sensitive: dropping the workspace test task, or
 * dropping a workspace from the filter, withdraws the credit instead of leaving a mirrored list that
 * cannot notice either change.
 */
function resolveFinitePublicSdkTestWorkspaces(
  scripts: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  const tokens = (scripts[FINITE_PUBLIC_SDK_SCRIPT_NAME] ?? '').split(/\s+/u).filter((token) => token.length > 0);
  const runIndex = tokens.indexOf('run');
  if (runIndex === -1) return new Set();
  const tasks: string[] = [];
  for (const token of tokens.slice(runIndex + 1)) {
    if (token.startsWith('-')) break;
    tasks.push(token);
  }
  if (!tasks.includes(FINITE_PUBLIC_SDK_WORKSPACE_TEST_TASK)) return new Set();
  const workspaces = new Set<string>();
  for (const token of tokens) {
    if (token.startsWith('--filter=')) workspaces.add(token.slice('--filter='.length));
  }
  return workspaces;
}

/**
 * The root unit lane runs one workspace test script per workspace. CI must run the same set, so the
 * expected commands are read out of the root script instead of a parallel maintained list.
 */
function collectRootUnitLaneWorkflowIssues(
  input: WorkflowScriptParityInput,
  scripts: Readonly<Record<string, string>>,
): WorkflowScriptParityIssue[] {
  const issues: WorkflowScriptParityIssue[] = [];
  const workflowTargets = scanYarnInvocations(input.workflowText).workspaceTargets
    .filter((target) => target.scriptName.startsWith('test'));
  const seen = new Set<string>();
  const finitePublicSdkTaskRuns = /\byarn(?:\s+-s)?\s+check:public-sdk:finite(?:\s|$)/u.test(input.workflowText);
  const finitePublicSdkWorkspaces = resolveFinitePublicSdkTestWorkspaces(scripts);

  for (const target of resolveRootScriptWorkspaceTargets(scripts, ROOT_UNIT_LANE_SCRIPT_NAME)) {
    if (!target.scriptName.startsWith('test')) continue;
    const workspaceLabel = describeWorkspaceScriptTarget(target);
    if (seen.has(workspaceLabel)) continue;
    seen.add(workspaceLabel);

    if (
      !workflowTargets.some((candidate) => matchesWorkspaceScriptTarget(target, candidate))
      && !(finitePublicSdkTaskRuns && target.packageName !== null && finitePublicSdkWorkspaces.has(target.packageName))
    ) {
      issues.push({
        laneId: 'test',
        message: `Workflow coverage is missing for test: no CI step runs the ${workspaceLabel} test script.`,
      });
    }
  }

  return issues;
}

export function collectWorkflowScriptParityReport(input: WorkflowScriptParityInput): WorkflowScriptParityReport {
  const issues: WorkflowScriptParityIssue[] = [];
  const scripts = parseScripts(input.packageJsonText);
  const docsCommands = new Set(extractRootCommandMentions(input.docsText).map((mention) => mention.command));

  issues.push(...collectRootUnitLaneWorkflowIssues(input, scripts));

  for (const definition of [...CANONICAL_LANE_PARITY, ...GOVERNANCE_COMMAND_PARITY]) {
    if (!(definition.rootScriptName in scripts)) {
      issues.push({
        laneId: definition.id,
        message: `Missing root script ${definition.rootScriptName}.`,
      });
    }

    const scriptBody = scripts[definition.rootScriptName] ?? '';
    for (const requiredPattern of definition.requiredScriptBodyPatterns ?? []) {
      if (!requiredPattern.test(scriptBody)) {
        issues.push({
          laneId: definition.id,
          message: `Root script ${definition.rootScriptName} is missing required command body ${requiredPattern}.`,
        });
      }
    }

    for (const command of definition.docsCommands) {
      if (!docsCommands.has(command)) {
        issues.push({
          laneId: definition.id,
          message: `Docs are missing command ${command}.`,
        });
      }
    }

    if (definition.triggerMode === 'local-only') {
      continue;
    }

    const workflowMatches =
      definition.workflowMode === 'all'
        ? hasAllCommands(input.workflowText, definition.workflowCommands)
        : hasAnyCommand(input.workflowText, definition.workflowCommands);

    if (!workflowMatches) {
      issues.push({
        laneId: definition.id,
        message: `Workflow coverage is missing for ${definition.id}.`,
      });
    }
  }

  for (const mention of extractRootCommandMentions(input.workflowText)) {
    if (!(mention.scriptName in scripts)) {
      issues.push({
        message: `Workflow references unknown root command ${mention.command}.`,
      });
    }
  }

  for (const mention of extractRootCommandMentions(input.docsText)) {
    if (!(mention.scriptName in scripts)) {
      issues.push({
        message: `Docs reference unknown root command ${mention.command}.`,
      });
    }
  }

  for (const configPath of FEATURE_GATING_CONFIG_PATHS) {
    const configText = input.configTexts[configPath];
    if (!configText || !configText.includes('resolveVitestFeatureTestExcludeGlobs')) {
      issues.push({
        message: `Feature gating is not verified for ${configPath}.`,
      });
    }
  }

  return {
    issues,
    packageLocalOnlyLaneIds: TEST_LANE_DEFINITIONS.filter((definition) => definition.packageLocalOnly).map((definition) => definition.id),
  };
}
