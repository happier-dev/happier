import { asRecord, firstNonEmptyString } from './_shared';

function coerceSingleLocationPath(locations: unknown): string | null {
    if (!Array.isArray(locations) || locations.length !== 1) return null;
    const first = asRecord(locations[0]);
    if (!first) return null;
    return firstNonEmptyString(first.path) ?? firstNonEmptyString(first.filePath) ?? null;
}

export function normalizeFilePathFromLocations(input: Record<string, unknown>): Record<string, unknown> | null {
    if (typeof input.file_path === 'string' && input.file_path.trim().length > 0) return null;
    const locPath = coerceSingleLocationPath(input.locations);
    if (!locPath) return null;
    return { ...input, file_path: locPath };
}

export function normalizeFilePathAliases(input: Record<string, unknown>): Record<string, unknown> | null {
    const currentFilePath = typeof input.file_path === 'string' ? input.file_path : null;
    const alias =
        typeof input.filePath === 'string'
            ? input.filePath
            : typeof input.path === 'string'
                ? input.path
                : null;
    if (!currentFilePath && alias) {
        return { ...input, file_path: alias };
    }
    return null;
}

export function normalizeFromAcpItems(
    input: Record<string, unknown>,
    opts: { toolNameLower: string },
): Record<string, unknown> | null {
    const items = Array.isArray((input as any).items)
        ? ((input as any).items as unknown[])
        : Array.isArray((input as any).content)
            ? ((input as any).content as unknown[])
            : null;
    if (!items || items.length === 0) return null;
    const first = asRecord(items[0]);
    if (!first) return null;

    const itemPath = firstNonEmptyString(first.path) ?? firstNonEmptyString(first.filePath) ?? null;
    const oldText =
        firstNonEmptyString(first.oldText) ??
        firstNonEmptyString(first.old_string) ??
        firstNonEmptyString(first.oldString) ??
        null;
    const newText =
        firstNonEmptyString(first.newText) ??
        firstNonEmptyString(first.new_string) ??
        firstNonEmptyString(first.newString) ??
        null;

    let changed = false;
    const next: Record<string, unknown> = { ...input };

    if (itemPath && (typeof next.file_path !== 'string' || next.file_path.trim().length === 0)) {
        next.file_path = itemPath;
        changed = true;
    }

    if (opts.toolNameLower === 'write') {
        if (typeof next.content !== 'string' && newText) {
            next.content = newText;
            changed = true;
        }
    }

    if (opts.toolNameLower === 'edit') {
        if (typeof next.old_string !== 'string' && oldText) {
            next.old_string = oldText;
            changed = true;
        }
        if (typeof next.new_string !== 'string' && newText) {
            next.new_string = newText;
            changed = true;
        }
    }

    return changed ? next : null;
}

export function normalizeEditAliases(input: Record<string, unknown>): Record<string, unknown> | null {
    const maybeWithPath = normalizeFilePathAliases(input) ?? input;

    const hasOld = typeof maybeWithPath.old_string === 'string';
    const hasNew = typeof maybeWithPath.new_string === 'string';
    const oldAlias =
        typeof maybeWithPath.oldText === 'string'
            ? maybeWithPath.oldText
            : typeof maybeWithPath.oldString === 'string'
                ? maybeWithPath.oldString
                : null;
    const newAlias =
        typeof maybeWithPath.newText === 'string'
            ? maybeWithPath.newText
            : typeof maybeWithPath.newString === 'string'
                ? maybeWithPath.newString
                : null;

    const next: Record<string, unknown> = { ...maybeWithPath };
    let changed = maybeWithPath !== input;
    if (!hasOld && oldAlias) {
        next.old_string = oldAlias;
        changed = true;
    }
    if (!hasNew && newAlias) {
        next.new_string = newAlias;
        changed = true;
    }
    return changed ? next : null;
}

export function normalizeWriteAliases(input: Record<string, unknown>): Record<string, unknown> | null {
    const maybeWithPath = normalizeFilePathAliases(input) ?? input;

    const currentContent = typeof maybeWithPath.content === 'string' ? maybeWithPath.content : null;
    const alias =
        typeof maybeWithPath.newText === 'string'
            ? maybeWithPath.newText
            : typeof maybeWithPath.text === 'string'
                ? maybeWithPath.text
                : typeof maybeWithPath.file_content === 'string'
                    ? maybeWithPath.file_content
                    : typeof maybeWithPath.fileContent === 'string'
                        ? maybeWithPath.fileContent
                        : typeof maybeWithPath.newString === 'string'
                            ? maybeWithPath.newString
                            : typeof maybeWithPath.new_string === 'string'
                                ? maybeWithPath.new_string
                                : null;

    const next: Record<string, unknown> = { ...maybeWithPath };
    let changed = maybeWithPath !== input;
    if (!currentContent && alias) {
        next.content = alias;
        changed = true;
    }
    return changed ? next : null;
}

export function normalizeDeleteAliases(input: Record<string, unknown>): Record<string, unknown> | null {
    const record = normalizeFilePathAliases(input) ?? input;
    const next: Record<string, unknown> = { ...record };
    let changed = record !== input;

    const current = Array.isArray((record as any).file_paths) ? ((record as any).file_paths as unknown[]) : null;
    const currentPaths =
        current
            ? current
                .filter((v): v is string => typeof v === 'string')
                .map((v) => v.trim())
                .filter((v) => v.length > 0)
            : null;

    if (!currentPaths || currentPaths.length === 0) {
        const single =
            firstNonEmptyString((record as any).file_path) ??
            firstNonEmptyString((record as any).filePath) ??
            firstNonEmptyString((record as any).path) ??
            null;
        if (single) {
            next.file_paths = [single];
            changed = true;
        }
    } else if (currentPaths.length !== current?.length) {
        next.file_paths = currentPaths;
        changed = true;
    }

    return changed ? next : null;
}

