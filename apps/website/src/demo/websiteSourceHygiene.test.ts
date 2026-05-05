import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const websiteRoot = path.resolve(__dirname, '../..');
const sourceRoot = path.join(websiteRoot, 'src');
const publicRoot = path.join(websiteRoot, 'public');

function collectGeneratedJavaScriptShadows(directory: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectGeneratedJavaScriptShadows(fullPath));
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.js')) continue;

        const stem = fullPath.slice(0, -'.js'.length);
        if (fs.existsSync(`${stem}.ts`) || fs.existsSync(`${stem}.tsx`)) {
            results.push(path.relative(websiteRoot, fullPath));
        }
    }
    return results.sort();
}

describe('website source hygiene', () => {
    it('does not keep generated JavaScript siblings beside TypeScript source', () => {
        expect(collectGeneratedJavaScriptShadows(sourceRoot)).toEqual([]);
    });

    it('does not keep a JavaScript Vite config beside the TypeScript config', () => {
        expect(fs.existsSync(path.join(websiteRoot, 'vite.config.js'))).toBe(false);
    });

    it('does not keep package-local lockfiles', () => {
        expect(fs.existsSync(path.join(websiteRoot, 'pnpm-lock.yaml'))).toBe(false);
        expect(fs.existsSync(path.join(websiteRoot, 'yarn.lock'))).toBe(false);
    });

    it('keeps public installer and release verification assets available', () => {
        const requiredPublicAssets = [
            'happier-release.pub',
            'install',
            'install.sh',
            'install.ps1',
            'install-preview',
            'install-preview.sh',
            'install-preview.ps1',
            'install-dev',
            'install-dev.sh',
            'install-dev.ps1',
            'install-server',
            'install-server.sh',
        ];

        expect(
            requiredPublicAssets.filter(
                (assetPath) => !fs.existsSync(path.join(websiteRoot, 'public', assetPath)),
            ),
        ).toEqual([]);
    });

    it('does not keep generated cache and backup artifacts in website-owned public or script trees', () => {
        const forbiddenArtifacts = [
            'public/.DS_Store',
            'public/images/.DS_Store',
            'public/images/demo/.DS_Store',
            'public/casts/claude-patio.v3.bak.cast',
            'public/casts/codex-atlas.v3.bak.cast',
            'public/casts/opencode-prism.v3.bak.cast',
            'scripts/__pycache__',
        ];

        expect(
            forbiddenArtifacts.filter((artifactPath) =>
                fs.existsSync(path.join(websiteRoot, artifactPath)),
            ),
        ).toEqual([]);
    });

    it('does not keep hardcoded scenario asset paths that are missing from public/', () => {
        const handoffScenarioPath = path.join(sourceRoot, 'demo', 'scenarios', 'handoff.ts');
        const handoffScenarioSource = fs.readFileSync(handoffScenarioPath, 'utf8');
        const publicAssetReferences = Array.from(
            handoffScenarioSource.matchAll(/['"]\/((?:casts|images|videos)\/[^'"]+)['"]/g),
            (match) => match[1],
        );

        expect(
            publicAssetReferences.filter((assetPath) => !fs.existsSync(path.join(publicRoot, assetPath))),
        ).toEqual([]);
    });
});
