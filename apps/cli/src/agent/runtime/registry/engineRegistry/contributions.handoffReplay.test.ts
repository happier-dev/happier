import { describe, expect, it, vi } from 'vitest';

import type { ResolvedCatalogEntry } from '@/plugins/projection/registry/types';
import {
    resolveCatalogExecutionSurfacesForFirstPartyBackend,
} from './contributions';

describe('catalog execution surface handoff/replay projection', () => {
    it('projects only the narrow replay child launch resolver into the host fork owner', async () => {
        const resolveReplayChildLaunch = vi.fn(async (
            parentMetadata: Readonly<Record<string, unknown>>,
        ) => ({
            environmentVariables: {
                OPENCODE_SERVER_URL: String(parentMetadata.serverBaseUrl),
            },
        }));
        const entry = {
            resolveReplayChildLaunch,
        } as unknown as ResolvedCatalogEntry;

        const surfaces = await resolveCatalogExecutionSurfacesForFirstPartyBackend({
            backend: {
                id: 'opencode',
                agentId: 'opencode',
                pluginId: 'happier.agent.opencode',
                packageName: '@happier-dev/plugins-opencode',
                provenance: 'bundled',
            } as never,
            entry,
        });

        await expect(surfaces.fork?.resolveReplayChildLaunch?.({
            parentSessionId: 'parent-session',
            parentMetadata: { serverBaseUrl: 'http://127.0.0.1:4096' },
            directory: '/repo',
            forkPoint: { kind: 'latest' },
        })).resolves.toEqual({
            environmentVariables: {
                OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
            },
        });
        expect(resolveReplayChildLaunch).toHaveBeenCalledWith({
            serverBaseUrl: 'http://127.0.0.1:4096',
        });
        expect(surfaces.fork).not.toHaveProperty('fork');
        expect(surfaces.fork).not.toHaveProperty('evaluateAvailability');
    });
});
