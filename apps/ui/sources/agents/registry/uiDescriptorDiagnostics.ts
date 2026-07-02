export type UiProjectionDiagnosticCode =
    | 'A16X1_UNSUPPORTED_DESCRIPTOR_KIND'
    | 'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER'
    | 'A16X1_MALFORMED_DESCRIPTOR'
    | 'A16X1_UNKNOWN_COMPONENT_ID';

export type UiProjectionDiagnostic = Readonly<{
    code: UiProjectionDiagnosticCode;
    path: string;
    message: string;
}>;

export function createUiProjectionDiagnostic(
    code: UiProjectionDiagnosticCode,
    path: string,
    message: string,
): UiProjectionDiagnostic {
    return { code, path, message };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function readStringArray(value: unknown): readonly string[] {
    if (!Array.isArray(value)) return [];
    const values: string[] = [];
    for (const entry of value) {
        const normalized = readString(entry);
        if (normalized) values.push(normalized);
    }
    return values;
}
