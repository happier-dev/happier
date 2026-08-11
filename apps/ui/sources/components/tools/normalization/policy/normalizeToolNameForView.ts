import { canonicalizeGenericSubAgentToolName, isChangeTitleToolNameAlias } from '@happier-dev/protocol/tools/v2';

const legacyToolNameToCanonical: Record<string, string> = {
    // Provider-branded historical names.
    CodexBash: 'Bash',
    CodexPatch: 'Patch',
    CodexDiff: 'Diff',
    GeminiReasoning: 'Reasoning',
    CodexReasoning: 'Reasoning',
    TaskCreate: 'SubAgent',
    TaskList: 'SubAgent',
    TaskUpdate: 'SubAgent',

    // Background-task control tools. Deliberately NOT part of the subagent family above: they act
    // on a detached process. The snake_case spellings mirror the CLI's `canonicalizeToolNameV2`
    // (and the `task_output` alias `permissionHandler.ts` already rewrites) so the two normalizers
    // cannot disagree about the same tool.
    task_output: 'TaskOutput',
    task_stop: 'TaskStop',

    // Legacy lowercase names (ACP + older sessions).
    edit: 'Edit',
    execute: 'Bash',
    read: 'Read',
    write: 'Write',
    search: 'CodeSearch',
    glob: 'Glob',
    grep: 'Grep',
    ls: 'LS',
    delete: 'Delete',
    remove: 'Delete',
    exit_plan_mode: 'ExitPlanMode',
    think: 'Reasoning',
};

export function normalizeToolNameForView(toolName: string): string {
    if (toolName.startsWith('mcp__')) return toolName;
    if (isChangeTitleToolNameAlias(toolName)) return 'change_title';
    const genericSubAgentToolName = canonicalizeGenericSubAgentToolName(toolName);
    if (genericSubAgentToolName) return genericSubAgentToolName;
    return legacyToolNameToCanonical[toolName] ?? toolName;
}
