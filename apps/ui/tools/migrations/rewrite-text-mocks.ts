import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../../..');
const sourcesRoot = path.join(repoRoot, 'apps/ui/sources');

function toPosix(p: string): string {
    return p.split(path.sep).join('/');
}

function isTestFile(rel: string): boolean {
    return /\.(spec|test)\.[tj]sx?$/.test(rel);
}

function walk(dir: string, out: string[]): void {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        if (ent.name === 'node_modules') continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            walk(full, out);
            continue;
        }
        out.push(full);
    }
}

function rewriteFile(text: string): { next: string; changed: boolean } {
    const marker = "vi.mock('@/components/ui/text/Text', () => ({";
    let idx = 0;
    let next = text;
    let changed = false;

    while (true) {
        const start = next.indexOf(marker, idx);
        if (start === -1) break;

        const blockStart = start;
        const blockEnd = next.indexOf('}));', blockStart);
        if (blockEnd === -1) break;

        const block = next.slice(blockStart, blockEnd + 4);
        if (block.includes('TextInput')) {
            idx = blockEnd + 4;
            continue;
        }

        const textLineMatch = block.match(/^[ \t]*Text\s*:\s*.+$/m);
        if (!textLineMatch) {
            idx = blockEnd + 4;
            continue;
        }

        const textLine = textLineMatch[0];
        const indent = (textLine.match(/^[ \t]*/) ?? [''])[0];
        const insertion = `${indent}TextInput: 'TextInput',\n`;

        const lineIndex = block.indexOf(textLine);
        const afterLineIndex = block.indexOf('\n', lineIndex);
        if (afterLineIndex === -1) {
            idx = blockEnd + 4;
            continue;
        }

        const newBlock = `${block.slice(0, afterLineIndex + 1)}${insertion}${block.slice(afterLineIndex + 1)}`;
        next = `${next.slice(0, blockStart)}${newBlock}${next.slice(blockEnd + 4)}`;
        changed = true;
        idx = blockStart + newBlock.length;
    }

    return { next, changed };
}

const files: string[] = [];
walk(sourcesRoot, files);

let rewrote = 0;
for (const abs of files) {
    const rel = toPosix(path.relative(repoRoot, abs));
    if (!rel.startsWith('apps/ui/sources/')) continue;
    if (!isTestFile(rel)) continue;

    const text = fs.readFileSync(abs, 'utf8');
    const { next, changed } = rewriteFile(text);
    if (!changed) continue;
    fs.writeFileSync(abs, next, 'utf8');
    rewrote += 1;
    console.log(`REWROTE: ${rel}`);
}

console.log(`Rewrote Text mocks in ${rewrote} files.`);

