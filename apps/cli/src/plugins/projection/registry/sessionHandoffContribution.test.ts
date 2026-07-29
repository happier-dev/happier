import { describe, expect, it, vi } from 'vitest';

import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';

import {
    readSessionHandoffContribution,
    resolveSessionHandoffSurface,
} from './sessionHandoffContribution';

describe('host-private session handoff contribution', () => {
    it('scopes a stable provider exec service to each handoff operation directory', async () => {
        const createExec = vi.fn((workspaceRoot: string) => createStablePluginExecService({
            allowedExecutables: [],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            async resolveExecutable() {
                throw new Error('executable resolution was not expected');
            },
            async resolvePath(path) {
                return `${workspaceRoot}/${path.relativePath}`;
            },
        }));
        const createSurface = vi.fn(() => ({
            exportBundle: vi.fn(async () => ({
                ok: true as const,
                value: { bundle: {} },
            })),
            importBundle: vi.fn(async (request: Readonly<{ targetDirectory: string }>) => ({
                ok: true as const,
                value: {
                    providerSessionId: 'provider-session-1',
                    launch: { directory: request.targetDirectory },
                },
            })),
        }));
        const contribution = readSessionHandoffContribution({
            surface: createSurface,
        });

        const surface = resolveSessionHandoffSurface(contribution, createExec);

        await expect(surface?.exportBundle({
            sessionId: 'provider-session-1',
            metadata: {},
            directory: '/source-active-server',
        })).resolves.toMatchObject({ ok: true });
        await expect(surface?.importBundle({
            bundle: {},
            targetDirectory: '/target-workspace',
        })).resolves.toMatchObject({ ok: true });
        expect(createExec).toHaveBeenNthCalledWith(1, process.cwd());
        expect(createExec).toHaveBeenNthCalledWith(2, '/source-active-server');
        expect(createExec).toHaveBeenNthCalledWith(3, '/target-workspace');
        expect(createSurface).toHaveBeenCalledTimes(3);
    });

    it('rejects a malformed surface returned by a factory', () => {
        const contribution = readSessionHandoffContribution({
            surface: () => ({
                exportBundle: vi.fn(),
            }),
        });

        expect(resolveSessionHandoffSurface(contribution, () => createStablePluginExecService({
            allowedExecutables: [],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            async resolveExecutable() {
                throw new Error('executable resolution was not expected');
            },
            async resolvePath() {
                throw new Error('path resolution was not expected');
            },
        }))).toBeNull();
    });

    it('projects only the pure replay launch leaf, never a broad provider fork surface', async () => {
        const resolveReplayChildLaunch = vi.fn(async (
            parentMetadata: Readonly<Record<string, unknown>>,
        ) => ({
            environmentVariables: {
                OPENCODE_SERVER_URL: String(parentMetadata.serverBaseUrl),
            },
        }));
        const contribution = readSessionHandoffContribution({
            resolveReplayChildLaunch,
            getForkSurface: vi.fn(),
        });

        await expect(contribution?.resolveReplayChildLaunch?.({
            serverBaseUrl: 'http://127.0.0.1:4096',
        })).resolves.toEqual({
            environmentVariables: {
                OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
            },
        });
        expect(contribution).not.toHaveProperty('getForkSurface');
    });
});
