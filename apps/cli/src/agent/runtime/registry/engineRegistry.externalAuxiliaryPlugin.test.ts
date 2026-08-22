import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES } from '@happier-dev/protocol';

import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from '@/session/external/agentExternalSessionsInvocation';

import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const PLUGIN_ID = 'acme.external-sessions-only';
const AGENT_ID = 'external-only-agent';
const HANDOFF_PLUGIN_ID = 'acme.external-handoff';
const HANDOFF_AGENT_ID = 'external-handoff-agent';

const source = Object.freeze({
    sourceKind: 'synthetic',
    schema: Object.freeze({
        fields: Object.freeze([{ name: 'kind', kind: 'literal', value: 'synthetic' }]),
    }),
    key: Object.freeze({
        segments: Object.freeze([{ kind: 'literal', value: 'synthetic' }]),
    }),
    instances: Object.freeze([{ kind: 'default', constants: Object.freeze({}) }]),
});

async function materializeAuxiliaryOnlyPlugin(pluginRoot: string): Promise<void> {
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
        schemaVersion: 2,
        id: PLUGIN_ID,
        version: '1.0.0',
        displayName: 'External Sessions only fixture',
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        hostAccess: { required: [], optional: [] },
        contributes: {
            agents: [{
                id: AGENT_ID,
                title: 'External-only Agent',
                capabilities: { surfaces: ['externalSessions'] },
                surfaces: { externalSession: { sources: [source] } },
            }],
        },
    }), 'utf8');
    await writeFile(join(pluginRoot, 'daemon.mjs'), `
        const encoder = new TextEncoder();
        const abortedMethods = new Set();

        function utf8Bytes(value) {
            return encoder.encode(JSON.stringify(value)).byteLength;
        }

        function utf8Padding(byteLength) {
            const emojiCount = Math.floor(byteLength / 4);
            return '🙂'.repeat(emojiCount) + 'x'.repeat(byteLength % 4);
        }

        function createLinkData(extraBytes = 0) {
            const base = { payload: '' };
            const paddingBytes = ${MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES}
                + extraBytes
                - utf8Bytes(base);
            const result = { payload: utf8Padding(paddingBytes) };
            if (
                utf8Bytes(result)
                !== ${MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES} + extraBytes
            ) {
                throw new Error('Synthetic linkData did not reach the exact UTF-8 byte target');
            }
            return result;
        }

        function createCandidateResultAtSerializedBytes(targetBytes, extraBytes = 0) {
            const expectedBytes = targetBytes + extraBytes;
            const candidates = [];
            while (candidates.length < 50) {
                const index = candidates.length;
                candidates.push(candidate(index, { linkData: { payload: '' } }));
                const seed = {
                    ok: true,
                    value: { candidates, nextCursor: null },
                };
                const remainingBytes = expectedBytes - utf8Bytes(seed);
                const maximumPayloadBytes = ${MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES}
                    - utf8Bytes({ payload: '' });
                if (remainingBytes <= maximumPayloadBytes) {
                    if (remainingBytes < 0) {
                        throw new Error('Synthetic candidate envelope overshot the requested byte target');
                    }
                    candidates[index] = candidate(index, {
                        linkData: { payload: utf8Padding(remainingBytes) },
                    });
                    if (utf8Bytes(seed) !== expectedBytes) {
                        throw new Error('Synthetic candidate envelope did not reach the exact UTF-8 byte target');
                    }
                    return seed;
                }
                candidates[index] = candidate(index, { linkData: createLinkData() });
            }
            throw new Error('Synthetic candidate envelope could not reach the requested byte target');
        }

        async function maybeDelay(request, method) {
            const mode = request.source?.mode
                ?? request.searchTerm
                ?? request.cursor
                ?? request.remoteSessionId;
            if (
                mode === 'delayed'
                || mode === 'after-deadline'
            ) {
                await new Promise((resolve) => {
                    const signal = request.signal;
                    const timer = setTimeout(
                        finish,
                        mode === 'after-deadline'
                            ? ${EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs + 100}
                            : 100,
                    );
                    function finish() {
                        clearTimeout(timer);
                        signal?.removeEventListener('abort', onAbort);
                        resolve();
                    }
                    function onAbort() {
                        abortedMethods.add(method);
                        finish();
                    }
                    if (signal?.aborted) {
                        onAbort();
                    } else {
                        signal?.addEventListener('abort', onAbort, { once: true });
                    }
                });
            }
        }

        function candidate(index, overrides = {}) {
            return {
                remoteSessionId: 'remote-' + index,
                title: 'Synthetic external session ' + index,
                updatedAtMs: 2,
                createdAtMs: 1,
                linkData: { sourceGeneration: 'source-generation-1' },
                ...overrides,
            };
        }

        function transcriptItem(index) {
            return {
                id: 'message-' + index,
                createdAtMs: index + 3,
                messageRole: 'agent',
                raw: { text: 'synthetic transcript ' + index },
            };
        }

        export function activate(api) {
            api.agents.registerExternalSessions('${AGENT_ID}', {
                async resolveSource(request) {
                    await maybeDelay(request, 'resolveSource');
                    if (request.source.mode === 'malformed-outcome') {
                        return { ok: true, value: { source: request.source, unexpected: true } };
                    }
                    return { ok: true, value: { source: request.source } };
                },
                async listCandidates(request) {
                    await maybeDelay(request, 'listCandidates');
                    if (request.searchTerm === 'observed-aborts') {
                        return {
                            ok: true,
                            value: {
                                candidates: [...abortedMethods].map((method, index) =>
                                    candidate(index, { remoteSessionId: 'aborted-' + method })
                                ),
                                nextCursor: null,
                            },
                        };
                    }
                    if (request.searchTerm === 'malformed-outcome') {
                        return {
                            ok: true,
                            value: { candidates: [], nextCursor: null, unexpected: true },
                        };
                    }
                    if (request.searchTerm === 'malformed-failure') {
                        return {
                            ok: false,
                            code: 'source_unreachable',
                            retryable: true,
                            unexpected: true,
                        };
                    }
                    if (
                        request.searchTerm === 'max-cursor'
                        || request.searchTerm === 'max-cursor-plus-one'
                    ) {
                        return {
                            ok: true,
                            value: {
                                candidates: [],
                                nextCursor: 'c'.repeat(
                                    ${EXTERNAL_SESSIONS_INVOCATION_POLICY.nativeCursorMaxCodeUnits}
                                    + (request.searchTerm === 'max-cursor-plus-one' ? 1 : 0),
                                ),
                            },
                        };
                    }
                    if (request.searchTerm === 'max-items') {
                        return {
                            ok: true,
                            value: {
                                candidates: Array.from(
                                    { length: request.maxItems },
                                    (_, index) => candidate(index),
                                ),
                                nextCursor: null,
                            },
                        };
                    }
                    if (request.searchTerm === 'max-items-plus-one') {
                        return {
                            ok: true,
                            value: {
                                candidates: Array.from(
                                    { length: request.maxItems + 1 },
                                    (_, index) => candidate(index),
                                ),
                                nextCursor: null,
                            },
                        };
                    }
                    if (
                        request.searchTerm === 'max-serialized-bytes'
                        || request.searchTerm === 'max-serialized-bytes-plus-one'
                    ) {
                        return createCandidateResultAtSerializedBytes(
                            request.maxSerializedBytes,
                            request.searchTerm === 'max-serialized-bytes-plus-one' ? 1 : 0,
                        );
                    }
                    return {
                        ok: true,
                        value: {
                            candidates: [candidate(1)].slice(0, request.maxItems),
                            nextCursor: null,
                        },
                    };
                },
                async resolveLinkIdentity(request) {
                    await maybeDelay(request, 'resolveLinkIdentity');
                    return {
                        ok: true,
                        value: {
                            source: request.source,
                            remoteSessionId: request.remoteSessionId,
                            linkData: request.remoteSessionId === 'max-link-data'
                                ? createLinkData()
                                : request.remoteSessionId === 'max-link-data-plus-one'
                                    ? createLinkData(1)
                                    : request.linkData ?? { sourceGeneration: 'source-generation-1' },
                        },
                    };
                },
                async resolveLinkedIdentity(request) {
                    await maybeDelay(request, 'resolveLinkedIdentity');
                    return {
                        ok: true,
                        value: {
                            source: request.source,
                            remoteSessionId: request.remoteSessionId,
                            linkData: request.linkData,
                        },
                    };
                },
                async pageTranscript(request) {
                    await maybeDelay(request, 'pageTranscript');
                    if (
                        request.cursor === 'max-items'
                        || request.cursor === 'max-items-plus-one'
                    ) {
                        const extraItems = request.cursor === 'max-items-plus-one' ? 1 : 0;
                        return {
                            ok: true,
                            value: {
                                items: Array.from(
                                    { length: request.maxItems + extraItems },
                                    (_, index) => transcriptItem(index),
                                ),
                                nextCursor: null,
                                tailCursor: 'tail-max',
                                hasMore: false,
                            },
                        };
                    }
                    return {
                        ok: true,
                        value: {
                            items: request.maxItems > 0 ? [transcriptItem(1)] : [],
                            nextCursor: null,
                            tailCursor: 'tail-1',
                            hasMore: false,
                        },
                    };
                },
                async readAfterTranscript(request) {
                    await maybeDelay(request, 'readAfterTranscript');
                    if (
                        request.cursor === 'max-items'
                        || request.cursor === 'max-items-plus-one'
                    ) {
                        const extraItems = request.cursor === 'max-items-plus-one' ? 1 : 0;
                        return {
                            ok: true,
                            value: {
                                outcome: 'advanced',
                                items: Array.from(
                                    { length: request.maxItems + extraItems },
                                    (_, index) => transcriptItem(index),
                                ),
                                nextCursor: 'max-items-next',
                                boundary: 'max-items-boundary',
                            },
                        };
                    }
                    return {
                        ok: true,
                        value: {
                            outcome: 'advanced',
                            items: request.maxItems > 0 ? [transcriptItem(2)] : [],
                            nextCursor: 'tail-2',
                            boundary: 'message-2',
                        },
                    };
                },
            });
        }
    `, 'utf8');
}

async function materializeExternalHandoffPlugin(pluginRoot: string): Promise<void> {
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
        schemaVersion: 2,
        id: HANDOFF_PLUGIN_ID,
        version: '1.0.0',
        displayName: 'External handoff fixture',
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        hostAccess: { required: [], optional: [] },
        contributes: {
            agents: [{
                id: HANDOFF_AGENT_ID,
                title: 'External handoff Agent',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                    sessions: {
                        open: ['create'],
                        delivery: ['newTurn'],
                        cancel: true,
                    },
                },
            }],
        },
    }), 'utf8');
    await writeFile(join(pluginRoot, 'agent-runtime.mjs'), `
        export async function externalHandoffRuntimeFactory(factoryContext) {
            return {
                sessions: {
                    open: async () => ({
                        send: async () => ({ status: 'admitted' }),
                        stop: async () => ({ status: 'requested' }),
                        watch: () => ({ dispose: () => undefined }),
                        dispose: async () => undefined,
                    }),
                },
                surfaces: {
                    handoff: {
                        exportBundle: async (request, context) => ({
                            ok: true,
                            value: {
                                bundle: {
                                    vendorSessionId: request.sessionId,
                                    contextSessionId: context.session?.id ?? null,
                                    hasOperationServices: typeof context.services === 'object',
                                    hasOperationAbortSignal: typeof context.signal?.addEventListener === 'function',
                                    factoryReceivedServices: Object.prototype.hasOwnProperty.call(factoryContext, 'services'),
                                },
                            },
                        }),
                        importBundle: async (request) => ({
                            ok: true,
                            value: {
                                providerSessionId: String(request.bundle.vendorSessionId ?? 'imported-session'),
                                launch: {
                                    directory: request.targetDirectory,
                                    environmentVariables: {},
                                },
                            },
                        }),
                    },
                },
            };
        }
    `, 'utf8');
    await writeFile(join(pluginRoot, 'daemon.mjs'), `
        import { externalHandoffRuntimeFactory } from './agent-runtime.mjs';

        export function activate(api) {
            api.agents.register('${HANDOFF_AGENT_ID}', externalHandoffRuntimeFactory, {
                sessionRunnerFactory: {
                    module: './agent-runtime.mjs',
                    export: 'externalHandoffRuntimeFactory',
                    runtimeApiVersion: 1,
                },
            });
        }
    `, 'utf8');
}

describe('non-bundled auxiliary-only Agent contribution', () => {
    it('activates, catalogs, and resolves External Sessions without a primary runtime factory', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-external-aux-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-external-aux-plugin-'));
        let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            await materializeAuxiliaryOnlyPlugin(pluginRoot);
            await seedCurrentLocalPathPluginFixture({
                happyHomeDir,
                pluginRoot,
                pluginId: PLUGIN_ID,
                manifestVersion: '1.0.0',
            });

            runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                pluginIds: [PLUGIN_ID],
            });
            expect(runtimeRegistry.contributes.agentDefinitionsById.get(AGENT_ID)).toMatchObject({
                id: AGENT_ID,
                pluginId: PLUGIN_ID,
                provenance: 'external',
            });
            expect(
                runtimeRegistry.activatedPluginIds.has(PLUGIN_ID),
                JSON.stringify({
                    targetActivationFacts: runtimeRegistry.targetActivationFacts,
                    diagnostics: runtimeRegistry.pluginDiagnosticsByPluginId[PLUGIN_ID],
                }, null, 2),
            ).toBe(true);
            expect(runtimeRegistry.targetActivationFacts).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    pluginId: PLUGIN_ID,
                    status: 'active',
                    required: expect.arrayContaining([
                        expect.objectContaining({
                            family: 'agents',
                            localId: AGENT_ID,
                        }),
                    ]),
                    bound: expect.arrayContaining([
                        expect.objectContaining({ family: 'agents', localId: AGENT_ID }),
                    ]),
                    diagnostics: [],
                }),
            ]));
            const resolution = await resolveBackendEngineAdapterResolution(AGENT_ID, { runtimeRegistry });
            const auxiliaryLease = runtimeRegistry.agentRuntimesByAgentId.get(AGENT_ID);
            expect(auxiliaryLease).toBeDefined();
            expect(auxiliaryLease).toMatchObject({
                pluginId: PLUGIN_ID,
                agentId: AGENT_ID,
                hasPrimaryRuntime: false,
                externalSessions: expect.any(Object),
            });
            expect(auxiliaryLease).not.toHaveProperty('createRuntime');
            expect(resolution).toMatchObject({
                agentId: AGENT_ID,
                provenance: 'external',
                runtimeOwner: {
                    selected: null,
                    candidates: [],
                },
                agent: { id: AGENT_ID, pluginId: PLUGIN_ID },
                executionSurfaces: {
                    externalSession: {
                        validateSource: expect.any(Function),
                        listCandidates: expect.any(Function),
                        resolveLinkIdentity: expect.any(Function),
                        canonicalizeLinkedSession: expect.any(Function),
                        pageTranscript: expect.any(Function),
                        readAfterTranscript: expect.any(Function),
                    },
                },
            });
            const externalSession = resolution?.executionSurfaces.externalSession;
            expect(externalSession).not.toBeNull();
            expect(Object.keys(externalSession ?? {}).sort()).toEqual([
                'canonicalizeLinkedSession',
                'externalLinkedTakeoverWriterSafety',
                'listCandidates',
                'pageTranscript',
                'readAfterTranscript',
                'resolveLinkIdentity',
                'validateSource',
            ]);

            const runtimeSource = { kind: 'synthetic' } as never;
            await expect(externalSession!.validateSource!({
                source: runtimeSource,
            })).resolves.toEqual({
                ok: true,
                source: runtimeSource,
            });
            await expect(externalSession!.listCandidates!({
                source: runtimeSource,
                limit: 1,
            })).resolves.toMatchObject({
                candidates: [{
                    remoteSessionId: 'remote-1',
                    linkData: { sourceGeneration: 'source-generation-1' },
                }],
                nextCursor: null,
            });
            await expect(externalSession!.resolveLinkIdentity!({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
            })).resolves.toMatchObject({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
                externalSessionMetadata: {
                    linkData: { sourceGeneration: 'source-generation-1' },
                },
            });
            await expect(externalSession!.canonicalizeLinkedSession!({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
                metadata: {
                    linkData: { sourceGeneration: 'source-generation-1' },
                },
            })).resolves.toMatchObject({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
            });
            await expect(externalSession!.canonicalizeLinkedSession!({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
                metadata: {},
            })).resolves.toMatchObject({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
            });
            const firstPage = await externalSession!.pageTranscript!({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
                direction: 'older',
                maxBytes: 16 * 1024,
                maxItems: 1,
            });
            expect(firstPage).toMatchObject({
                items: [{ id: 'message-1' }],
                nextCursor: null,
            });
            expect(firstPage.tailCursor).toMatch(/^happier_external_cursor_v1:/);
            await expect(externalSession!.readAfterTranscript!({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
                cursor: firstPage.tailCursor!,
                maxBytes: 16 * 1024,
                maxItems: 1,
            })).resolves.toMatchObject({
                outcome: 'advanced',
                items: [{ id: 'message-2' }],
                nextCursor: expect.stringMatching(/^happier_external_cursor_v1:/),
            });

            const maximumCandidates = await externalSession!.listCandidates!({
                source: runtimeSource,
                limit: 9_999,
                searchTerm: 'max-items',
            });
            expect(maximumCandidates.candidates).toHaveLength(
                EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems,
            );
            await expect(externalSession!.listCandidates!({
                source: runtimeSource,
                limit: 9_999,
                searchTerm: 'max-items-plus-one',
            })).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'agent_error',
                operation: 'listCandidates',
            });
            await expect(externalSession!.listCandidates!({
                source: runtimeSource,
                limit: EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems,
                maxBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxSerializedBytes,
                searchTerm: 'max-serialized-bytes',
            })).resolves.toMatchObject({
                candidates: expect.any(Array),
            });
            await expect(externalSession!.listCandidates!({
                source: runtimeSource,
                limit: EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems,
                maxBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxSerializedBytes,
                searchTerm: 'max-serialized-bytes-plus-one',
            })).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'agent_error',
                operation: 'listCandidates',
            });

            const maximumTranscriptPage = await externalSession!.pageTranscript!({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
                direction: 'older',
                cursor: 'max-items',
                maxBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxSerializedBytes,
                maxItems: 9_999,
            });
            expect(maximumTranscriptPage.items).toHaveLength(
                EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxItems,
            );
            await expect(externalSession!.pageTranscript!({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
                direction: 'older',
                cursor: 'max-items-plus-one',
                maxBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxSerializedBytes,
                maxItems: 9_999,
            })).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'agent_error',
                operation: 'pageTranscript',
            });
            const maximumReadAfter = await externalSession!.readAfterTranscript!({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
                cursor: 'max-items',
                maxBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxSerializedBytes,
                maxItems: 9_999,
            });
            expect(maximumReadAfter.outcome).toBe('advanced');
            if (maximumReadAfter.outcome !== 'advanced') {
                throw new Error('Expected a bounded advanced readAfter result');
            }
            expect(maximumReadAfter.items).toHaveLength(
                EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxItems,
            );
            await expect(externalSession!.readAfterTranscript!({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
                cursor: 'max-items-plus-one',
                maxBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxSerializedBytes,
                maxItems: 9_999,
            })).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'agent_error',
                operation: 'readAfterTranscript',
            });

            const maximumLinkIdentity = await externalSession!.resolveLinkIdentity!({
                source: runtimeSource,
                remoteSessionId: 'max-link-data',
            });
            expect(new TextEncoder().encode(JSON.stringify(
                maximumLinkIdentity.externalSessionMetadata?.linkData,
            ))).toHaveLength(MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES);
            await expect(externalSession!.resolveLinkIdentity!({
                source: runtimeSource,
                remoteSessionId: 'max-link-data-plus-one',
            })).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'agent_error',
                operation: 'resolveLinkIdentity',
            });
            await expect(externalSession!.listCandidates!({
                source: { kind: 'synthetic', invalid: undefined } as never,
                limit: 1,
            })).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'invalid_request',
                operation: 'listCandidates',
            });
            await expect(externalSession!.canonicalizeLinkedSession!({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
                metadata: {
                    externalSessionV1: {
                        linkData: { invalid: undefined },
                    },
                },
            })).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'invalid_request',
                operation: 'resolveLinkedIdentity',
            });
            const maximumCursor = await externalSession!.listCandidates!({
                source: runtimeSource,
                limit: 1,
                searchTerm: 'max-cursor',
            });
            expect(maximumCursor.nextCursor).toMatch(/^happier_external_cursor_v1:/);
            await expect(externalSession!.listCandidates!({
                source: runtimeSource,
                limit: 1,
                cursor: maximumCursor.nextCursor!,
            })).resolves.toMatchObject({
                candidates: expect.any(Array),
            });
            await expect(externalSession!.listCandidates!({
                source: runtimeSource,
                limit: 1,
                searchTerm: 'max-cursor-plus-one',
            })).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'agent_error',
                operation: 'listCandidates',
            });
            await expect(externalSession!.listCandidates!({
                source: runtimeSource,
                limit: 1,
                cursor: 'c'.repeat(
                    EXTERNAL_SESSIONS_INVOCATION_POLICY.nativeCursorMaxCodeUnits + 1,
                ),
            })).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'invalid_request',
                operation: 'listCandidates',
            });
            await expect(externalSession!.pageTranscript!({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
                direction: 'older',
                cursor: maximumCursor.nextCursor!,
                maxBytes: 16 * 1024,
                maxItems: 1,
            })).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'invalid_request',
                operation: 'pageTranscript',
            });

            await expect(externalSession!.validateSource!({
                source: { kind: 'synthetic', mode: 'malformed-outcome' } as never,
            })).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'agent_error',
                operation: 'resolveSource',
            });
            for (const searchTerm of ['malformed-outcome', 'malformed-failure']) {
                await expect(externalSession!.listCandidates!({
                    source: runtimeSource,
                    limit: 1,
                    searchTerm,
                })).rejects.toMatchObject({
                    name: 'ExternalSessionProviderFailureError',
                    code: 'agent_error',
                    operation: 'listCandidates',
                });
            }

            vi.useFakeTimers();
            try {
                const timedOutCall = externalSession!.listCandidates!({
                    source: runtimeSource,
                    limit: 1,
                    searchTerm: 'after-deadline',
                });
                const timedOutExpectation = expect(timedOutCall).rejects.toMatchObject({
                    name: 'ExternalSessionProviderFailureError',
                    code: 'timeout',
                    operation: 'listCandidates',
                });
                await vi.advanceTimersByTimeAsync(
                    EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs,
                );
                await timedOutExpectation;
                await vi.advanceTimersByTimeAsync(100);
                await expect(externalSession!.listCandidates!({
                    source: runtimeSource,
                    limit: 1,
                })).resolves.toMatchObject({
                    candidates: expect.any(Array),
                });
            } finally {
                vi.useRealTimers();
            }

            const caller = new AbortController();
            const cancelledCall = externalSession!.listCandidates!({
                source: runtimeSource,
                limit: 1,
                searchTerm: 'delayed',
                signal: caller.signal,
            });
            await Promise.resolve();
            caller.abort();
            await expect(cancelledCall).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'cancelled',
                operation: 'listCandidates',
            });

            const pageCaller = new AbortController();
            const cancelledPageCall = externalSession!.pageTranscript!({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
                direction: 'older',
                cursor: 'delayed',
                maxBytes: 16 * 1024,
                maxItems: 1,
                signal: pageCaller.signal,
            });
            await Promise.resolve();
            pageCaller.abort();
            await expect(cancelledPageCall).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'cancelled',
                operation: 'pageTranscript',
            });

            const readAfterCaller = new AbortController();
            const cancelledReadAfterCall = externalSession!.readAfterTranscript!({
                source: runtimeSource,
                remoteSessionId: 'remote-1',
                cursor: 'delayed',
                maxBytes: 16 * 1024,
                maxItems: 1,
                signal: readAfterCaller.signal,
            });
            await Promise.resolve();
            readAfterCaller.abort();
            await expect(cancelledReadAfterCall).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'cancelled',
                operation: 'readAfterTranscript',
            });
            await new Promise((resolve) => setTimeout(resolve, 120));
            await expect(externalSession!.listCandidates!({
                source: runtimeSource,
                limit: 3,
                searchTerm: 'observed-aborts',
            })).resolves.toMatchObject({
                candidates: [
                    { remoteSessionId: 'aborted-listCandidates' },
                    { remoteSessionId: 'aborted-pageTranscript' },
                    { remoteSessionId: 'aborted-readAfterTranscript' },
                ],
            });

            const linkIdentityCaller = new AbortController();
            const cancelledLinkIdentityCall = externalSession!.resolveLinkIdentity!({
                source: runtimeSource,
                remoteSessionId: 'delayed',
                signal: linkIdentityCaller.signal,
            });
            await Promise.resolve();
            linkIdentityCaller.abort();
            await expect(cancelledLinkIdentityCall).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'cancelled',
                operation: 'resolveLinkIdentity',
            });

            const linkedIdentityCaller = new AbortController();
            const cancelledLinkedIdentityCall = externalSession!.canonicalizeLinkedSession!({
                source: runtimeSource,
                remoteSessionId: 'delayed',
                metadata: {},
                signal: linkedIdentityCaller.signal,
            });
            await Promise.resolve();
            linkedIdentityCaller.abort();
            await expect(cancelledLinkedIdentityCall).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'cancelled',
                operation: 'resolveLinkedIdentity',
            });
            await new Promise((resolve) => setTimeout(resolve, 120));

            const retiredSurface = externalSession!;
            const retiringCalls = {
                resolveSource: retiredSurface.validateSource!({
                    source: { kind: 'synthetic', mode: 'delayed' } as never,
                }),
                listCandidates: retiredSurface.listCandidates!({
                    source: runtimeSource,
                    limit: 1,
                    searchTerm: 'delayed',
                }),
                resolveLinkIdentity: retiredSurface.resolveLinkIdentity!({
                    source: runtimeSource,
                    remoteSessionId: 'delayed',
                }),
                resolveLinkedIdentity: retiredSurface.canonicalizeLinkedSession!({
                    source: runtimeSource,
                    remoteSessionId: 'delayed',
                    metadata: {
                        linkData: { sourceGeneration: 'source-generation-1' },
                    },
                }),
                pageTranscript: retiredSurface.pageTranscript!({
                    source: runtimeSource,
                    remoteSessionId: 'remote-1',
                    direction: 'older',
                    cursor: 'delayed',
                    maxBytes: 16 * 1024,
                    maxItems: 1,
                }),
                readAfterTranscript: retiredSurface.readAfterTranscript!({
                    source: runtimeSource,
                    remoteSessionId: 'remote-1',
                    cursor: 'delayed',
                    maxBytes: 16 * 1024,
                    maxItems: 1,
                }),
            };
            const retiringExpectations = Object.entries(retiringCalls).map(([operation, call]) => (
                expect(call).rejects.toMatchObject({
                    name: 'ExternalSessionProviderFailureError',
                    code: 'unavailable',
                    operation,
                    retryable: true,
                })
            ));
            await Promise.resolve();
            const retiringRegistry = runtimeRegistry;
            runtimeRegistry = null;
            await retiringRegistry.dispose();
            await Promise.all(retiringExpectations);
            await new Promise((resolve) => setTimeout(resolve, 120));
            await expect(retiredSurface.listCandidates!({
                source: runtimeSource,
                limit: 1,
            })).rejects.toMatchObject({
                name: 'ExternalSessionProviderFailureError',
                code: 'unavailable',
                operation: 'listCandidates',
            });
        } finally {
            await runtimeRegistry?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });

    it('keeps one external Agent handoff callback bound to its current generation context', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-external-handoff-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-external-handoff-plugin-'));
        let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            await materializeExternalHandoffPlugin(pluginRoot);
            await seedCurrentLocalPathPluginFixture({
                happyHomeDir,
                pluginRoot,
                pluginId: HANDOFF_PLUGIN_ID,
                manifestVersion: '1.0.0',
            });

            runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                pluginIds: [HANDOFF_PLUGIN_ID],
            });
            const lease = runtimeRegistry.agentRuntimesByAgentId.get(HANDOFF_AGENT_ID);
            expect(lease).toMatchObject({
                pluginId: HANDOFF_PLUGIN_ID,
                agentId: HANDOFF_AGENT_ID,
                hasPrimaryRuntime: true,
            });
            expect(lease?.isCurrent()).toBe(true);

            const resolution = await resolveBackendEngineAdapterResolution(HANDOFF_AGENT_ID, {
                runtimeRegistry,
            });
            const handoff = resolution?.executionSurfaces.handoff;
            expect(handoff).not.toBeNull();
            await expect(handoff!.exportBundle({
                sessionId: 'vendor-session-1',
                metadata: {},
                directory: '/repo',
            })).resolves.toEqual({
                ok: true,
                value: {
                    bundle: {
                        vendorSessionId: 'vendor-session-1',
                        contextSessionId: null,
                        hasOperationServices: true,
                        hasOperationAbortSignal: true,
                        factoryReceivedServices: false,
                    },
                },
            });

            runtimeRegistry.retirePluginConsumers?.([HANDOFF_PLUGIN_ID]);
            expect(lease?.isCurrent()).toBe(false);
            await expect(handoff!.exportBundle({
                sessionId: 'vendor-session-2',
                metadata: {},
                directory: '/repo',
            })).rejects.toThrow(/retired runtime generation/i);
        } finally {
            await runtimeRegistry?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });
});
