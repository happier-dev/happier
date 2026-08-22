import { describe, expect, it, vi } from 'vitest';

import type {
    ConnectedServiceBindingsV1,
    QualifiedConnectedAccountPurposeBindingV1,
} from '@happier-dev/protocol';
import {
    createProviderLaunchResourceScope,
} from '@/providers/lifecycle/resourceScope';

import {
    activateConnectedAccountRequestAuthForSpawn,
    resolveQualifiedPurposeBindingSnapshotForAgentSpawn,
    resolveQualifiedPurposeBindingsForAgentSpawn,
    resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn,
} from './prepareConnectedAccountRequestAuthForSpawn';
import type {
    ConnectedAccountRequestAuthSubject,
} from './ConnectedAccountRequestAuthService';

const contributionRegistryMock = vi.hoisted(() => ({
    getResolvedContributionRegistry: vi.fn(),
}));

vi.mock(
    '@/plugins/projection/registry/createResolvedContributionRegistry',
    () => ({
        getResolvedContributionRegistry:
            contributionRegistryMock.getResolvedContributionRegistry,
    }),
);

const bindings: ConnectedServiceBindingsV1 = {
    v: 1,
    bindingsByServiceId: {
        'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'codex-work',
        },
        'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude-team',
            profileId: 'materialized-member-must-not-be-authority',
        },
    },
};

describe('ordinary Agent request-auth spawn preparation', () => {
    it('projects a complete launch snapshot so explicit native purposes remain unbound', () => {
        expect(resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
            agentId: 'codex',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'codex-work',
                    },
                    openai: { source: 'native' },
                },
            },
            contributions: {
                agentDefinitionsById: new Map([['codex', {
                    identity: {
                        pluginId: 'happier.agent.codex',
                        localId: 'codex',
                    },
                    richDefinition: {
                        definition: {
                            connectedAccounts: [{
                                purpose: 'primary',
                                service: 'openai-codex',
                                materializationKinds: ['httpHeaders'],
                            }, {
                                purpose: 'realtime_upstream',
                                service: {
                                    pluginId: 'happier.voice.openai',
                                    localId: 'openai',
                                },
                            }],
                        },
                    },
                    catalogEntry: {
                        connectedAccountRequestAuthUses: [{
                            purpose: 'primary',
                            materialization: {
                                kind: 'httpHeaders',
                                origin: 'https://api.openai.com',
                                headerNames: [
                                    'authorization',
                                    'chatgpt-account-id',
                                ],
                            },
                        }],
                    },
                }]]),
            },
        })).toEqual({
            purposes: [{
                consumer: {
                    pluginId: 'happier.agent.codex',
                    localId: 'codex',
                },
                purpose: 'primary',
            }, {
                consumer: {
                    pluginId: 'happier.agent.codex',
                    localId: 'codex',
                },
                purpose: 'realtime_upstream',
            }],
            bindings: [{
                purpose: {
                    consumer: {
                        pluginId: 'happier.agent.codex',
                        localId: 'codex',
                    },
                    purpose: 'primary',
                },
                target: {
                    kind: 'account',
                    account: {
                        service: {
                            pluginId: 'happier.agent.codex',
                            localId: 'openai-codex',
                        },
                        accountId: 'codex-work',
                    },
                },
            }],
            requestAuthUses: [{
                purpose: {
                    consumer: {
                        pluginId: 'happier.agent.codex',
                        localId: 'codex',
                    },
                    purpose: 'primary',
                },
                materialization: {
                    kind: 'httpHeaders',
                    origin: 'https://api.openai.com',
                    headerNames: [
                        'authorization',
                        'chatgpt-account-id',
                    ],
                },
            }],
        });
    });

    it('rejects request-auth uses that are malformed or do not match a declared purpose', () => {
        const base = {
            agentId: 'codex' as const,
            bindings,
            contributions: {
                agentDefinitionsById: new Map([['codex', {
                    identity: {
                        pluginId: 'happier.agent.codex',
                        localId: 'codex',
                    },
                    richDefinition: {
                        definition: {
                            connectedAccounts: [{
                                purpose: 'primary',
                                service: 'openai-codex',
                                materializationKinds: ['httpHeaders'],
                            }],
                        },
                    },
                    catalogEntry: {
                        connectedAccountRequestAuthUses: [{
                            purpose: 'undeclared',
                            materialization: {
                                kind: 'httpHeaders',
                                origin: 'https://api.openai.com',
                                headerNames: ['authorization'],
                            },
                        }],
                    },
                }]]),
            },
        };
        expect(resolveQualifiedPurposeBindingSnapshotForAgentSpawn(base)).toBeNull();
        expect(resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
            ...base,
            contributions: {
                agentDefinitionsById: new Map([['codex', {
                    ...base.contributions.agentDefinitionsById.get('codex'),
                    catalogEntry: {
                        connectedAccountRequestAuthUses: [{
                            purpose: 'primary',
                            materialization: {
                                kind: 'httpHeaders',
                                origin: 'https://api.openai.com/v1',
                                headerNames: ['Authorization'],
                            },
                        }],
                    },
                }]]),
            },
        })).toBeNull();
    });

    it('rejects request-auth materialization that its declared purpose does not authorize', () => {
        const input = (materializationKinds?: readonly ('httpHeaders' | 'files')[]) => ({
            agentId: 'codex' as const,
            bindings,
            contributions: {
                agentDefinitionsById: new Map([['codex', {
                    identity: {
                        pluginId: 'happier.agent.codex',
                        localId: 'codex',
                    },
                    richDefinition: {
                        definition: {
                            connectedAccounts: [{
                                purpose: 'primary',
                                service: 'openai-codex',
                                ...(materializationKinds
                                    ? { materializationKinds }
                                    : {}),
                            }],
                        },
                    },
                    catalogEntry: {
                        connectedAccountRequestAuthUses: [{
                            purpose: 'primary',
                            materialization: {
                                kind: 'httpHeaders',
                                origin: 'https://api.openai.com',
                                headerNames: ['authorization'],
                            },
                        }],
                    },
                }]]),
            },
        });

        expect(resolveQualifiedPurposeBindingSnapshotForAgentSpawn(input()))
            .toBeNull();
        expect(resolveQualifiedPurposeBindingSnapshotForAgentSpawn(input(['files'])))
            .toBeNull();
        expect(resolveQualifiedPurposeBindingSnapshotForAgentSpawn(input(['httpHeaders'])))
            .not.toBeNull();
    });

    it('intersects request-auth authority without dropping native-only session bindings', () => {
        const snapshotInput = {
            agentId: 'codex' as const,
            bindings: {
                v: 1 as const,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected' as const,
                        selection: 'profile' as const,
                        profileId: 'codex-work',
                    },
                    openai: {
                        source: 'connected' as const,
                        selection: 'profile' as const,
                        profileId: 'openai-work',
                    },
                },
            },
            contributions: {
                agentDefinitionsById: new Map([['codex', {
                    identity: {
                        pluginId: 'happier.agent.codex',
                        localId: 'codex',
                    },
                    richDefinition: {
                        definition: {
                            connectedAccounts: [{
                                purpose: 'native-primary',
                                service: 'openai-codex',
                            }, {
                                purpose: 'request-time',
                                service: {
                                    pluginId: 'happier.voice.openai',
                                    localId: 'openai',
                                },
                                materializationKinds: ['httpHeaders'],
                            }],
                        },
                    },
                    catalogEntry: {
                        connectedAccountRequestAuthUses: [{
                            purpose: 'request-time',
                            materialization: {
                                kind: 'httpHeaders',
                                origin: 'https://api.openai.com',
                                headerNames: ['authorization'],
                            },
                        }],
                    },
                }]]),
            },
        };

        expect(resolveQualifiedPurposeBindingsForAgentSpawn(snapshotInput))
            .toHaveLength(2);
        expect(resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn(
            snapshotInput,
        )).toEqual([expect.objectContaining({
            purpose: expect.objectContaining({
                purpose: 'request-time',
            }),
        })]);

        const nativeOnlyInput = {
            ...snapshotInput,
            contributions: {
                agentDefinitionsById: new Map([['codex', {
                    ...snapshotInput.contributions.agentDefinitionsById.get(
                        'codex',
                    ),
                    catalogEntry: {},
                }]]),
            },
        };
        expect(resolveQualifiedPurposeBindingsForAgentSpawn(nativeOnlyInput))
            .toHaveLength(2);
        expect(resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn(
            nativeOnlyInput,
        )).toEqual([]);
    });

    it('uses the applied spawn-lease contribution and never materializes a stale manifest-generation purpose', () => {
        contributionRegistryMock.getResolvedContributionRegistry.mockReturnValue({
            agentDefinitionsById: new Map([['pi', {
                identity: { pluginId: 'happier.agent.pi', localId: 'pi' },
                richDefinition: {
                    definition: {
                        connectedAccounts: [{
                            purpose: 'generation-a-purpose',
                            service: {
                                pluginId: 'happier.agent.codex',
                                localId: 'openai-codex',
                            },
                        }],
                    },
                },
            }]]),
        });

        expect(resolveQualifiedPurposeBindingsForAgentSpawn({
            agentId: 'pi',
            bindings,
            contributions: {
                agentDefinitionsById: new Map([['pi', {
                    identity: {
                        pluginId: 'happier.agent.pi',
                        localId: 'pi',
                    },
                    richDefinition: {
                        definition: {
                            connectedAccounts: [{
                                purpose: 'generation-b-purpose',
                                service: {
                                    pluginId: 'happier.agent.codex',
                                    localId: 'openai-codex',
                                },
                            }],
                        },
                    },
                }]]),
            },
        })).toEqual([{
            purpose: {
                consumer: {
                    pluginId: 'happier.agent.pi',
                    localId: 'pi',
                },
                purpose: 'generation-b-purpose',
            },
            target: {
                kind: 'account',
                account: {
                    service: {
                        pluginId: 'happier.agent.codex',
                        localId: 'openai-codex',
                    },
                    accountId: 'codex-work',
                },
            },
        }]);
    });

    it('reads the exact manifest Agent identity/declarations and invokes the sole legacy translator', () => {
        expect(resolveQualifiedPurposeBindingsForAgentSpawn({
            agentId: 'pi',
            bindings,
            contributions: {
                agentDefinitionsById: new Map([['pi', {
                    identity: { pluginId: 'happier.agent.pi', localId: 'pi' },
                    richDefinition: {
                        definition: {
                            connectedAccounts: [{
                                purpose: 'anthropic-model-request',
                                service: {
                                    pluginId: 'happier.agent.claude',
                                    localId: 'claude-subscription',
                                },
                            }, {
                                purpose: 'openai-codex-model-request',
                                service: {
                                    pluginId: 'happier.agent.codex',
                                    localId: 'openai-codex',
                                },
                            }],
                        },
                    },
                }]]),
            },
        })).toEqual([{
            purpose: {
                consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
                purpose: 'anthropic-model-request',
            },
            target: {
                kind: 'group',
                service: {
                    pluginId: 'happier.agent.claude',
                    localId: 'claude-subscription',
                },
                groupId: 'claude-team',
            },
        }, {
            purpose: {
                consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
                purpose: 'openai-codex-model-request',
            },
            target: {
                kind: 'account',
                account: {
                    service: {
                        pluginId: 'happier.agent.codex',
                        localId: 'openai-codex',
                    },
                    accountId: 'codex-work',
                },
            },
        }]);
    });

    it('projects the OpenCode manifest consumer purposes through the shared legacy ingress', () => {
        expect(resolveQualifiedPurposeBindingsForAgentSpawn({
            agentId: 'opencode',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    'claude-subscription': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'claude-team',
                        profileId: 'current-member-is-not-the-group-authority',
                    },
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'codex-work',
                    },
                },
            },
            contributions: {
                agentDefinitionsById: new Map([['opencode', {
                    identity: {
                        pluginId: 'happier.agent.opencode',
                        localId: 'opencode',
                    },
                    richDefinition: {
                        definition: {
                            connectedAccounts: [{
                                purpose: 'anthropic-model-request',
                                service: {
                                    pluginId: 'happier.agent.claude',
                                    localId: 'claude-subscription',
                                },
                            }, {
                                purpose: 'openai-codex-model-request',
                                service: {
                                    pluginId: 'happier.agent.codex',
                                    localId: 'openai-codex',
                                },
                            }],
                        },
                    },
                }]]),
            },
        })).toEqual([{
            purpose: {
                consumer: {
                    pluginId: 'happier.agent.opencode',
                    localId: 'opencode',
                },
                purpose: 'anthropic-model-request',
            },
            target: {
                kind: 'group',
                service: {
                    pluginId: 'happier.agent.claude',
                    localId: 'claude-subscription',
                },
                groupId: 'claude-team',
            },
        }, {
            purpose: {
                consumer: {
                    pluginId: 'happier.agent.opencode',
                    localId: 'opencode',
                },
                purpose: 'openai-codex-model-request',
            },
            target: {
                kind: 'account',
                account: {
                    service: {
                        pluginId: 'happier.agent.codex',
                        localId: 'openai-codex',
                    },
                    accountId: 'codex-work',
                },
            },
        }]);
    });

    it('activates request-auth with the exact canonical session lease and owns only registry retirement', async () => {
        const captured: {
            subject: ConnectedAccountRequestAuthSubject | null;
        } = { subject: null };
        const descriptor = {
            path: '/materialized/.happier/request-auth-capability.json',
            materializationId: 'session-1',
            subjectScopeDigest: 'a'.repeat(64),
            capabilityDigest: 'b'.repeat(64),
        };
        let subject: ConnectedAccountRequestAuthSubject;
        const registry = {
            activate: vi.fn(async (input: {
                subject: NonNullable<typeof captured.subject>;
                materializedRootDir: string;
                materializationId: string;
            }) => {
                captured.subject = input.subject;
                expect(input.materializedRootDir).toBe('/materialized');
                expect(input.materializationId).toBe('session-1');
                expect(input.subject?.isCurrent()).toBe(true);
                expect(input.subject).toBe(subject);
                return descriptor;
            }),
            retire: vi.fn(async () => undefined),
        };
        const cleanupHolder: {
            cleanup: (() => void | Promise<void>) | null;
        } = { cleanup: null };
        const launchResourceScope = {
            register: vi.fn((resource: {
                onFailure: () => void | Promise<void>;
                onExit: () => void | Promise<void>;
            }) => {
                cleanupHolder.cleanup = resource.onExit;
            }),
        };
        const purposeBindings = resolveQualifiedPurposeBindingsForAgentSpawn({
            agentId: 'pi',
            bindings,
            contributions: {
                agentDefinitionsById: new Map([['pi', {
                    identity: { pluginId: 'happier.agent.pi', localId: 'pi' },
                    richDefinition: {
                        definition: {
                            connectedAccounts: [{
                                purpose: 'openai-codex-model-request',
                                service: {
                                    pluginId: 'happier.agent.codex',
                                    localId: 'openai-codex',
                                },
                            }],
                        },
                    },
                }]]),
            },
        });
        subject = {
            subjectId: 'agent-session:session-1',
            isCurrent: () => true,
            registerRedaction: () => undefined,
            resolvePurposeUse: () => purposeBindings[0]
                ? {
                    binding: purposeBindings[0],
                    use: {
                        purpose: purposeBindings[0].purpose,
                        materialization: {
                            kind: 'httpHeaders',
                            origin: 'https://api.openai.com',
                            headerNames: ['authorization'],
                        },
                    },
                }
                : null,
            listPurposeUses: () => purposeBindings.map((binding) => ({
                binding,
                use: {
                    purpose: binding.purpose,
                    materialization: {
                        kind: 'httpHeaders',
                        origin: 'https://api.openai.com',
                        headerNames: ['authorization'],
                    },
                },
            })),
        };

        await expect(activateConnectedAccountRequestAuthForSpawn({
            materializationId: 'session-1',
            materializedRootDir: '/materialized',
            subject,
            registry,
            httpPort: 43_123,
            launchResourceScope,
        })).resolves.toEqual(descriptor);
        expect(captured.subject?.listPurposeUses().map((entry) => entry.binding))
            .toEqual(purposeBindings);

        await cleanupHolder.cleanup?.();
        expect(registry.retire).toHaveBeenCalledWith(descriptor);
        expect(captured.subject).toBe(subject);
    });

    it('retires the exact late descriptor when shutdown retires the launch scope during activation', async () => {
        const descriptor = {
            path: '/materialized/.happier/request-auth-capability.json',
            materializationId: 'session-late',
            subjectScopeDigest: 'a'.repeat(64),
            capabilityDigest: 'b'.repeat(64),
        };
        let completeActivation!: (
            value: typeof descriptor,
        ) => void;
        const activationPaused = new Promise<typeof descriptor>(
            (resolve) => {
                completeActivation = resolve;
            },
        );
        const registry = {
            activate: vi.fn(async () => await activationPaused),
            retire: vi.fn(async () => undefined),
        };
        const launchResourceScope =
            createProviderLaunchResourceScope();
        const activation = activateConnectedAccountRequestAuthForSpawn({
            materializationId: 'session-late',
            materializedRootDir: '/materialized',
            subject: {
                subjectId: 'agent-session:session-late',
                isCurrent: () => true,
                registerRedaction: () => undefined,
                resolvePurposeUse: () => null,
                listPurposeUses: () => [],
            },
            registry,
            httpPort: 43_123,
            launchResourceScope,
        });

        await vi.waitFor(
            () => expect(registry.activate).toHaveBeenCalledOnce(),
        );
        await launchResourceScope.retire();
        completeActivation(descriptor);

        await expect(activation).rejects.toThrow(
            'Provider launch resource scope is no longer open',
        );
        expect(registry.retire).toHaveBeenCalledOnce();
        expect(registry.retire).toHaveBeenCalledWith(descriptor);
    });
});
