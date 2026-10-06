import { AGENT_PERMISSION_INTENTS_V1 } from '@happier-dev/protocol/runtime/permissionIntentV1';

const SESSION_CREATE_HELP = [
  'happier session create [options]',
  '',
  'Options:',
  '  [--path <path>] [--agent <agent-id>]',
  '  [--title <text>]',
  '  [<prompt>|--prompt <text>|--message <text>]',
  '  [--model <model-id> [--provider-connection <connection-id>]]',
  `  [--permission-mode <${AGENT_PERMISSION_INTENTS_V1.join('|')}>] [--mode <agent-mode-id>]`,
  '    Aliases include read_only, ro, safe, full-access, accept-edits, and bypass-permissions.',
  '  [--config-option <id=value>] [--reasoning-effort <value>]',
  '  [--config-overrides-json <json>] [--launch-profile <profile-id>]',
  '  [--env <KEY=VALUE>]',
  '  [--auth <default|native|cs:<id>>|--connected-services <selector>|--auth-json <json>]',
  '  [--mcp-selection-json <json>] [--transcript-storage <persisted|direct>]',
  '  [--terminal-json <json>]',
  '  [--machine-id <machineId>] [--server-id <serverId>]',
  '  [--spawn-attempt-id <id>] [--resume-spawn-attempt]',
  '  [--wait [--timeout <seconds>]|--follow [--jsonl]]',
  '  [--json]',
].join('\n');

export const SESSION_HELP_LINES = {
  resume: 'happier resume [<session-id-or-prefix>]',
  create: SESSION_CREATE_HELP,
  history: 'happier session history <session-id-or-prefix-or-tag> [--machine-id <machineId>] ([--tail N|--limit N] [--format compact|raw] [--raw] [--include-meta] [--include-structured-payload] [--json] | --follow [--jsonl])',
  reviewStart: 'happier session review start <session-id-or-prefix-or-tag> --engines <id1,id2> --instructions <text> [--json]',
  planStart: 'happier session plan start <session-id-or-prefix-or-tag> --backends <id1,id2> --instructions <text> [--machine-id <machineId>] [--json]',
  delegateStart: 'happier session delegate start <session-id-or-prefix-or-tag> [<instructions>|--instructions <text>] (--backends <id1,id2>|--agent <agent>) [--machine-id <machineId>] [--json]',
  voiceAgentStart: 'happier session voice-agent start <session-id-or-prefix-or-tag> --backends <id1,id2> --instructions <text> [--machine-id <machineId>] [--json]',
  actionsList: 'happier session actions list [--json]',
  actionsDescribe: 'happier session actions describe <action-id> [--json]',
  actionsExecute: 'happier session actions execute <session-id-or-prefix-or-tag> <action-id> [--input-json <json>] [--action-request-id <id>] [--resume-action-request] [--json]',
  runAction: 'happier session run action <session-id-or-prefix-or-tag> <run-id> <action-id> [--input-json <json>] [--json]',
} as const;

export const SESSION_TOP_LEVEL_HELP_LINES = [
  SESSION_HELP_LINES.create,
  SESSION_HELP_LINES.history,
  SESSION_HELP_LINES.reviewStart,
  SESSION_HELP_LINES.planStart,
  SESSION_HELP_LINES.delegateStart,
  SESSION_HELP_LINES.voiceAgentStart,
  SESSION_HELP_LINES.actionsList,
  SESSION_HELP_LINES.actionsDescribe,
  SESSION_HELP_LINES.actionsExecute,
  SESSION_HELP_LINES.runAction,
  SESSION_HELP_LINES.resume,
] as const;

export const SESSION_SUBCOMMAND_HELP_LINES: Record<string, readonly string[]> = {
  create: [SESSION_HELP_LINES.create],
  history: [SESSION_HELP_LINES.history],
  review: [SESSION_HELP_LINES.reviewStart],
  plan: [SESSION_HELP_LINES.planStart],
  delegate: [SESSION_HELP_LINES.delegateStart],
  'voice-agent': [SESSION_HELP_LINES.voiceAgentStart],
  actions: [SESSION_HELP_LINES.actionsList, SESSION_HELP_LINES.actionsDescribe, SESSION_HELP_LINES.actionsExecute],
  run: [SESSION_HELP_LINES.runAction],
};

export const SESSION_NESTED_SUBCOMMAND_HELP_LINES: Record<string, string> = {
  'review start': SESSION_HELP_LINES.reviewStart,
  'plan start': SESSION_HELP_LINES.planStart,
  'delegate start': SESSION_HELP_LINES.delegateStart,
  'voice-agent start': SESSION_HELP_LINES.voiceAgentStart,
  'actions list': SESSION_HELP_LINES.actionsList,
  'actions describe': SESSION_HELP_LINES.actionsDescribe,
  'actions execute': SESSION_HELP_LINES.actionsExecute,
  'run action': SESSION_HELP_LINES.runAction,
};

const FIRST_CLASS_SESSION_COMMAND_GUIDANCE: Readonly<Record<string, Readonly<{
  description: string;
  examples: readonly string[];
}>>> = {
  create: {
    description: 'Create a session, optionally targeting a machine and sending an initial prompt.',
    examples: [
      'happier spawn "Review this repository" --agent codex --wait',
      'happier spawn --path . --agent codex --machine-id <machineId>',
    ],
  },
  history: {
    description: 'Read a session transcript once, or follow it as it updates.',
    examples: [
      'happier history <session-id-or-prefix-or-tag> --tail 50 --machine-id <machineId>',
      'happier history <session-id-or-prefix-or-tag> --follow --jsonl',
    ],
  },
  'delegate start': {
    description: 'Start a delegated agent task from an existing session.',
    examples: [
      'happier delegate <session-id-or-prefix-or-tag> "Review the latest changes" --agent codex --machine-id <machineId>',
    ],
  },
};

/** Projects canonical session usage onto a first-class command without duplicating its contract. */
export function formatFirstClassSessionCommandHelp(params: Readonly<{
  command: string;
  sessionPath: readonly string[];
}>): string {
  const sessionPathKey = params.sessionPath.join(' ');
  const canonicalUsage = SESSION_NESTED_SUBCOMMAND_HELP_LINES[sessionPathKey]
    ?? SESSION_SUBCOMMAND_HELP_LINES[sessionPathKey]?.[0];
  const canonicalPrefix = `happier session ${sessionPathKey}`;
  if (!canonicalUsage || !canonicalUsage.startsWith(canonicalPrefix)) {
    throw new Error(`No canonical usage is registered for first-class session command ${sessionPathKey}`);
  }
  const usage = `happier ${params.command}${canonicalUsage.slice(canonicalPrefix.length)}`;
  const guidance = FIRST_CLASS_SESSION_COMMAND_GUIDANCE[sessionPathKey];
  if (!guidance) return usage;

  const [usageLine, ...usageDetail] = usage.split('\n');
  return [
    usageLine,
    '',
    guidance.description,
    ...(usageDetail.length > 0 ? ['', ...usageDetail] : []),
    '',
    'Examples:',
    ...guidance.examples.map((example) => `  ${example}`),
  ].join('\n');
}
