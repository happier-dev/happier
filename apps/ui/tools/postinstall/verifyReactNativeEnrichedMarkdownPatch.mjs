import fs from 'node:fs';
import path from 'node:path';

const PARSER_CACHE_DELETE_MARKER = 'parseCache.delete(cacheKey)';
const MIN_EXPECTED_PARSER_CACHE_DELETE_OCCURRENCES = 4;

function countOccurrences(contents, marker) {
    return contents.split(marker).length - 1;
}

export function verifyReactNativeEnrichedMarkdownPatch({ packageDir }) {
    const enrichedMarkdownTextPath = path.resolve(packageDir, 'lib', 'module', 'web', 'EnrichedMarkdownText.js');
    const streamingRevealPath = path.resolve(packageDir, 'lib', 'module', 'web', 'streamingReveal.js');
    const parseMarkdownPath = path.resolve(packageDir, 'lib', 'module', 'web', 'parseMarkdown.js');
    const parseMarkdownSourcePath = path.resolve(packageDir, 'src', 'web', 'parseMarkdown.ts');
    const enrichedMarkdownTextSourcePath = path.resolve(packageDir, 'src', 'web', 'EnrichedMarkdownText.tsx');
    const wasmBuildScriptPath = path.resolve(packageDir, 'cpp', 'wasm', 'build.sh');
    const wasmSourceModulePath = path.resolve(packageDir, 'src', 'web', 'wasm', 'md4c.js');
    const wasmBuiltModulePath = path.resolve(packageDir, 'lib', 'module', 'web', 'wasm', 'md4c.js');
    const iosTailFadeAnimatorPath = path.resolve(packageDir, 'ios', 'utils', 'ENRMTailFadeInAnimator.m');
    const androidTailFadeAnimatorPath = path.resolve(
        packageDir,
        'android',
        'src',
        'main',
        'java',
        'com',
        'swmansion',
        'enriched',
        'markdown',
        'utils',
        'text',
        'TailFadeInAnimator.kt',
    );

    const requiredPaths = [
        enrichedMarkdownTextPath,
        streamingRevealPath,
        parseMarkdownPath,
        parseMarkdownSourcePath,
        enrichedMarkdownTextSourcePath,
        wasmBuildScriptPath,
        wasmSourceModulePath,
        wasmBuiltModulePath,
        iosTailFadeAnimatorPath,
        androidTailFadeAnimatorPath,
    ];
    if (requiredPaths.some((filePath) => !fs.existsSync(filePath))) return false;

    const enrichedMarkdownTextContents = fs.readFileSync(enrichedMarkdownTextPath, 'utf8');
    const streamingRevealContents = fs.readFileSync(streamingRevealPath, 'utf8');
    const parseMarkdownContents = fs.readFileSync(parseMarkdownPath, 'utf8');
    const parseMarkdownSourceContents = fs.readFileSync(parseMarkdownSourcePath, 'utf8');
    const enrichedMarkdownTextSourceContents = fs.readFileSync(enrichedMarkdownTextSourcePath, 'utf8');
    const wasmBuildScriptContents = fs.readFileSync(wasmBuildScriptPath, 'utf8');
    const wasmSourceModuleContents = fs.readFileSync(wasmSourceModulePath, 'utf8');
    const wasmBuiltModuleContents = fs.readFileSync(wasmBuiltModulePath, 'utf8');
    const wasmSourceModuleBytes = fs.readFileSync(wasmSourceModulePath);
    const wasmBuiltModuleBytes = fs.readFileSync(wasmBuiltModulePath);
    const iosTailFadeAnimatorContents = fs.readFileSync(iosTailFadeAnimatorPath, 'utf8');
    const androidTailFadeAnimatorContents = fs.readFileSync(androidTailFadeAnimatorPath, 'utf8');

    return (
        enrichedMarkdownTextContents.includes('markStreamingRevealOffsets')
        && enrichedMarkdownTextContents.includes('streamingAnimation')
        && enrichedMarkdownTextContents.includes('updateStreamingRevealRanges')
        && parseMarkdownContents.includes('preloadMarkdownRuntime')
        && parseMarkdownContents.includes("import createMd4cModule from './wasm/md4c.js'")
        && !parseMarkdownContents.includes("import('./wasm/md4c")
        && parseMarkdownContents.includes("['number', 'number', 'number', 'number']")
        && parseMarkdownContents.includes('texMathBackslashDelimiters')
        && parseMarkdownContents.includes('stringToUTF8(markdown')
        && countOccurrences(parseMarkdownContents, PARSER_CACHE_DELETE_MARKER)
            >= MIN_EXPECTED_PARSER_CACHE_DELETE_OCCURRENCES
        && !parseMarkdownContents.includes('parseCache.clear()')
        && parseMarkdownSourceContents.includes('lengthBytesUTF8(markdown)')
        && parseMarkdownSourceContents.includes("import createMd4cModule from './wasm/md4c.js'")
        && !parseMarkdownSourceContents.includes("import('./wasm/md4c")
        && parseMarkdownSourceContents.includes('parserPromise = null')
        && parseMarkdownSourceContents.includes('texMathBackslashDelimiters')
        && enrichedMarkdownTextSourceContents.includes('lastChildStyles.paragraph')
        && !enrichedMarkdownTextSourceContents.includes('<pre')
        && wasmBuildScriptContents.includes('STACK_SIZE=8MB')
        && wasmBuildScriptContents.includes('SINGLE_FILE_BINARY_ENCODE=0')
        && wasmBuildScriptContents.includes('ALLOW_MEMORY_GROWTH=1')
        && wasmBuildScriptContents.includes('EXPORT_ES6=1')
        && wasmBuildScriptContents.includes('"_parseMarkdown","_malloc","_free"')
        && wasmBuildScriptContents.includes('"stringToUTF8","lengthBytesUTF8"')
        && wasmSourceModuleContents.includes('export default createMd4cModule')
        && wasmBuiltModuleContents.includes('export default createMd4cModule')
        && !wasmSourceModuleContents.includes('import.meta')
        && !wasmBuiltModuleContents.includes('import.meta')
        && !wasmSourceModuleBytes.includes(0)
        && !wasmBuiltModuleBytes.includes(0)
        && streamingRevealContents.includes('data-happier-enriched-markdown-reveal')
        && streamingRevealContents.includes('updateStreamingRevealRanges')
        && iosTailFadeAnimatorContents.includes('ENRMActiveFadeRange')
        && androidTailFadeAnimatorContents.includes('activeRanges')
    );
}
