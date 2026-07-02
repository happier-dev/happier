import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';

describe('ohMyPi execution surfaces (engine registry)', () => {
    it('resolves terminalRuntime + externalSession surfaces via the engine registry path', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-engine-surfaces-home-'));

        const surfaces = await resolveBackendExecutionSurfaces('ohMyPi', { happyHomeDir });

        expect(surfaces.terminalRuntime?.resolveTranscriptBinding).toBeTypeOf('function');

        expect(surfaces.externalSession).toMatchObject({
            validateSource: expect.any(Function),
            listCandidates: expect.any(Function),
            pageTranscript: expect.any(Function),
            readAfterTranscript: expect.any(Function),
            acquireFollowLease: expect.any(Function),
            resolveTakeoverSpawnOptions: expect.any(Function),
        });

        await expect(surfaces.externalSession?.validateSource?.({
            source: { kind: 'ohMyPiAgentDir', agentDir: null },
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: join(happyHomeDir, 'agent-dir'),
            } as NodeJS.ProcessEnv,
        } as never)).resolves.toMatchObject({ ok: true });
    });
});
