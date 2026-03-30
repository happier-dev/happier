import { normalizeToolNameForView } from './normalizeToolNameForView';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function firstNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeByKnownKeys(name: string, knownToolKeys: readonly string[]): string {
    if (knownToolKeys.includes(name)) return name;
    const lower = name.toLowerCase();
    const byLower = knownToolKeys.find((k) => k.toLowerCase() === lower);
    if (byLower) return byLower;
    const simplified = lower.replace(/[^a-z0-9]/g, '');
    const bySimplified = knownToolKeys.find((k) => k.toLowerCase().replace(/[^a-z0-9]/g, '') === simplified);
    return bySimplified ?? name;
}

export type InferToolNameResult = {
    normalizedToolName: string;
    source:
        | 'original'
        | 'acpKind'
        | 'toolInputToolName'
        | 'toolInputPermissionToolName'
        | 'toolDescription'
        | 'acpTitle';
};

export function inferToolNameForRendering(params: {
    toolName: string;
    toolInput: unknown;
    toolDescription?: string | null;
    knownToolKeys: readonly string[];
}): InferToolNameResult {
    const legacyNormalized = normalizeToolNameForView(params.toolName);
    const normalizedOriginal = normalizeByKnownKeys(legacyNormalized, params.knownToolKeys);
    const input = asRecord(params.toolInput);
    const acpTitle = firstNonEmptyString(asRecord(input?._acp)?.title) ?? firstNonEmptyString(input?.title);
    if (acpTitle && !acpTitle.includes(' ')) {
        const normalizedAcpTitle = normalizeByKnownKeys(acpTitle, params.knownToolKeys);
        const originalLower = normalizedOriginal.toLowerCase();
        const prefersSpecificAcpTitle =
            (originalLower === 'read' || originalLower === 'search' || originalLower === 'codesearch')
            && normalizedAcpTitle.toLowerCase() !== originalLower
            && params.knownToolKeys.includes(normalizedAcpTitle);
        if (prefersSpecificAcpTitle) {
            return { normalizedToolName: normalizedAcpTitle, source: 'acpTitle' };
        }
    }

    if (normalizedOriginal !== params.toolName || params.knownToolKeys.includes(params.toolName)) {
        return { normalizedToolName: normalizedOriginal, source: 'original' };
    }

    const acpKind = firstNonEmptyString(asRecord(input?._acp)?.kind);
    if (acpKind && acpKind.toLowerCase() !== 'unknown') {
        return { normalizedToolName: normalizeByKnownKeys(acpKind, params.knownToolKeys), source: 'acpKind' };
    }

    const toolInputToolName = firstNonEmptyString(input?.toolName);
    if (toolInputToolName) {
        return { normalizedToolName: normalizeByKnownKeys(toolInputToolName, params.knownToolKeys), source: 'toolInputToolName' };
    }

    const permission = asRecord(input?.permission);
    const permissionToolName = firstNonEmptyString(permission?.toolName);
    if (permissionToolName) {
        return { normalizedToolName: normalizeByKnownKeys(permissionToolName, params.knownToolKeys), source: 'toolInputPermissionToolName' };
    }

    const toolDescription = firstNonEmptyString(params.toolDescription);
    if (toolDescription && !toolDescription.includes(' ')) {
        const normalized = normalizeByKnownKeys(toolDescription, params.knownToolKeys);
        if (normalized !== toolDescription || params.knownToolKeys.includes(toolDescription)) {
            return { normalizedToolName: normalized, source: 'toolDescription' };
        }
    }

    if (acpTitle && !acpTitle.includes(' ')) {
        const normalized = normalizeByKnownKeys(acpTitle, params.knownToolKeys);
        if (normalized !== acpTitle || params.knownToolKeys.includes(acpTitle)) {
            return { normalizedToolName: normalized, source: 'acpTitle' };
        }
    }

    return { normalizedToolName: params.toolName, source: 'original' };
}
