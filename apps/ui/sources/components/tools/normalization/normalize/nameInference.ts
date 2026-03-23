import { asRecord, firstNonEmptyString, hasNonEmptyRecord } from './_shared';
import { canonicalizeGenericSubAgentToolName, isChangeTitleToolNameAlias } from '@happier-dev/protocol/tools/v2';

function isLegacySlashChangeTitleName(name: string): boolean {
    const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
    return normalized === 'happier/change_title' || normalized === 'happy/change_title';
}

function isUiChangeTitleAlias(name: string): boolean {
    return isChangeTitleToolNameAlias(name) || isLegacySlashChangeTitleName(name);
}

function extractContradictoryWrappedToolName(params: {
    toolName: string;
    input: unknown;
    description?: string | null;
}): string | null {
    if (!isUiChangeTitleAlias(params.toolName)) return null;

    const inputObj = asRecord(params.input);
    const permission = asRecord(inputObj?.permission);
    const directToolName = firstNonEmptyString(inputObj?.toolName);
    const permissionToolName = firstNonEmptyString(permission?.toolName);
    const describedToolName = (() => {
        const raw = firstNonEmptyString(params.description);
        if (!raw) return null;
        const match = raw.match(/^tool:\s*(.+)$/i);
        return match?.[1]?.trim() || null;
    })();

    const candidates = [directToolName, permissionToolName, describedToolName].filter((value): value is string => !!value);
    const contradictory = candidates.find((candidate) => !isUiChangeTitleAlias(candidate));
    return contradictory ?? null;
}

function canonicalizeToolNameNonV2(toolName: string, input: unknown, description?: string | null): string {
    // NOTE: This path covers:
    // - legacy sessions (pre V2 tool normalization)
    // - Claude local-control sessions (tool events produced from a transcript; no `_happier` metadata)

    const inputObj = asRecord(input);

    if (toolName === 'CodexPatch' || toolName === 'GeminiPatch') return 'Patch';
    if (toolName === 'CodexDiff' || toolName === 'GeminiDiff') return 'Diff';
    if (toolName === 'CodexReasoning' || toolName === 'GeminiReasoning' || toolName === 'think') return 'Reasoning';
    const genericSubAgentToolName = canonicalizeGenericSubAgentToolName(toolName);
    if (genericSubAgentToolName) return genericSubAgentToolName;
    if (toolName === 'exit_plan_mode') return 'ExitPlanMode';

    if (isUiChangeTitleAlias(toolName)) {
        const contradictoryWrappedToolName = extractContradictoryWrappedToolName({ toolName, input, description });
        if (contradictoryWrappedToolName) return 'unknown';
        return 'change_title';
    }

    const lower = toolName.toLowerCase();
    if (lower === 'patch') return 'Patch';
    if (lower === 'diff') return 'Diff';
    if (
        lower === 'execute' ||
        lower === 'shell' ||
        lower === 'bash' ||
        toolName === 'GeminiBash' ||
        toolName === 'CodexBash'
    ) {
        return 'Bash';
    }
    if (lower === 'read' || lower === 'read_file' || lower === 'readfile') return 'Read';
    if (lower === 'delete' || lower === 'remove') {
        const changes = asRecord(inputObj?.changes);
        if (changes && Object.keys(changes).length > 0) return 'Patch';
        return 'Delete';
    }
    if (lower === 'edit') {
        if (hasNonEmptyRecord(inputObj?.changes)) return 'Patch';
        return 'Edit';
    }
    if (lower === 'edit_file' || lower === 'editfile') {
        if (hasNonEmptyRecord(inputObj?.changes)) return 'Patch';
        return 'Edit';
    }
    if (lower === 'write') {
        const hasTodos = Array.isArray(inputObj?.todos) && inputObj?.todos.length > 0;
        return hasTodos ? 'TodoWrite' : 'Write';
    }
    if (lower === 'write_file' || lower === 'writefile') {
        const hasTodos = Array.isArray(inputObj?.todos) && inputObj?.todos.length > 0;
        return hasTodos ? 'TodoWrite' : 'Write';
    }

    if (lower === 'glob') return 'Glob';
    if (lower === 'grep') return 'Grep';
    if (lower === 'ls') return 'LS';
    if (lower === 'web_fetch' || lower === 'webfetch') return 'WebFetch';
    if (lower === 'web_search' || lower === 'websearch') return 'WebSearch';

    if (lower === 'search') {
        const hasQuery =
            !!firstNonEmptyString(inputObj?.query) ||
            !!firstNonEmptyString(inputObj?.pattern) ||
            !!firstNonEmptyString(inputObj?.text);
        // Gemini internal "search" often has only items/locations and is intentionally minimal/hidden.
        return hasQuery ? 'CodeSearch' : toolName;
    }

    if (lower === 'unknown tool') {
        const title =
            firstNonEmptyString(inputObj?.title) ??
            firstNonEmptyString(asRecord(inputObj?.toolCall)?.title) ??
            null;
        if (title === 'Workspace Indexing Permission') return 'WorkspaceIndexingPermission';
    }

    return toolName;
}

function resolveSpecificAcpWrappedToolName(toolName: string, input: unknown): string | null {
    const inputObj = asRecord(input);
    const acpTitle = firstNonEmptyString(asRecord(inputObj?._acp)?.title) ?? firstNonEmptyString(inputObj?.title);
    if (!acpTitle || acpTitle.includes(' ')) return null;

    const normalizedToolName = toolName.trim().toLowerCase();
    const normalizedAcpTitle = acpTitle.trim().toLowerCase();
    if (normalizedToolName === normalizedAcpTitle) return null;

    if ((normalizedToolName === 'read' || normalizedToolName === 'read_file' || normalizedToolName === 'readfile') && normalizedAcpTitle === 'web_fetch') {
        return 'WebFetch';
    }
    if (normalizedToolName === 'search' && normalizedAcpTitle === 'web_search') {
        return 'WebSearch';
    }

    return null;
}

export function canonicalizeToolNameForRendering(toolName: string, input: unknown, description?: string | null): string {
    const inputObj = asRecord(input);
    const happier = asRecord(asRecord(inputObj)?._happier);
    const canonicalFromHappier = firstNonEmptyString(happier?.canonicalToolName);
    if (canonicalFromHappier) return canonicalFromHappier;

    // Legacy V2 sessions (pre `_happier` rename) used `_happy`.
    const happy = asRecord(asRecord(inputObj)?._happy);
    const canonicalFromHappy = firstNonEmptyString(happy?.canonicalToolName);
    if (canonicalFromHappy) return canonicalFromHappy;

    const specificAcpWrappedToolName = resolveSpecificAcpWrappedToolName(toolName, input);
    if (specificAcpWrappedToolName) return specificAcpWrappedToolName;

    return canonicalizeToolNameNonV2(toolName, input, description);
}
