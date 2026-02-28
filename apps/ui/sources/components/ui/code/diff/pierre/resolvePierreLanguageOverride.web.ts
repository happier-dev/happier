import { getFileLanguageFromPath } from '@/utils/code/fileLanguage';
import { resolveShikiLanguageId } from '@/components/ui/code/highlighting/resolveShikiLanguageId';

/**
 * Pierre expects Shiki-compatible language ids (e.g. `ts`, `js`, `markdown`).
 *
 * Our `getFileLanguageFromPath` returns friendlier names (e.g. `typescript`),
 * so we normalize through `resolveShikiLanguageId` and avoid overriding when the
 * result would be plain text.
 */
export function resolvePierreLanguageOverride(filePath: string | null | undefined): string | null {
    const path = typeof filePath === 'string' ? filePath.trim() : '';
    if (!path) return null;

    const appLanguage = getFileLanguageFromPath(path);
    if (!appLanguage) return null;

    const shikiLanguage = resolveShikiLanguageId(appLanguage);
    if (shikiLanguage === 'text') return null;

    return shikiLanguage;
}
