import { afterEach, describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEnvKeyScope } from '@/testkit/env/envScope';

import { codexPreflightSessionControlsProbeAdapter } from './codexPreflightSessionControlsProbeAdapter';

function makeTempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

const envKeys = [
    'HAPPIER_CODEX_APP_SERVER_BIN',
    'HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS',
    'HAPPIER_FAKE_CODEX_APP_SERVER_DELAY_MS',
    'OPENAI_API_KEY',
] as const;

let envScope = createEnvKeyScope(envKeys);

afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
});

describe('codexPreflightSessionControlsProbeAdapter', () => {
    let tempDir: string | null = null;

    afterEach(() => {
        if (tempDir) {
            rmSync(tempDir, { recursive: true, force: true });
            tempDir = null;
        }
    });

    it('uses the probe timeout when spawning Codex app-server so model-scoped options do not disappear on slow model/list calls', async () => {
        tempDir = makeTempDir('happier-codex-preflight-controls-');

        const fakeAppServerPath = fileURLToPath(new URL('./__fixtures__/fakeCodexAppServer.mjs', import.meta.url));
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServerPath;
        process.env.HAPPIER_FAKE_CODEX_APP_SERVER_DELAY_MS = '600';

        // Set an artificially small RPC timeout so the test proves the adapter overrides it.
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '250';
        // Force Speed to be ineligible (the real gating hides it when auth is API-key based).
        process.env.OPENAI_API_KEY = 'test';

        const raw = await codexPreflightSessionControlsProbeAdapter.probeModelsRaw?.({
            cwd: tempDir,
            timeoutMs: 2_000,
            backendTarget: undefined,
            accountSettings: null,
        });

        expect(Array.isArray(raw)).toBe(true);
        expect(raw).toEqual([
            {
                id: 'gpt-5.4',
                name: 'GPT 5.4',
                description: 'Latest frontier agentic coding model.',
                modelOptions: [
                    {
                        id: 'reasoning_effort',
                        name: 'Thinking',
                        type: 'select',
                        currentValue: 'medium',
                        options: [
                            { value: 'low', name: 'Low', description: 'Low' },
                            { value: 'medium', name: 'Medium', description: 'Medium' },
                            { value: 'high', name: 'High', description: 'High' },
                        ],
                    },
                ],
            },
        ]);
    });
});
