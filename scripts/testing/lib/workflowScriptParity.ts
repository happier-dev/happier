import { TEST_LANE_DEFINITIONS, type LaneId } from './testLaneMap.ts';

export interface WorkflowScriptParityIssue {
  laneId?: LaneId | GovernanceCommandId;
  message: string;
}

export interface WorkflowScriptParityReport {
  issues: readonly WorkflowScriptParityIssue[];
  packageLocalOnlyLaneIds: readonly LaneId[];
}

interface ParityDefinition {
  id: LaneId | GovernanceCommandId;
  rootScriptName: string;
  docsCommands: readonly string[];
  requiredScriptBodyPatterns?: readonly RegExp[];
}

export type GovernanceCommandId =
  | 'test:wiring:self'
  | 'test:wiring'
  | 'test:policy:self'
  | 'test:policy'
  | 'test:migration:v2-zero:enforce'
  | 'test:migration:bundled-plugin-projections';

// Script/docs parity derives lane identity from the canonical lane inventory.
// Parsed workflow execution coverage belongs to workflowWiring.contract.test.mjs.
const CANONICAL_LANE_PARITY: readonly ParityDefinition[] = TEST_LANE_DEFINITIONS
  .filter((lane) => lane.rootScriptName !== null)
  .map((lane) => ({ id: lane.id, rootScriptName: lane.rootScriptName!, docsCommands: [lane.rootCommand!] }));

const GOVERNANCE_COMMAND_PARITY: readonly ParityDefinition[] = Object.freeze([
  {
    id: 'test:wiring:self',
    rootScriptName: 'test:wiring:self',
    docsCommands: ['pnpm run test:wiring:self'],
  },
  {
    id: 'test:wiring',
    rootScriptName: 'test:wiring',
    docsCommands: ['pnpm run test:wiring'],
  },
  {
    id: 'test:policy:self',
    rootScriptName: 'test:policy:self',
    docsCommands: ['pnpm run test:policy:self'],
    requiredScriptBodyPatterns: [
      /scripts\/testing\/migrations\/lib\/\*\.test\.ts/,
      /scripts\/testing\/migrations\/runtimeUnification\/validators\/\*\.test\.ts/,
    ],
  },
  {
    id: 'test:policy',
    rootScriptName: 'test:policy',
    docsCommands: ['pnpm run test:policy'],
  },
  {
    id: 'test:migration:v2-zero:enforce',
    rootScriptName: 'test:migration:v2-zero:enforce',
    docsCommands: ['pnpm run test:migration:v2-zero:enforce'],
    requiredScriptBodyPatterns: [/scripts\/testing\/migrations\/validateV2ZeroInventory\.ts/, /--enforce/],
  },
  {
    id: 'test:migration:bundled-plugin-projections',
    rootScriptName: 'test:migration:bundled-plugin-projections',
    docsCommands: [],
    requiredScriptBodyPatterns: [
      /apps\/cli\/scripts\/build-owned\/generateBundledPluginEntries\.ts/,
      /--mode check/,
      /--scope projections/,
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
  const matches = text.matchAll(/\bpnpm(?:\s+(?:--silent|-s))?\s+run\s+(test(?::[a-z0-9:-]+)?)(?=\s|$|`)/gi);
  return Array.from(matches, (match) => ({
    command: `pnpm run ${match[1]!.trim()}`,
    scriptName: match[1]!.trim(),
  }));
}

export function collectWorkflowScriptParityReport(input: WorkflowScriptParityInput): WorkflowScriptParityReport {
  const issues: WorkflowScriptParityIssue[] = [];
  const scripts = parseScripts(input.packageJsonText);
  const docsCommands = new Set(extractRootCommandMentions(input.docsText).map((mention) => mention.command));

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
