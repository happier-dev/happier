import { describe, expect, it, vi } from 'vitest';
import { EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1 } from '@happier-dev/protocol';

import { emitExternalSessionTranscriptRefreshInvalidation } from './emitExternalSessionTranscriptRefreshInvalidation';

describe('emitExternalSessionTranscriptRefreshInvalidation', () => {
    it('emits only a current content-free binding for a non-empty cursor', async () => {
        const binding = {
            v: 1 as const,
            machineId: 'machine-1',
            sessionId: 'session-1',
            link: {
                generation: 'link-1',
                remoteSessionId: 'remote-1',
            },
            source: {
                qualifiedIdentity: {
                    v: 1 as const,
                    agent: {
                        pluginId: 'happier.opencode',
                        localId: 'opencode',
                    },
                    source: {
                        kind: 'opencodeServer',
                        contractVersion: 1 as const,
                    },
                },
                generation: 'source-1',
            },
            contributionGeneration: 'plugin-1',
            cursorIdentity: `external_session_cursor_binding_v1:${'a'.repeat(64)}`,
        };
        const resolveTranscriptRefreshBinding = vi.fn(async () => binding);
        const emitExternalSessionTranscriptUpdate = vi.fn(async () => {});
        const deviceLocalSecretStorage = {
            deriveOpaqueIdentity: vi.fn(() => 'a'.repeat(64)),
        } as never;

        await emitExternalSessionTranscriptRefreshInvalidation({
            sessionId: 'session-1',
            cursor: 'cursor-1',
            deviceLocalSecretStorage,
            resolveTranscriptRefreshBinding,
            emitExternalSessionTranscriptUpdate,
        });

        expect(resolveTranscriptRefreshBinding).toHaveBeenCalledWith({
            sessionId: 'session-1',
            cursor: 'cursor-1',
            deviceLocalSecretStorage,
        });
        expect(emitExternalSessionTranscriptUpdate).toHaveBeenCalledWith({
            v: 1,
            type: EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1,
            binding,
        });
    });

    it('emits nothing when the cursor or current binding is absent', async () => {
        const resolveTranscriptRefreshBinding = vi.fn(async () => null);
        const emitExternalSessionTranscriptUpdate = vi.fn(async () => {});

        await emitExternalSessionTranscriptRefreshInvalidation({
            sessionId: 'session-1',
            cursor: null,
            resolveTranscriptRefreshBinding,
            emitExternalSessionTranscriptUpdate,
        });
        await emitExternalSessionTranscriptRefreshInvalidation({
            sessionId: 'session-1',
            cursor: 'cursor-1',
            resolveTranscriptRefreshBinding,
            emitExternalSessionTranscriptUpdate,
        });

        expect(resolveTranscriptRefreshBinding).toHaveBeenCalledTimes(1);
        expect(emitExternalSessionTranscriptUpdate).not.toHaveBeenCalled();
    });

    it('emits nothing when manager currentness changes while resolving the binding', async () => {
        let resolveBinding: ((value: Readonly<{
            v: 1;
            machineId: string;
            sessionId: string;
            link: Readonly<{ generation: string; remoteSessionId: string }>;
            source: Readonly<{
                qualifiedIdentity: Readonly<{
                    v: 1;
                    agent: Readonly<{ pluginId: string; localId: string }>;
                    source: Readonly<{ kind: string; contractVersion: 1 }>;
                }>;
                generation: string;
            }>;
            contributionGeneration: string;
            cursorIdentity: string;
        }>) => void) | undefined;
        const bindingPromise = new Promise<Readonly<{
            v: 1;
            machineId: string;
            sessionId: string;
            link: Readonly<{ generation: string; remoteSessionId: string }>;
            source: Readonly<{
                qualifiedIdentity: Readonly<{
                    v: 1;
                    agent: Readonly<{ pluginId: string; localId: string }>;
                    source: Readonly<{ kind: string; contractVersion: 1 }>;
                }>;
                generation: string;
            }>;
            contributionGeneration: string;
            cursorIdentity: string;
        }>>((resolve) => {
            resolveBinding = resolve;
        });
        let current = true;
        const emitExternalSessionTranscriptUpdate = vi.fn(async () => {});
        const pending = emitExternalSessionTranscriptRefreshInvalidation({
            sessionId: 'session-1',
            cursor: 'cursor-1',
            isCurrent: () => current,
            resolveTranscriptRefreshBinding: async () => await bindingPromise,
            emitExternalSessionTranscriptUpdate,
        });

        current = false;
        resolveBinding?.({
            v: 1,
            machineId: 'machine-1',
            sessionId: 'session-1',
            link: { generation: 'link-1', remoteSessionId: 'remote-1' },
            source: {
                qualifiedIdentity: {
                    v: 1,
                    agent: {
                        pluginId: 'happier.opencode',
                        localId: 'opencode',
                    },
                    source: {
                        kind: 'opencodeServer',
                        contractVersion: 1,
                    },
                },
                generation: 'source-1',
            },
            contributionGeneration: 'plugin-1',
            cursorIdentity: `external_session_cursor_binding_v1:${'a'.repeat(64)}`,
        });
        await pending;

        expect(emitExternalSessionTranscriptUpdate).not.toHaveBeenCalled();
    });
});
