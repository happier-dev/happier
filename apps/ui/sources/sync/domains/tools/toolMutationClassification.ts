export type ToolMutationClassification =
    | 'read_only'
    | 'single_path'
    | 'patch'
    | 'path_pair'
    | 'opaque_executor'
    | 'container'
    | 'mutating_unknown';

function normalizeToolName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
}

const toolMutationClassificationByName: Readonly<Record<string, ToolMutationClassification>> = {
    askuserquestion: 'read_only',
    change_title: 'read_only',
    codesearch: 'read_only',
    codexdiff: 'read_only',
    codexreasoning: 'read_only',
    diff: 'read_only',
    exit_plan_mode: 'read_only',
    exitplanmode: 'read_only',
    geminidiff: 'read_only',
    geminireasoning: 'read_only',
    glob: 'read_only',
    grep: 'read_only',
    ls: 'read_only',
    notebookread: 'read_only',
    read: 'read_only',
    reasoning: 'read_only',
    search: 'read_only',
    think: 'read_only',
    todoread: 'read_only',
    todowrite: 'read_only',
    webfetch: 'read_only',
    websearch: 'read_only',
    workspaceindexingpermission: 'read_only',

    create_file: 'single_path',
    delete: 'single_path',
    delete_file: 'single_path',
    edit: 'single_path',
    edit_file: 'single_path',
    'file-edit': 'single_path',
    multiedit: 'single_path',
    notebookedit: 'single_path',
    write: 'single_path',
    write_file: 'single_path',

    apply_patch: 'patch',
    codexpatch: 'patch',
    geminipatch: 'patch',
    patch: 'patch',

    mkdir: 'path_pair',
    move: 'path_pair',
    rename: 'path_pair',
    rm: 'path_pair',
    unlink: 'path_pair',

    bash: 'opaque_executor',
    codexbash: 'opaque_executor',
    exec: 'opaque_executor',
    execute: 'opaque_executor',
    geminibash: 'opaque_executor',
    shell: 'opaque_executor',

    subagent: 'container',
    subagentrun: 'container',
    task: 'container',
};

export function resolveToolMutationClassification(toolName: string): ToolMutationClassification | null {
    const normalizedToolName = normalizeToolName(toolName);
    if (!normalizedToolName) return null;
    return toolMutationClassificationByName[normalizedToolName] ?? null;
}

export function isToolPotentiallyMutableForScm(toolName: string): boolean {
    const classification = resolveToolMutationClassification(toolName);
    if (classification === null) return true;
    return classification !== 'read_only' && classification !== 'container';
}
