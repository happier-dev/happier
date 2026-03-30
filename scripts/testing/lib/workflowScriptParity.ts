import { TEST_LANE_DEFINITIONS, type LaneId } from './testLaneMap.ts';

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
}

export type GovernanceCommandId =
  | 'test:wiring:self'
  | 'test:wiring'
  | 'test:policy:self'
  | 'test:policy'
  | 'test:inventory'
  | 'test:migration:inventory';

const CANONICAL_LANE_PARITY: readonly ParityDefinition[] = Object.freeze([
  {
    id: 'test',
    rootScriptName: 'test',
    docsCommands: ['yarn test'],
    workflowCommands: [
      'yarn workspace @happier-dev/protocol test',
      'yarn workspace @happier-dev/transfers test',
      'yarn workspace @happier-dev/agents test',
      'yarn workspace @happier-dev/cli-common test',
      'yarn workspace @happier-dev/connection-supervisor test',
      'yarn workspace @happier-dev/bootstrap test',
      'yarn workspace @happier-dev/app test:unit',
      'yarn workspace @happier-dev/cli test:unit',
      'yarn --cwd apps/server test:unit',
      'yarn --cwd packages/relay-server test',
      'yarn --cwd apps/stack test:unit',
    ],
    workflowMode: 'all',
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
    id: 'test:providers',
    rootScriptName: 'test:providers',
    docsCommands: ['yarn test:providers'],
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
  'packages/tests/vitest.providers.config.ts',
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
