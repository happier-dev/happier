/** Hosts localize these same title rules; the isolated public viewer currently uses English. */
export type ToolTitleTranslator = (key: string, values?: Record<string, string | number>) => string;

const titles: Readonly<Record<string, string>> = {
    task: 'Task', subAgent: 'Subagent', terminal: 'Terminal', searchFiles: 'Search Files', search: 'Search',
    searchContent: 'Search Content', listFiles: 'List Files', planProposal: 'Plan proposal', readFile: 'Read File',
    editFile: 'Edit File', writeFile: 'Write File', fetchUrl: 'Fetch URL', readNotebook: 'Read Notebook',
    editNotebook: 'Edit Notebook', todoList: 'Todo List', webSearch: 'Web Search', reasoning: 'Reasoning',
    applyChanges: 'Update file', viewDiff: 'Diff', turnDiff: 'Turn Diff', question: 'Question', changeTitle: 'Change Title',
};

export const defaultToolTitleTranslation: ToolTitleTranslator = (key, values) => {
    if (key.startsWith('tools.names.')) return titles[key.slice('tools.names.'.length)] ?? key;
    if (key === 'tools.common.unknownToolTitle') return 'Tool';
    if (key === 'tools.desc.terminalCmd') return `Run ${values?.cmd ?? ''}`;
    if (key === 'tools.desc.multiEditEdits') return `${values?.path ?? ''} (${values?.count ?? 0} edits)`;
    if (key === 'tools.subAgentTitle') return `${values?.label ?? ''} Agent`;
    if (key === 'tools.workspaceIndexingPermission.defaultTitle') return 'Workspace indexing';
    if (key === 'session.subagents.intent.review') return 'Review';
    if (key === 'session.subagents.intent.plan') return 'Plan';
    if (key === 'session.subagents.intent.delegate') return 'Delegate';
    return key;
};
