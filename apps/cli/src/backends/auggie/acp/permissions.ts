import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permissionModeCanonical';

type AuggieToolPolicy = 'allow' | 'deny' | 'ask-user';

const AUGGIE_TOOL_NAMES = [
  // Core Tools
  'remove-files',
  'save-file',
  'apply_patch',
  'str-replace-editor',
  'view',
  // Process Tools
  'launch-process',
  'kill-process',
  'read-process',
  'write-process',
  'list-processes',
  // Integration Tools
  'web-search',
  'web-fetch',
  // Sub-agents
  'sub-agent-api-builder',
  'sub-agent-code-reviewer',
  'sub-agent-component-builder',
  'sub-agent-database-architect',
  'sub-agent-feature-implementer',
  'sub-agent-test-engineer',
  // Task management
  'view_tasklist',
  'reorganize_tasklist',
  'update_tasks',
  'add_tasks',
] as const;

function asIntent(mode: PermissionMode | null | undefined): PermissionMode {
  return normalizePermissionModeToIntent(mode ?? 'default') ?? 'default';
}

function permissionArgsForRules(rules: ReadonlyArray<readonly [string, AuggieToolPolicy]>): string[] {
  return rules.flatMap(([tool, policy]) => ['--permission', `${tool}:${policy}`]);
}

export function buildAuggiePermissionArgs(permissionMode: PermissionMode | null | undefined): string[] {
  const intent = asIntent(permissionMode);

  if (intent === 'yolo' || intent === 'bypassPermissions') {
    return permissionArgsForRules(AUGGIE_TOOL_NAMES.map((tool) => [tool, 'allow'] as const));
  }

  if (intent === 'safe-yolo') {
    const allowTools = new Set<string>(['view', 'save-file', 'apply_patch', 'str-replace-editor', 'remove-files']);
    const rules = AUGGIE_TOOL_NAMES.map((tool) => [tool, allowTools.has(tool) ? 'allow' : 'ask-user'] as const);
    return permissionArgsForRules(rules);
  }

  if (intent === 'read-only' || intent === 'plan') {
    // Prefer Auggie's built-in ask-mode to restrict to retrieval/non-editing tools,
    // then defensively deny edit/process tools via explicit permission rules.
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

  // default: ask-user for everything except view.
  const rules = AUGGIE_TOOL_NAMES.map((tool) => [tool, tool === 'view' ? 'allow' : 'ask-user'] as const);
  return permissionArgsForRules(rules);
}
