import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_PROFILE_FONT_FILES = { regular: 'Inter-Regular.ttf', medium: 'Inter-Medium.ttf', semiBold: 'Inter-SemiBold.ttf',
    cjk: 'NotoSansCJKsc-Regular.otf', arabic: 'NotoSansArabic-Regular.ttf', emoji: 'NotoEmoji[wght].ttf' } as const;
export type PublicProfileFontFace = keyof typeof PUBLIC_PROFILE_FONT_FILES;

export function publicProfileFontFaceForFilename(filename: string): PublicProfileFontFace | undefined {
    return (Object.keys(PUBLIC_PROFILE_FONT_FILES) as PublicProfileFontFace[]).find(face => PUBLIC_PROFILE_FONT_FILES[face] === filename);
}

/** Source servers and bundled servers use the same shipped faces, never a system-font lookup. */
export async function readPublicProfileFont(face: PublicProfileFontFace): Promise<{ path: string; bytes: Buffer }> {
    const filename = PUBLIC_PROFILE_FONT_FILES[face];
    const candidates = [
        // esbuild runtime: faces staged beside the chunks.
        fileURLToPath(new URL(`./assets/public-profile/${filename}`, import.meta.url)),
        // Bun-compiled executable: import.meta.url is the virtual /$bunfs root, so the
        // payload stages the faces beside the executable instead.
        join(dirname(process.execPath), 'assets', 'public-profile', filename),
    ];
    for (const path of candidates) {
        const staged = await access(path).then(() => true, () => false);
        if (staged) return { path, bytes: await readFile(path) };
    }
    // Source runtime: read from the authoring trees.
    const path = face === 'cjk' || face === 'arabic' || face === 'emoji'
        ? fileURLToPath(new URL(`../../../../../assets/public-profile/${filename}`, import.meta.url))
        : fileURLToPath(new URL(`../../../../../../ui/sources/assets/fonts/${filename}`, import.meta.url));
    return { path, bytes: await readFile(path) };
}
