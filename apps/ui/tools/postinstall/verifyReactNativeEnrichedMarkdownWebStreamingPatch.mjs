import fs from 'node:fs';
import path from 'node:path';

export const REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES = Object.freeze([
    'lib/module/web/EnrichedMarkdownText.js',
    'lib/module/web/parseMarkdown.js',
    'lib/module/web/streamingReveal.d.ts',
    'lib/module/web/streamingReveal.js',
    'lib/typescript/src/types/MarkdownStyle.d.ts',
    'lib/typescript/src/web/streamingReveal.d.ts',
    'src/web/EnrichedMarkdownText.tsx',
    'src/web/parseMarkdown.ts',
    'src/web/streamingReveal.ts',
    'cpp/wasm/build.sh',
    'src/web/wasm/md4c.js',
    'lib/module/web/wasm/md4c.js',
    'ios/utils/ENRMTailFadeInAnimator.m',
    'android/src/main/java/com/swmansion/enriched/markdown/utils/text/TailFadeInAnimator.kt',
]);

export const REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_MARKERS = Object.freeze([
    ['lib/module/web/EnrichedMarkdownText.js', 'markStreamingRevealOffsets'],
    ['lib/module/web/EnrichedMarkdownText.js', 'streamingAnimation'],
    ['lib/module/web/EnrichedMarkdownText.js', 'updateStreamingRevealRanges'],
    ['lib/module/web/streamingReveal.js', 'data-happier-enriched-markdown-reveal'],
    ['lib/module/web/streamingReveal.js', 'updateStreamingRevealRanges'],
    ['lib/module/web/streamingReveal.js', 'splitStreamingRevealTextParts'],
    ['lib/module/web/streamingReveal.d.ts', "../../typescript/src/web/streamingReveal"],
    ['lib/typescript/src/types/MarkdownStyle.d.ts', 'texMathBackslashDelimiters?: boolean'],
    ['lib/typescript/src/web/streamingReveal.d.ts', 'splitStreamingRevealTextParts'],
    ['src/web/streamingReveal.ts', 'splitStreamingRevealTextParts'],
    ['src/web/streamingReveal.ts', 'updateStreamingRevealRanges'],
    ['lib/module/web/parseMarkdown.js', 'preloadMarkdownRuntime'],
    ['lib/module/web/parseMarkdown.js', "import createMd4cModule from './wasm/md4c.js'"],
    ['lib/module/web/parseMarkdown.js', "['number', 'number', 'number', 'number']"],
    ['lib/module/web/parseMarkdown.js', 'texMathBackslashDelimiters'],
    ['lib/module/web/parseMarkdown.js', 'stringToUTF8(markdown'],
    ['lib/module/web/parseMarkdown.js', 'parseCache.delete(cacheKey)', 4],
    ['src/web/parseMarkdown.ts', 'lengthBytesUTF8(markdown)'],
    ['src/web/parseMarkdown.ts', "import createMd4cModule from './wasm/md4c.js'"],
    ['src/web/parseMarkdown.ts', 'parserPromise = null'],
    ['src/web/parseMarkdown.ts', 'texMathBackslashDelimiters'],
    ['src/web/EnrichedMarkdownText.tsx', 'lastChildStyles.paragraph'],
    ['cpp/wasm/build.sh', 'STACK_SIZE=8MB'],
    ['cpp/wasm/build.sh', 'SINGLE_FILE_BINARY_ENCODE=0'],
    ['cpp/wasm/build.sh', 'ALLOW_MEMORY_GROWTH=1'],
    ['cpp/wasm/build.sh', 'EXPORT_ES6=1'],
    ['cpp/wasm/build.sh', '"_parseMarkdown","_malloc","_free"'],
    ['cpp/wasm/build.sh', '"stringToUTF8","lengthBytesUTF8"'],
    ['src/web/wasm/md4c.js', 'export default createMd4cModule'],
    ['lib/module/web/wasm/md4c.js', 'export default createMd4cModule'],
    ['ios/utils/ENRMTailFadeInAnimator.m', 'ENRMActiveFadeRange'],
    ['android/src/main/java/com/swmansion/enriched/markdown/utils/text/TailFadeInAnimator.kt', 'activeRanges'],
]);

export const REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_FORBIDDEN_MARKERS = Object.freeze([
    ['lib/module/web/parseMarkdown.js', "import('./wasm/md4c"],
    ['lib/module/web/parseMarkdown.js', 'parseCache.clear()'],
    ['src/web/parseMarkdown.ts', "import('./wasm/md4c"],
    ['src/web/EnrichedMarkdownText.tsx', '<pre'],
    ['src/web/wasm/md4c.js', 'import.meta'],
    ['lib/module/web/wasm/md4c.js', 'import.meta'],
]);

export function findReactNativeEnrichedMarkdownPackageDirs({ repoRootDir, expoAppDir }) {
    return [
        path.resolve(repoRootDir, 'node_modules', 'react-native-enriched-markdown'),
        path.resolve(expoAppDir, 'node_modules', 'react-native-enriched-markdown'),
    ].filter((packageDir) => fs.existsSync(packageDir));
}

function readFile(packageDir, relativePath) {
    try {
        return fs.readFileSync(path.resolve(packageDir, relativePath), 'utf8');
    } catch {
        return null;
    }
}

/**
 * Certifies the installed artifacts rather than re-parsing the patch. The UI runtime resolves the
 * app-local package directly, so a syntactically valid patch file cannot prove that the dependency
 * copy Metro/Vitest consumes actually has the patch-owned module and its matching source/types.
 */
export function verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir }) {
    if (!fs.existsSync(packageDir)) {
        return {
            status: 'missing',
            missingFiles: ['(package directory)'],
            missingMarkers: [],
            forbiddenMarkers: [],
            binaryFiles: [],
        };
    }

    const missingFiles = REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES.filter((relativePath) => !fs.existsSync(path.resolve(packageDir, relativePath)));
    const contentsByFile = new Map();
    for (const relativePath of REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES) {
        const contents = readFile(packageDir, relativePath);
        if (contents !== null) contentsByFile.set(relativePath, contents);
    }

    const missingMarkers = REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_MARKERS.filter(([relativePath, marker, minOccurrences = 1]) => {
        const contents = contentsByFile.get(relativePath);
        return contents === undefined || contents.split(marker).length - 1 < minOccurrences;
    });
    const forbiddenMarkers = REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_FORBIDDEN_MARKERS.filter(([relativePath, marker]) => {
        const contents = contentsByFile.get(relativePath);
        return contents !== undefined && contents.includes(marker);
    });
    const binaryFiles = [
        'src/web/wasm/md4c.js',
        'lib/module/web/wasm/md4c.js',
    ].filter((relativePath) => {
        try {
            return fs.readFileSync(path.resolve(packageDir, relativePath)).includes(0);
        } catch {
            return false;
        }
    });

    return {
        status: missingFiles.length || missingMarkers.length || forbiddenMarkers.length || binaryFiles.length ? 'failed' : 'ok',
        missingFiles,
        missingMarkers,
        forbiddenMarkers,
        binaryFiles,
    };
}

export function formatReactNativeEnrichedMarkdownWebStreamingPatchFailure(result) {
    const lines = ['react-native-enriched-markdown web streaming patch is not installed correctly:'];
    for (const relativePath of result.missingFiles) lines.push(`  - missing ${relativePath}`);
    for (const [relativePath, marker, minOccurrences = 1] of result.missingMarkers) {
        const occurrenceRequirement = minOccurrences > 1 ? ` at least ${minOccurrences} times` : '';
        lines.push(`  - ${relativePath} is missing ${JSON.stringify(marker)}${occurrenceRequirement}`);
    }
    for (const [relativePath, marker] of result.forbiddenMarkers) lines.push(`  - ${relativePath} still contains forbidden ${JSON.stringify(marker)}`);
    for (const relativePath of result.binaryFiles) lines.push(`  - ${relativePath} contains a NUL byte instead of the vendored JavaScript module`);
    lines.push('Run the canonical UI dependency preparation: yarn --cwd apps/ui postinstall:real');
    return lines.join('\n');
}
