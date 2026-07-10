import { normalizeAcpPermissionIntent } from '@happier-dev/plugin-sdk/experimental/acp';

export type AuggiePermissionMode = string | null | undefined;

type AuggieToolPolicy = 'allow' | 'deny' | 'ask-user';

export const AUGGIE_TOOL_NAMES = Object.freeze([
  'remove-files',
  'save-file',
  'apply_patch',
  'str-replace-editor',
  'view',
  'launch-process',
  'kill-process',
  'read-process',
  'write-process',
  'list-processes',
  'web-search',
  'web-fetch',
  'sub-agent-api-builder',
  'sub-agent-code-reviewer',
  'sub-agent-component-builder',
  'sub-agent-database-architect',
  'sub-agent-feature-implementer',
  'sub-agent-test-engineer',
  'view_tasklist',
  'reorganize_tasklist',
  'update_tasks',
  'add_tasks',
] as const);

function permissionArgsForRules(rules: ReadonlyArray<readonly [string, AuggieToolPolicy]>): string[] {
  return rules.flatMap(([tool, policy]) => ['--permission', `${tool}:${policy}`]);
}

export function buildAuggiePermissionArgs(permissionMode: AuggiePermissionMode): string[] {
  const intent = normalizeAcpPermissionIntent(permissionMode);

  if (intent === 'yolo') {
    return permissionArgsForRules(AUGGIE_TOOL_NAMES.map((tool) => [tool, 'allow'] as const));
  }

  if (intent === 'safe-yolo') {
    const allowTools = new Set<string>(['view', 'save-file', 'apply_patch', 'str-replace-editor', 'remove-files']);
    return permissionArgsForRules(
      AUGGIE_TOOL_NAMES.map((tool) => [tool, allowTools.has(tool) ? 'allow' : 'ask-user'] as const),
    );
  }

  if (intent === 'read-only' || intent === 'plan') {
    const denyTools = new Set<string>([
      'remove-files',
      'save-file',
      'apply_patch',
      'str-replace-editor',
      'launch-process',
      'kill-process',
      'read-process',
      'write-process',
      'list-processes',
    ]);
    const rules: Array<readonly [string, AuggieToolPolicy]> = [];
    for (const tool of AUGGIE_TOOL_NAMES) {
      if (tool === 'view') continue;
      if (denyTools.has(tool)) rules.push([tool, 'deny']);
    }
    return ['--ask', ...permissionArgsForRules(rules)];
  }

  return permissionArgsForRules(
    AUGGIE_TOOL_NAMES.map((tool) => [tool, tool === 'view' ? 'allow' : 'ask-user'] as const),
  );
}
