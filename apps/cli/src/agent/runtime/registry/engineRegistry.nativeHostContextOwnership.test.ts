import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const PRODUCTION_FILES = [
    './engineRegistry/agentRuntimeLease.ts',
    './engineRegistry/registry.ts',
    './engineRegistry/resolution.ts',
    './engineRegistry/runtimeCore.ts',
    './engineRegistry/nativeAgentSession.ts',
    './engineRegistry/nativeAgentSessionHostServiceOwners.ts',
] as const;

describe('native Agent engine-registry context ownership', () => {
    it('does not route native runtime creation or host services through PluginContextV1 reflection', () => {
        const forbiddenSymbols = [
            'PluginContextV1',
            'createHostPluginContextV1',
            'readPluginContextV1Binder',
            'bindPluginContextToRuntimeCore',
        ] as const;
        const hits = PRODUCTION_FILES.flatMap((path) => {
            const source = readFileSync(new URL(path, import.meta.url), 'utf8');
            return forbiddenSymbols
                .filter((symbol) => source.includes(symbol))
                .map((symbol) => `${path}:${symbol}`);
        });

        expect(hits).toEqual([]);
    });
});
