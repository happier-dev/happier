import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(process.cwd(), 'sources');

function collectProductionSourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
        const absolutePath = path.join(directory, entry);
        const stat = statSync(absolutePath);
        if (stat.isDirectory()) {
            if (entry === '__tests__' || entry === 'dev' || entry === 'trash') return [];
            return collectProductionSourceFiles(absolutePath);
        }

        if (!/\.(ts|tsx)$/.test(entry)) return [];
        if (/\.(test|spec)\.(ts|tsx)$/.test(entry)) return [];
        return [absolutePath];
    });
}

describe('theme token reference audit', () => {
    it('does not leave production references to removed grouped or surface tokens', () => {
        const offenders = collectProductionSourceFiles(sourceRoot).flatMap((filePath) => {
            const contents = readFileSync(filePath, 'utf8');
            return contents.match(/\b(?:theme\.colors|props\.theme\.colors|colors)\.(groupped|surfaceHigh|surfaceHighest)\b/g)
                ? [path.relative(process.cwd(), filePath)]
                : [];
        });

        expect(offenders).toEqual([]);
    });

    it('does not leave production references to phantom Happier theme color paths', () => {
        const offenders = collectProductionSourceFiles(sourceRoot).flatMap((filePath) => {
            const contents = readFileSync(filePath, 'utf8');
            return contents.match(/\b(?:theme\.colors|props\.theme\.colors|colors)\.danger\b/g)
                ? [path.relative(process.cwd(), filePath)]
                : [];
        });

        expect(offenders).toEqual([]);
    });

    it('does not leave production references to legacy semantic action color paths', () => {
        const offenders = collectProductionSourceFiles(sourceRoot).flatMap((filePath) => {
            const contents = readFileSync(filePath, 'utf8');
            return contents.match(/\b(?:theme\.colors|props\.theme\.colors|colors)\.(?:warningCritical|deleteAction|textDestructive|success|warning)\b/g)
                ? [path.relative(process.cwd(), filePath)]
                : [];
        });

        expect(offenders).toEqual([]);
    });

    it('does not leave production references to legacy message, syntax, version-control, diff, or terminal color paths', () => {
        const offenders = collectProductionSourceFiles(sourceRoot).flatMap((filePath) => {
            const contents = readFileSync(filePath, 'utf8');
            return contents.match(/\b(?:theme\.colors|props\.theme\.colors|colors)\.(?:userMessageBackground|userMessageText|agentMessageText|agentEventText|syntax[A-Z]\w*|git[A-Z]\w*|terminal\b)|\b(?:theme\.colors|props\.theme\.colors|colors)\.diff\.(?:addedBg|addedText|removedBg|removedText|hunkHeaderBg|hunkHeaderText|inlineAddedBg|inlineAddedText|inlineRemovedBg|inlineRemovedText)\b/g)
                ? [path.relative(process.cwd(), filePath)]
                : [];
        });

        expect(offenders).toEqual([]);
    });

    it('does not leave stale generated CSS variable references for renamed theme tokens', () => {
        const cssPath = path.resolve(process.cwd(), 'sources/theme.css');
        const contents = readFileSync(cssPath, 'utf8');

        expect(contents).not.toMatch(/--colors-(?:groupped|surface-high|surface-highest|divider)/);
    });
});
