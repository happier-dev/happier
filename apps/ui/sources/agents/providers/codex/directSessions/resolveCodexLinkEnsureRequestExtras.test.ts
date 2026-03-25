import { readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';
import { describe, expect, it } from 'vitest';

import { resolveCodexLinkEnsureRequestExtras } from './resolveCodexLinkEnsureRequestExtras';

describe('resolveCodexLinkEnsureRequestExtras', () => {
    it('prefers the canonical runtime descriptor when present', () => {
        const extras = resolveCodexLinkEnsureRequestExtras({
            source: { kind: 'codexHome', home: 'user' },
            candidate: {
                details: {
                    codexBackendMode: 'mcp',
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        providerId: 'codex',
                        provider: {
                            backendMode: 'appServer',
                            vendorSessionId: 'thread_app_server',
                        },
                    },
                },
            },
        });

        expect(
            extras,
        ).toMatchObject({
            codexBackendMode: 'appServer',
            runtimeDescriptor: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    home: 'user',
                    providerExtra: {
                        owner: 'codex',
                        schemaId: 'codex.agentRuntimeDescriptorExtra',
                        v: 1,
                        runtimeAffinity: {
                            backendMode: 'appServer',
                            home: 'user',
                        },
                    },
                },
            },
        });
        expect(readSessionMetadataRuntimeDescriptor({
            agentRuntimeDescriptorV1: extras.runtimeDescriptor,
        }, 'codex')).toMatchObject({
            vendorSessionId: 'thread_app_server',
            backendMode: 'appServer',
            home: 'user',
        });
    });

    it('falls back to the legacy browse runtimeDescriptor when canonical details are absent', () => {
        const extras = resolveCodexLinkEnsureRequestExtras({
            source: { kind: 'codexHome', home: 'user' },
            candidate: {
                details: {
                    runtimeDescriptor: {
                        v: 1,
                        providerId: 'codex',
                        provider: {
                            backendMode: 'appServer',
                            vendorSessionId: 'thread_legacy_app_server',
                        },
                    },
                },
            },
        });

        expect(extras).toMatchObject({
            codexBackendMode: 'appServer',
            runtimeDescriptor: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    home: 'user',
                    providerExtra: {
                        owner: 'codex',
                        schemaId: 'codex.agentRuntimeDescriptorExtra',
                        v: 1,
                        runtimeAffinity: {
                            backendMode: 'appServer',
                            home: 'user',
                        },
                    },
                },
            },
        });
        expect(readSessionMetadataRuntimeDescriptor({
            agentRuntimeDescriptorV1: extras.runtimeDescriptor,
        }, 'codex')).toMatchObject({
            vendorSessionId: 'thread_legacy_app_server',
            backendMode: 'appServer',
            home: 'user',
        });
    });

    it('falls back to legacy codexBackendMode only when explicit', () => {
        expect(
            resolveCodexLinkEnsureRequestExtras({
                source: { kind: 'codexHome', home: 'user' },
                candidate: { details: { codexBackendMode: 'appServer' } },
            }),
        ).toEqual({ codexBackendMode: 'appServer' });

        expect(
            resolveCodexLinkEnsureRequestExtras({
                source: { kind: 'codexHome', home: 'user' },
                candidate: { details: { codexBackendMode: '  mcp_resume  ' } },
            }),
        ).toEqual({ codexBackendMode: 'acp' });

        expect(
            resolveCodexLinkEnsureRequestExtras({
                source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex' },
                candidate: { details: { cwd: '/repo/fallback-home' } },
            }),
        ).toEqual({});
    });
});
