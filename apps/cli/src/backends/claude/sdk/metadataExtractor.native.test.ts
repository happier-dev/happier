import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { expect, it, vi } from 'vitest';

import { startAnthropicSseBoundary } from './anthropicSseBoundary.testkit';
import { resolveClaudeSessionEnvOverlay } from '../spawn/resolveClaudeSessionEnvOverlay';

it.runIf(Boolean(process.env.HAPPIER_TEST_NATIVE_CLAUDE_PATH))('does not persist cache-miss metadata probes with native history enabled or disabled', async () => {
    const nativePath = process.env.HAPPIER_TEST_NATIVE_CLAUDE_PATH!;
    const root = await mkdtemp(join(tmpdir(), 'happier-native-metadata-'));
    const configDir = join(root, 'claude');
    const projectDir = join(root, 'project');
    await mkdir(configDir);
    await mkdir(projectDir);
    const boundary = await startAnthropicSseBoundary();
    const originalCwd = process.cwd();
    try {
        process.chdir(projectDir);
        vi.stubEnv('HAPPIER_HOME_DIR', join(root, 'happier'));
        vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
        vi.stubEnv('HAPPIER_CLAUDE_PATH', nativePath);
        vi.stubEnv('CLAUDECODE', undefined);
        vi.stubEnv('ANTHROPIC_BASE_URL', boundary.url);
        vi.stubEnv('ANTHROPIC_API_KEY', 'local-test-key');
        vi.stubEnv('ANTHROPIC_AUTH_TOKEN', undefined);
        vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1');
        vi.resetModules();
        const { extractSDKMetadata } = await import('./metadataExtractor');
        for (const enabled of [undefined, false]) {
            const metadata = await extractSDKMetadata({ claudeCodeIncludeInNativeHistory: enabled });
            expect(metadata.tools?.length).toBeGreaterThan(0);
            expect(metadata.slashCommands?.length).toBeGreaterThan(0);
            expect(await extractSDKMetadata({ claudeCodeIncludeInNativeHistory: enabled })).toEqual(metadata);
        }
        // Native startup can update .claude.json; compare attribution with the same current config.
        const { resolveSDKMetadataCacheKey } = await import('./metadataCache');
        const included = resolveSDKMetadataCacheKey({ claudePath: nativePath, entrypoint: 'happier' });
        const excluded = resolveSDKMetadataCacheKey({ claudePath: nativePath });
        expect(included).toBeTruthy();
        expect(excluded).toBeTruthy();
        expect(included?.configFingerprint).not.toBe(excluded?.configFingerprint);

        // Positive control: an ordinary interactive SDK session still has its native history.
        let interactiveId: string | undefined;
        const interactive = query({ prompt: 'hello interactive control', options: {
            cwd: projectDir, env: { ...process.env, ...resolveClaudeSessionEnvOverlay({}) },
            pathToClaudeCodeExecutable: nativePath, settingSources: [], maxTurns: 1,
            model: 'claude-sonnet-4-6',
        } });
        for await (const message of interactive) {
            if (message.type === 'system' && message.subtype === 'init') interactiveId = message.session_id;
            if (message.type === 'result') expect(message.subtype).toBe('success');
        }
        expect(interactiveId).toBeTruthy();
        const files = await readdir(join(configDir, 'projects'), { recursive: true });
        const transcripts = files.filter(path => path.endsWith('.jsonl'));
        const rows = await Promise.all(transcripts.map(async path => ({ path,
            text: await readFile(join(configDir, 'projects', path), 'utf8') })));
        expect(rows.map(row => row.path.split(/[\\/]/).at(-1))).toEqual([`${interactiveId}.jsonl`]);
        expect(rows[0].text).toContain('hello interactive control');
        expect(rows[0].text).toContain('Local native test response.');
        expect(rows[0].text.trim().split('\n').map(line => JSON.parse(line)))
            .toContainEqual(expect.objectContaining({ entrypoint: 'happier' }));
    } finally {
        process.chdir(originalCwd);
        vi.unstubAllEnvs();
        await boundary.close();
        await rm(root, { recursive: true, force: true });
    }
});
