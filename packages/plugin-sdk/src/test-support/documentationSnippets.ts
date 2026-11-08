import { readFileSync } from 'node:fs';

export function readFencedCode(
    documentPath: string,
    language: 'ts' | 'tsx',
    selection: number | string = 0,
): string {
    const source = readFileSync(documentPath, 'utf8');
    const blocks = [...source.matchAll(new RegExp(
        ['```', language, '\\n([\\s\\S]*?)\\n```'].join(''),
        'gu',
    ))];
    const matches = typeof selection === 'string' ? blocks.filter((block) => block[1].includes(selection)) : undefined;
    if (matches && matches.length !== 1) throw new Error(`Expected exactly one module containing ${selection} in ${documentPath}`);
    const block = matches ? matches[0]?.[1] : blocks[selection as number]?.[1];
    if (block === undefined) {
        throw new Error(`Expected ${language} code block ${String(selection)} in ${documentPath}`);
    }
    return block;
}

type FencedCodeBlock = Readonly<{
    language: string;
    source: string;
}>;

export function readFencedCodeBlocks(documentPath: string): readonly FencedCodeBlock[] {
    const source = readFileSync(documentPath, 'utf8');
    return [...source.matchAll(/```([^\n]*)\n([\s\S]*?)\n```/gu)].map((match) => ({
        language: match[1].trim(),
        source: match[2],
    }));
}

/**
 * Documentation examples may name a separately compiled companion leaf.
 * Stage maintained source beside the extracted package root for real ESM
 * resolution. Generated-output fixtures prove only declaration compilation;
 * the corresponding composed runtime lane proves the generated document.
 */
export const documentedSnippetSupportFiles = new Map<string, readonly Readonly<{
    destination: string;
} & ({ source: string } | { content: string })>[]>([
    ['quickstart.mdx', [{
        destination: 'ui/surfaces.ts',
        // The quickstart intentionally shows the scaffold's author entry and
        // keeps its one declarative surface in the separate generated leaf.
        // Stage that leaf so the published multi-file example is compiled as
        // written instead of treating its relative import as a missing API.
        content: [
            "import { defineUiSurfaceDefinition } from '@happier-dev/plugin-sdk';",
            '',
            'export const mainSurface = defineUiSurfaceDefinition({',
            "  id: 'main',",
            "  placement: 'appPage',",
            "  title: { key: 'scaffold.main.title', fallback: 'My plugin' },",
            '  renderer: {',
            "    kind: 'declarative',",
            '    root: {',
            "      kind: 'group',",
            "      title: { key: 'scaffold.main.title', fallback: 'My plugin' },",
            '      children: [],',
            '    },',
            '  },',
            '});',
            '',
        ].join('\n'),
    }]],
    ['ui/hosted-web.mdx', [{
        destination: 'ui/summaryDocument.ts',
        // Models the author's generated bundle module for declaration compilation,
        // not a guest runtime or evidence of the ready/bootstrap lifecycle.
        content: [
            "import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/plugin-sdk/ui';",
            '',
            'export const htmlBundle = artifactHtmlBundleFromBodyV1("<!doctype html><html><body>Summary</body></html>");',
            '',
        ].join('\n'),
    }]],
    ['surfaces/external-sessions.mdx', [{
        source: 'advanced-package-root/agent/reviewAgent.ts',
        destination: 'agent/reviewAgent.ts',
    }]],
    ['README.md', [{
        destination: 'issueSource.ts',
        // The guide names the plugin's own provider adapter. This declaration
        // models that external implementation's public contract for compilation
        // only; it is not a fake observer or runtime/continuity evidence.
        content: [
            "import type { PluginCheckpointedEventSourceAdapterV1 } from '@happier-dev/plugin-sdk/background-services';",
            'export declare const issueSource: PluginCheckpointedEventSourceAdapterV1<string, string>;',
        ].join('\n'),
    }]],
]);
