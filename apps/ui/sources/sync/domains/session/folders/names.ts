import { SESSION_FOLDER_MAX_NAME_LENGTH } from './constants';

export function normalizeSessionFolderName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    return normalized.slice(0, SESSION_FOLDER_MAX_NAME_LENGTH).trim();
}

export function makeSiblingUniqueSessionFolderName(name: string, siblingNames: ReadonlySet<string>): string {
    const base = normalizeSessionFolderName(name);
    if (!base) return 'Folder';
    if (!siblingNames.has(base.toLocaleLowerCase())) return base;

    for (let index = 2; index < 10_000; index += 1) {
        const suffix = ` ${index}`;
        const candidate = `${base.slice(0, SESSION_FOLDER_MAX_NAME_LENGTH - suffix.length).trim()}${suffix}`;
        if (!siblingNames.has(candidate.toLocaleLowerCase())) return candidate;
    }

    return `${base.slice(0, SESSION_FOLDER_MAX_NAME_LENGTH - 5).trim()} copy`;
}
