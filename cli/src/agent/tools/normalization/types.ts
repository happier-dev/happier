export type ToolNormalizationProtocol = 'acp' | 'codex' | 'claude';

export type CanonicalToolName =
    | 'Bash'
    | 'Read'
    | 'Write'
    | 'Edit'
    | 'MultiEdit'
    | 'Glob'
    | 'Grep'
    | 'LS'
    | 'CodeSearch'
    | 'TodoWrite'
    | 'TodoRead'
    | 'WebFetch'
    | 'WebSearch'
    | 'Task'
    | 'Patch'
    | 'Diff'
    | 'Reasoning'
    | 'ExitPlanMode'
    | 'AskUserQuestion'
    | 'change_title';

export type ToolNormalizationHappyMetaV2 = {
    v: 2;
    protocol: ToolNormalizationProtocol;
    provider: string;
    rawToolName: string;
    canonicalToolName: string;
};

