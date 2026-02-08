import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function writeFile(filePath: string, contents: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
}

function withTempDir(prefix: string, run: (tmpDir: string) => void) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
        run(tmpDir);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

function runMakeLatestJson(args: ReadonlyArray<string>) {
    const scriptPath = path.resolve(__dirname, '../../../tools/tauri/make-latest-json.mjs');
    execFileSync(process.execPath, [scriptPath, ...args], {
        stdio: 'pipe',
        timeout: 15_000,
    });
}

describe('make-latest-json (tool)', () => {
    it('emits a valid latest.json pointing at GitHub release assets', () => {
        withTempDir('happier-make-latest-json-', (tmp) => {
            const artifactsDir = path.join(tmp, 'artifacts');
            const outPath = path.join(tmp, 'latest.json');

            const repo = 'happier-dev/happier';
            const releaseTag = 'ui-preview';
            const pubDate = '2026-02-06T00:00:00Z';
            const version = '1.2.3-preview.456';
            const notes = 'Rolling preview build.';

            const filesByPlatform: Record<string, { name: string; sig: string }> = {
                'linux-x86_64': { name: 'happier-ui-preview-linux-x86_64.AppImage.tar.gz', sig: 'sig-linux' },
                'windows-x86_64': { name: 'happier-ui-preview-windows-x86_64.msi.zip', sig: 'sig-windows' },
                'darwin-x86_64': { name: 'happier-ui-preview-darwin-x86_64.app.tar.gz', sig: 'sig-macos-intel' },
                'darwin-aarch64': { name: 'happier-ui-preview-darwin-aarch64.app.tar.gz', sig: 'sig-macos-arm' },
            };

            for (const [platformKey, { name, sig }] of Object.entries(filesByPlatform)) {
                const basePath = path.join(artifactsDir, platformKey, name);
                writeFile(basePath, 'payload');
                writeFile(`${basePath}.sig`, sig);
            }

            runMakeLatestJson([
                '--channel',
                'preview',
                '--version',
                version,
                '--pub-date',
                pubDate,
                '--notes',
                notes,
                '--repo',
                repo,
                '--release-tag',
                releaseTag,
                '--artifacts-dir',
                artifactsDir,
                '--out',
                outPath,
            ]);

            const latest = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            expect(latest).toEqual({
                version,
                notes,
                pub_date: pubDate,
                platforms: {
                    'linux-x86_64': {
                        url: `https://github.com/${repo}/releases/download/${releaseTag}/${filesByPlatform['linux-x86_64'].name}`,
                        signature: filesByPlatform['linux-x86_64'].sig,
                    },
                    'windows-x86_64': {
                        url: `https://github.com/${repo}/releases/download/${releaseTag}/${filesByPlatform['windows-x86_64'].name}`,
                        signature: filesByPlatform['windows-x86_64'].sig,
                    },
                    'darwin-x86_64': {
                        url: `https://github.com/${repo}/releases/download/${releaseTag}/${filesByPlatform['darwin-x86_64'].name}`,
                        signature: filesByPlatform['darwin-x86_64'].sig,
                    },
                    'darwin-aarch64': {
                        url: `https://github.com/${repo}/releases/download/${releaseTag}/${filesByPlatform['darwin-aarch64'].name}`,
                        signature: filesByPlatform['darwin-aarch64'].sig,
                    },
                },
            });
        });
    });

    it('trims signature whitespace in latest.json', () => {
        withTempDir('happier-make-latest-json-trim-', (tmp) => {
            const artifactsDir = path.join(tmp, 'artifacts');
            const outPath = path.join(tmp, 'latest.json');

            const filesByPlatform: Record<string, { name: string; sig: string; expected: string }> = {
                'linux-x86_64': {
                    name: 'linux.AppImage.tar.gz',
                    sig: 'sig-linux\n',
                    expected: 'sig-linux',
                },
                'windows-x86_64': {
                    name: 'windows.msi.zip',
                    sig: ' sig-windows \n',
                    expected: 'sig-windows',
                },
                'darwin-x86_64': {
                    name: 'darwin-x86_64.app.tar.gz',
                    sig: '\n sig-macos-intel',
                    expected: 'sig-macos-intel',
                },
                'darwin-aarch64': {
                    name: 'darwin-aarch64.app.tar.gz',
                    sig: '\tsig-macos-arm\t',
                    expected: 'sig-macos-arm',
                },
            };

            for (const [platformKey, { name, sig }] of Object.entries(filesByPlatform)) {
                const basePath = path.join(artifactsDir, platformKey, name);
                writeFile(basePath, 'payload');
                writeFile(`${basePath}.sig`, sig);
            }

            runMakeLatestJson([
                '--channel',
                'preview',
                '--version',
                '1.2.3-preview.1',
                '--pub-date',
                '2026-02-06T00:00:00Z',
                '--notes',
                'preview',
                '--repo',
                'happier-dev/happier',
                '--release-tag',
                'ui-preview',
                '--artifacts-dir',
                artifactsDir,
                '--out',
                outPath,
            ]);

            const latest = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            expect(latest.platforms['linux-x86_64'].signature).toBe(filesByPlatform['linux-x86_64'].expected);
            expect(latest.platforms['windows-x86_64'].signature).toBe(filesByPlatform['windows-x86_64'].expected);
            expect(latest.platforms['darwin-x86_64'].signature).toBe(filesByPlatform['darwin-x86_64'].expected);
            expect(latest.platforms['darwin-aarch64'].signature).toBe(filesByPlatform['darwin-aarch64'].expected);
        });
    });
});
