const legacyToolNameToCanonical: Record<string, string> = {
    // Provider-branded historical names.
    CodexBash: 'Bash',
    CodexPatch: 'Patch',
    CodexDiff: 'Diff',
    GeminiReasoning: 'Reasoning',
    CodexReasoning: 'Reasoning',
    TaskCreate: 'Task',
    TaskList: 'Task',
    TaskUpdate: 'Task',

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
    return legacyToolNameToCanonical[toolName] ?? toolName;
}

