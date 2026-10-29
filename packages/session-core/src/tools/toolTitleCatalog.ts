import type { ToolCall } from '../messages/index.js';
import type { Metadata } from '../state/index.js';
import { extractShellCommand, stripShellCommandPreludeForDisplay } from '@happier-dev/protocol/activity/shellCommand';
import { extractHappierToolsShellBridgeCommand } from './normalization/parse/happierToolsShellBridge.js';
import { getHappierToolsShellBridgeDisplay } from './normalization/parse/happierToolsShellBridgeDisplay.js';
import { resolveToolPath as resolvePath } from './toolPath.js';
import { resolveDiffToolTitlePresentation } from './toolTitleSpecializations.js';
import { createPublishedSubagentToolPresenter } from './toolTitleSpecializations.js';
import { defaultToolTitleTranslation, type ToolTitleTranslator } from './toolTitleTranslations.js';

export type ToolTitleOptions = Readonly<{ tool: ToolCall; metadata: Metadata | null }>;
export type ToolTitleContext = Readonly<{
    translate?: ToolTitleTranslator;
    subagentTitle?: (options: ToolTitleOptions) => string;
}>;

/** Tool-specific title rules live here; hosts supply localization and authorized catalog facts. */
export function createToolTitleCatalog(context: ToolTitleContext = {}) {
    const t = context.translate ?? defaultToolTitleTranslation;
    const publishedSubagent = createPublishedSubagentToolPresenter(t);
    const resolveSubagentToolPresentation = (opts: ToolTitleOptions) => ({ title: context.subagentTitle?.(opts) ?? publishedSubagent(opts).title });
    const resolveDiffToolHeaderPresentation = (opts: ToolTitleOptions | { tool: ToolCall; filePathFallback?: string | null }) => resolveDiffToolTitlePresentation(opts.tool, t);
    return {
        "Diff": (opts: ToolTitleOptions) => {
            return resolveDiffToolHeaderPresentation({ tool: opts.tool }).title;
        },
        "Read": () => t('tools.names.readFile'),
        "read": () => t('tools.names.readFile'),
        "Edit": (opts: ToolTitleOptions) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path;
            }
            return t('tools.names.editFile');
        },
        "MultiEdit": (opts: ToolTitleOptions) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                const editCount = Array.isArray(opts.tool.input.edits) ? opts.tool.input.edits.length : 0;
                if (editCount > 1) {
                    return t('tools.desc.multiEditEdits', { path, count: editCount });
                }
                return path;
            }
            return t('tools.names.editFile');
        },
        "Write": (opts: ToolTitleOptions) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path;
            }
            return t('tools.names.writeFile');
        },
        "Delete": (opts: ToolTitleOptions) => {
            const input = opts.tool.input;
            const filePaths = Array.isArray(input?.file_paths) ? input.file_paths : null;
            const first = Array.isArray(filePaths) && typeof filePaths[0] === 'string' ? String(filePaths[0]) : null;
            const fallback = typeof input?.file_path === 'string' ? String(input.file_path) : null;
            const path = first || fallback ? resolvePath(first ?? fallback ?? '', opts.metadata) : null;
            const count = Array.isArray(filePaths) ? filePaths.length : (first || fallback ? 1 : 0);
            if (path && count > 1) return `${path} (+${count - 1} more)`;
            if (path) return path;
            return 'Delete';
        },
        "NotebookRead": (opts: ToolTitleOptions) => {
            if (typeof opts.tool.input.notebook_path === 'string') {
                const path = resolvePath(opts.tool.input.notebook_path, opts.metadata);
                return path;
            }
            return t('tools.names.readNotebook');
        },
        "NotebookEdit": (opts: ToolTitleOptions) => {
            if (typeof opts.tool.input.notebook_path === 'string') {
                const path = resolvePath(opts.tool.input.notebook_path, opts.metadata);
                return path;
            }
            return t('tools.names.editNotebook');
        },
        "Patch": (opts: ToolTitleOptions) => t('tools.names.applyChanges'),
        "Reasoning": (opts: ToolTitleOptions) => {
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        },
        "Glob": () => t('tools.names.searchFiles'),
        "Grep": () => t('tools.names.searchContent'),
        "LS": () => t('tools.names.listFiles'),
        "CodeSearch": () => t('tools.names.search'),
        "SubAgent": (opts: ToolTitleOptions) => resolveSubagentToolPresentation(opts).title,
        "SubAgentRun": (opts: ToolTitleOptions) => resolveSubagentToolPresentation(opts).title,
        "Bash": (opts: ToolTitleOptions) => {
            const shellBridge = extractHappierToolsShellBridgeCommand(opts.tool.input);
            if (shellBridge) {
                return t('tools.desc.terminalCmd', { cmd: getHappierToolsShellBridgeDisplay(shellBridge).titleCommand });
            }

            const cmdRaw = extractShellCommand(opts.tool.input);
            const cmd = typeof cmdRaw === 'string' ? stripShellCommandPreludeForDisplay(cmdRaw) : cmdRaw;
            if (typeof cmd === 'string') {
                const firstWord = cmd.trim().split(/\s+/)[0];
                if (firstWord) return t('tools.desc.terminalCmd', { cmd: firstWord });
            }

            const rawDescription = typeof opts.tool.description === 'string' ? opts.tool.description.trim() : '';
            // Some providers (and permission-wrapped ACP tools) emit a generic marker like "execute"
            // rather than a helpful "Run <cmd>" title. Prefer deriving a stable title from the input.
            if (rawDescription && rawDescription.toLowerCase() !== 'execute') {
                return rawDescription;
            }

            return t('tools.names.terminal');
        },
        "ExitPlanMode": (opts: ToolTitleOptions) => t('tools.names.planProposal'),
        "exit_plan_mode": (opts: ToolTitleOptions) => t('tools.names.planProposal'),
        "TodoWrite": (opts: ToolTitleOptions) => t('tools.names.todoList'),
        "TodoRead": (opts: ToolTitleOptions) => t('tools.names.todoList'),
        "WebFetch": () => t('tools.names.fetchUrl'),
        "WebSearch": () => t('tools.names.webSearch'),
        "AskUserQuestion": (opts: ToolTitleOptions) => {
            return t('tools.names.question');
        },
        "CodexDiff": (opts: ToolTitleOptions) => {
            return resolveDiffToolHeaderPresentation({ tool: opts.tool }).title;
        },
        "GeminiDiff": (opts: ToolTitleOptions) => {
            return resolveDiffToolHeaderPresentation({
                tool: opts.tool,
                filePathFallback: typeof opts.tool.input?.filePath === 'string' ? opts.tool.input.filePath : null,
            }).title;
        },
        "edit": (opts: ToolTitleOptions) => {
            // Gemini sends data in nested structure, try multiple locations
            let filePath: string | undefined;

            // 1. Check toolCall.content[0].path
            if (typeof opts.tool.input?.toolCall?.content?.[0]?.path === 'string') {
                filePath = opts.tool.input.toolCall.content[0].path;
            }
            // 2. Check toolCall.title (has nice "Writing to ..." format)
            else if (typeof opts.tool.input?.toolCall?.title === 'string') {
                return opts.tool.input.toolCall.title;
            }
            // 3. Check input[0].path (array format)
            else if (Array.isArray(opts.tool.input?.input) && typeof opts.tool.input.input[0]?.path === 'string') {
                filePath = opts.tool.input.input[0].path;
            }
            // 4. Check direct path field
            else if (typeof opts.tool.input?.path === 'string') {
                filePath = opts.tool.input.path;
            }

            if (typeof filePath === 'string' && filePath.length > 0) {
                return resolvePath(filePath, opts.metadata);
            }
            return t('tools.names.editFile');
        },
        "CodexPatch": (opts: ToolTitleOptions) => t('tools.names.applyChanges'),
        "GeminiPatch": (opts: ToolTitleOptions) => t('tools.names.applyChanges'),
        "CodexReasoning": (opts: ToolTitleOptions) => {
            // Use the title from input if provided
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        },
        "GeminiReasoning": (opts: ToolTitleOptions) => {
            // Use the title from input if provided
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        },
        "think": (opts: ToolTitleOptions) => {
            // Use the title from input if provided
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        },
        "search": (opts: ToolTitleOptions) => t('tools.names.search'),
        "CodexBash": (opts: ToolTitleOptions) => {
            // Check if this is a single read command
            if (opts.tool.input?.parsed_cmd &&
                Array.isArray(opts.tool.input.parsed_cmd) &&
                opts.tool.input.parsed_cmd.length === 1 &&
                opts.tool.input.parsed_cmd[0].type === 'read' &&
                opts.tool.input.parsed_cmd[0].name) {
                // Display the file name being read
                const path = resolvePath(opts.tool.input.parsed_cmd[0].name, opts.metadata);
                return path;
            }
            return t('tools.names.terminal');
        },
        "GeminiBash": (opts: ToolTitleOptions) => t('tools.names.terminal'),
        "shell": (opts: ToolTitleOptions) => t('tools.names.terminal'),
        "execute": (opts: ToolTitleOptions) => {
            const shellBridge = extractHappierToolsShellBridgeCommand(opts.tool.input);
            if (shellBridge) {
                return t('tools.desc.terminalCmd', { cmd: getHappierToolsShellBridgeDisplay(shellBridge).titleCommand });
            }

            // Prefer a human-readable title when provided by ACP metadata
            const acpTitle =
                typeof opts.tool.input?._acp?.title === 'string'
                    ? opts.tool.input._acp.title
                    : typeof opts.tool.input?.toolCall?.title === 'string'
                        ? opts.tool.input.toolCall.title
                        : null;
            if (acpTitle) {
                // Title is often like "rm file.txt [cwd /path] (description)".
                // Extract just the command part before [
                const bracketIdx = acpTitle.indexOf(' [');
                const rawTitle = bracketIdx > 0 ? acpTitle.substring(0, bracketIdx) : acpTitle;
                const cmd = stripShellCommandPreludeForDisplay(rawTitle).trim();
                const firstWord = cmd.split(/\s+/)[0];
                if (firstWord) return t('tools.desc.terminalCmd', { cmd: firstWord });
                return t('tools.names.terminal');
            }
            const cmd = extractShellCommand(opts.tool.input);
            if (cmd) {
                const stripped = stripShellCommandPreludeForDisplay(cmd).trim();
                const firstWord = stripped.split(/\s+/)[0];
                if (firstWord) return t('tools.desc.terminalCmd', { cmd: firstWord });
            }
            return t('tools.names.terminal');
        },
        "change_title": (opts: ToolTitleOptions) => t('tools.names.changeTitle'),
        "WorkspaceIndexingPermission": (opts: ToolTitleOptions) => t('tools.workspaceIndexingPermission.defaultTitle'),
        Task: (opts: ToolTitleOptions) => resolveSubagentToolPresentation(opts).title
    };
}

export const defaultToolTitleCatalog = createToolTitleCatalog();
