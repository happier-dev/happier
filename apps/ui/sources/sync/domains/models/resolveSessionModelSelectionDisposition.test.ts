import { describe, expect, it } from 'vitest';

import { MetadataSchema } from '@happier-dev/session-core/state';
import { applyModelIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { readSessionModelSelectionV2FromMetadata } from '@happier-dev/agents';
import { readSessionConnectedServiceBindings } from '@/sync/domains/connectedServices/readSessionConnectedServiceBindings';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { readSessionProviderBindingMetadataStateV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { createProviderBindingSecurityFingerprintV1 } from '@happier-dev/protocol/providers/securityFingerprintsV1';
import { presentSessionRouteChip, resolveSessionRoutePresentation } from '@/providers/session/resolveSessionRoutePresentation';
import { t } from '@/text';

import { resolveSessionModelSelectionDisposition } from './resolveSessionModelSelectionDisposition';
import { resolveSessionComposerSendDestination } from '@/sync/domains/session/input/resolveSessionComposerSendDestination';
import { createSessionActiveModelSelection } from '@happier-dev/protocol/providers/selection/v2';

function appliedConnectedClaudeMetadata() {
    return MetadataSchema.parse({
        path: '/tmp/project', host: 'localhost', permissionMode: 'plan',
        connectedServices: {
            v: 2,
            bindingsByServiceId: {
                'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'work' },
            },
        },
        modelSelectionIntentV1: {
            v: 1, updatedAt: 11,
            selection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-haiku-4-5' },
        },
        sessionModelsV1: {
            v: 1, agentId: 'claude', updatedAt: 12, currentModelId: 'claude-haiku-4-5',
            availableModels: [{ id: 'claude-haiku-4-5', name: 'Haiku 4.5' }],
            activeSelectionV1: {
                v: 1, source: 'runtime_apply',
                selection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-haiku-4-5' },
                runner: { pid: 42, processStartTimeMs: 10 },
            },
        },
    });
}

describe('resolveSessionModelSelectionDisposition', () => {
    it('settles the OpenCode launch selection when its private catalog is withheld', () => {
        const selection = {
            agentTargetKey: 'agent:happier.agent.opencode/opencode',
            providerConnectionId: null,
            modelId: 'openai/gpt-4.1-mini',
        };
        const runner = { pid: 2358024, processStartTimeMs: 945567640 };
        const metadata = MetadataSchema.parse({
            path: '/tmp/project', host: 'localhost',
            modelSelectionIntentV1: { v: 1, updatedAt: 11, selection },
            sessionModelsV1: {
                v: 1, agentId: 'opencode', updatedAt: 12,
                currentModelId: selection.modelId, availableModels: [],
                activeSelectionV1: { v: 1, source: 'runtime_apply', selection, runner },
            },
        });
        expect(resolveSessionModelSelectionDisposition({
            metadata, agentId: 'opencode', agentTargetKey: selection.agentTargetKey,
            sessionActive: true, currentRunnerProcessIdentity: runner,
        })).toMatchObject({
            activeSelection: selection, contextSelection: selection,
            selectionTransitionPending: false, reportedSelectionStatus: 'running',
        });
    });
    it('projects the applied Team source for the picker and chip when launch retained only V1 intent', () => {
        const selection = ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5.6-luna' });
        const active = createSessionActiveModelSelection({ selection, source: 'runtime_apply',
            runner: { pid: 42, processStartTimeMs: 10 }, teamCredentialModel: {
                kind: 'team_credential_provider_model', teamId: 'team', resourceId: 'resource',
                expectedResourceRevision: 0, deliveryMode: 'brokered', agentTargetKey: selection.agentTargetKey, modelId: selection.modelId,
            } });
        if (active?.v !== 2) throw new Error('Expected canonical Team runtime fact');
        const metadata = MetadataSchema.parse({ path: '/workspace', host: 'test',
            modelSelectionIntentV1: { v: 1, updatedAt: 11, selection },
            sessionModelsV1: { v: 1, agentId: 'codex', updatedAt: 0, currentModelId: selection.modelId,
                availableModels: [{ id: selection.modelId, name: 'Luna' }], activeSelectionV1: active } });
        for (const sessionActive of [true, false]) {
            for (const currentRunnerProcessIdentity of [active.runner, null]) {
                const disposition = resolveSessionModelSelectionDisposition({ metadata, agentId: 'codex',
                    agentTargetKey: selection.agentTargetKey, sessionActive, currentRunnerProcessIdentity });
                expect(disposition.selectedTeamCredentialModel).toEqual(active.teamCredentialModel);
                expect(disposition.reportedTeamCredentialModel).toEqual(active.teamCredentialModel);
                const native = { label: 'Own sign-in', authSource: 'native' as const, connectedCount: 0 };
                const route = resolveSessionRoutePresentation({ phase: sessionActive ? 'running' : 'draft', native,
                    selection: disposition.contextRouteSelection, appliedSelection: disposition.activeRouteSelection,
                    reportedSelection: disposition.lastAppliedRouteSelection,
                    teamSources: [{ teamId: 'team', resourceId: 'resource', displayName: 'QA43 Leeroy brokered' }] });
                expect(presentSessionRouteChip(route, native)?.label).toBe(t('connectedServices.authChip.runsThrough', { source: 'QA43 Leeroy brokered' }));
                if (!currentRunnerProcessIdentity || !sessionActive) expect(disposition.activeRouteSelection).toBeNull();
            }
        }
        const changed = MetadataSchema.parse({ ...metadata, modelSelectionIntentV2: {
            v: 2, updatedAt: 30, ref: { source: 'native', agentTargetKey: selection.agentTargetKey, modelId: selection.modelId },
        } });
        expect(resolveSessionModelSelectionDisposition({ metadata: changed, agentId: 'codex', agentTargetKey: selection.agentTargetKey,
            sessionActive: true, currentRunnerProcessIdentity: active.runner }).selectedTeamCredentialModel).toBeNull();
        const differentModel = MetadataSchema.parse({ ...metadata, modelSelectionIntentV1: {
            v: 1, updatedAt: 30, selection: { ...selection, modelId: 'another-model' },
        } });
        expect(resolveSessionModelSelectionDisposition({ metadata: differentModel, agentId: 'codex', agentTargetKey: selection.agentTargetKey,
            sessionActive: true, currentRunnerProcessIdentity: active.runner })).toMatchObject({
                selectedTeamCredentialModel: null, reportedTeamCredentialModel: active.teamCredentialModel, selectionTransitionPending: true,
            });
    });
    it('presents the runtime-opened Team source while another source is armed, retaining only history after runner replacement', () => {
        const teamCredentialModel = { kind: 'team_credential_provider_model' as const, resourceId: 'opened', teamId: 'team',
            expectedResourceRevision: 0, deliveryMode: 'brokered' as const, agentTargetKey: 'backend:codex', modelId: 'shared' };
        const runner = { pid: 42, processStartTimeMs: 10 };
        const { kind: _kind, ...openedRef } = teamCredentialModel;
        const metadata = MetadataSchema.parse({ modelSelectionIntentV2: { v: 2, updatedAt: 20,
            ref: { source: 'team_resource', ...openedRef, resourceId: 'pending' } },
            sessionModelsV1: { v: 1, agentId: 'codex', updatedAt: 21, currentModelId: 'shared',
                availableModels: [{ id: 'shared', name: 'Shared' }], activeSelectionV1: {
                    v: 2, selection: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'shared' },
                    source: 'runtime_apply', runner, teamCredentialModel,
                } } });
        const read = (currentRunnerProcessIdentity: typeof runner | null) => resolveSessionModelSelectionDisposition({
            metadata, agentId: 'codex', agentTargetKey: 'backend:codex', sessionActive: true, currentRunnerProcessIdentity });
        const disposition = read(runner);
        const native = { label: 'Native', authSource: 'native' as const, connectedCount: 0 };
        const presentation = resolveSessionRoutePresentation({ phase: 'running', native,
            selection: disposition.proposedSelectionV2?.ref ?? null, appliedSelection: disposition.activeRouteSelection,
            transitionPending: disposition.selectionTransitionPending });
        expect(presentation.applied).toMatchObject({ kind: 'team', resourceId: 'opened' });
        expect(presentation.pending).toMatchObject({ kind: 'team', resourceId: 'pending' });
        expect(read(null)).toMatchObject({ activeRouteSelection: null,
            lastAppliedRouteSelection: { source: 'team_resource', resourceId: 'opened' } });
        const nativeIntent = MetadataSchema.parse({ ...metadata, modelSelectionIntentV2: { v: 2, updatedAt: 30,
            ref: { source: 'native', agentTargetKey: 'backend:codex', modelId: 'shared' } },
            modelSelectionIntentV1: { v: 1, updatedAt: 30,
                selection: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'shared' } } });
        expect(resolveSessionModelSelectionDisposition({ metadata: nativeIntent, agentId: 'codex', agentTargetKey: 'backend:codex',
            sessionActive: true, currentRunnerProcessIdentity: runner }).selectionTransitionPending).toBe(true);
        const { modelSelectionIntentV2: _pending, ...retained } = metadata;
        expect(resolveSessionModelSelectionDisposition({ metadata: retained, agentId: 'codex', agentTargetKey: 'backend:codex',
            sessionActive: false, currentRunnerProcessIdentity: null }).contextRouteSelection)
            .toMatchObject({ source: 'team_resource', resourceId: 'opened' });
    });

    it('keeps a connected launch on ordinary input delivery before the first runtime model publication', () => {
        const applied = appliedConnectedClaudeMetadata();
        const { sessionModelsV1: models, modelSelectionIntentV1: intent, ...birth } = applied;
        if (!intent || !models) throw new Error('Expected launch fixture');
        // createSessionMetadata uses this real writer before the native factory
        // opens and publishes sessionModelsV1. Socket presence arrives earlier.
        const metadata = MetadataSchema.parse(applyModelIntentSessionMetadata(birth, intent));
        expect(readSessionConnectedServiceBindings({ metadata, agentId: 'claude' }))
            .toEqual(applied.connectedServices);
        const disposition = resolveSessionModelSelectionDisposition({
            agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude',
            metadata, sessionActive: true, currentRunnerProcessIdentity: null,
        });
        expect(disposition).toMatchObject({ activeSelection: null, contextSelection: null, selectionTransitionPending: false });
        const native = { label: 'Claude · work', authSource: 'connected' as const, connectedCount: 1 };
        const presentation = resolveSessionRoutePresentation({ phase: 'running',
            selection: disposition.proposedSelection, appliedSelection: disposition.activeSelection,
            transitionPending: disposition.selectionTransitionPending, native });
        expect(presentation.pending).toBeNull();
        expect(resolveSessionComposerSendDestination({ route: 'sessionAgent',
            armedContinuation: null, armedContinuationLocalId: null,
            armedRoute: disposition.selectionTransitionPending ? { turnActive: false } : null,
            machineId: 'machine-1', pendingTransitionOutcome: 'settled',
        })).toEqual({ kind: 'sessionAgent' });
        // Publication settles the same launch; a later different choice still
        // needs transition admission rather than bypassing it as startup.
        const published = { ...metadata, sessionModelsV1: models };
        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude',
            metadata: published, sessionActive: true, currentRunnerProcessIdentity: models.activeSelectionV1?.runner ?? null,
        }).selectionTransitionPending).toBe(false);
        const changed = applyModelIntentSessionMetadata(published, {
            v: 1, updatedAt: 13, selection: { ...intent.selection!, modelId: 'claude-sonnet-4-6' },
        });
        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude',
            metadata: changed, sessionActive: true, currentRunnerProcessIdentity: models.activeSelectionV1?.runner ?? null,
        }).selectionTransitionPending).toBe(true);
    });

    it('keeps a connected Claude follow-up on its existing route after Plan → Build when runner observation is unavailable', () => {
        const metadata = appliedConnectedClaudeMetadata();
        for (const permissionMode of ['plan', 'default'] as const) {
            const disposition = resolveSessionModelSelectionDisposition({
                agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude',
                metadata: { ...metadata, permissionMode }, sessionActive: true,
                currentRunnerProcessIdentity: null,
            });
            // A previously applied choice is not a new route choice. Missing
            // observation must not fabricate current runtime/context authority.
            expect(disposition).toMatchObject({
                activeSelection: null, contextSelection: null,
                reportedSelectionStatus: 'last_reported', selectionTransitionPending: false,
                lastAppliedSelection: metadata.sessionModelsV1?.activeSelectionV1?.selection,
            });
            expect(resolveSessionComposerSendDestination({
                route: 'sessionAgent', armedContinuation: null, armedContinuationLocalId: null,
                armedRoute: disposition.selectionTransitionPending ? { turnActive: false } : null,
                machineId: 'machine-1', pendingTransitionOutcome: 'settled',
            })).toEqual({ kind: 'sessionAgent' });
        }
    });

    it('still arms a different model or Provider connection with unavailable or replacement runner observation', () => {
        const metadata = appliedConnectedClaudeMetadata();
        for (const selection of [
            { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-sonnet-4-6' },
            { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: 'pc-new', modelId: 'claude-haiku-4-5' },
        ]) {
            for (const currentRunnerProcessIdentity of [null, { pid: 42, processStartTimeMs: 20 }]) {
                const disposition = resolveSessionModelSelectionDisposition({
                    agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude',
                    metadata: { ...metadata, modelSelectionIntentV1: { v: 1, updatedAt: 13, selection: ProviderBoundModelRefSchema.parse(selection) } },
                    sessionActive: true, currentRunnerProcessIdentity,
                });
                expect(disposition.selectionTransitionPending).toBe(true);
                expect(resolveSessionComposerSendDestination({
                    route: 'sessionAgent', armedContinuation: null, armedContinuationLocalId: null,
                    armedRoute: disposition.selectionTransitionPending ? { turnActive: false } : null,
                    machineId: 'machine-1', pendingTransitionOutcome: 'settled',
                })).toEqual({ kind: 'armedRouteContinuation', machineId: 'machine-1' });
            }
        }
    });

    it('keeps unchanged selection on ordinary Send while a capability replacement has not yet published its model proof', () => {
        const metadata = appliedConnectedClaudeMetadata();
        const disposition = resolveSessionModelSelectionDisposition({
            agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude',
            metadata, sessionActive: true,
            currentRunnerProcessIdentity: { pid: 42, processStartTimeMs: 20 },
        });
        expect(disposition).toMatchObject({
            activeSelection: null,
            contextSelection: null,
            lastAppliedSelection: metadata.sessionModelsV1?.activeSelectionV1?.selection,
            selectionTransitionPending: false,
        });
        expect(resolveSessionComposerSendDestination({
            route: 'sessionAgent', armedContinuation: null, armedContinuationLocalId: null,
            armedRoute: disposition.selectionTransitionPending ? { turnActive: false } : null,
            machineId: 'machine-1', pendingTransitionOutcome: 'settled',
        })).toEqual({ kind: 'sessionAgent' });
    });

    it('does not treat an incoherent historical selection as an applied proposal', () => {
        const metadata = appliedConnectedClaudeMetadata();
        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude',
            metadata: { ...metadata, sessionModelsV1: { ...metadata.sessionModelsV1!, currentModelId: 'different-model' } },
            sessionActive: true, currentRunnerProcessIdentity: null,
        }).selectionTransitionPending).toBe(true);
    });

    it('projects exact V2 Team provenance while retaining the Team source', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project', host: 'localhost',
            modelSelectionIntentV2: {
                v: 2, updatedAt: 11,
                ref: {
                    source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1',
                    expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'team-model',
                },
            },
        });
        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude', metadata,
            sessionActive: false, currentRunnerProcessIdentity: null,
        }).proposedSelectionV2?.ref).toEqual({
            source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1',
            expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'team-model',
        });
    });

    it('keeps a durable V2 Team proposal pending for an active Session after UI remount', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project', host: 'localhost',
            modelSelectionIntentV2: {
                v: 2, updatedAt: 11,
                ref: {
                    source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1',
                    expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'team-model',
                },
            },
        });

        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude', metadata,
            sessionActive: true, currentRunnerProcessIdentity: null,
        })).toMatchObject({
            proposedSelectionV2: {
                ref: { source: 'team_resource', modelId: 'team-model' },
            },
            activeSelection: null,
            selectionTransitionPending: true,
        });
    });

    it.each([7, 9])('settles a durable Team proposal when the runner publishes its accepted source at revision %s', expectedResourceRevision => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project', host: 'localhost',
            modelSelectionIntentV2: {
                v: 2, updatedAt: 11,
                ref: {
                    source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1',
                    expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'team-model',
                },
            },
        });

        const params = {
            agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude', metadata,
            sessionActive: true,
            currentRunnerProcessIdentity: { pid: 42, processStartTimeMs: 12 },
        };
        expect(resolveSessionModelSelectionDisposition(params).selectionTransitionPending).toBe(true);
        const selection = readSessionModelSelectionV2FromMetadata(metadata)?.ref;
        if (selection?.source !== 'team_resource') throw new Error('Expected Team intent fixture');
        const { source: _source, ...team } = selection;
        const applied = MetadataSchema.parse({ ...metadata, sessionModelsV1: {
            v: 1, agentId: 'claude', updatedAt: 13, currentModelId: selection.modelId,
            availableModels: [{ id: selection.modelId, name: 'Team model' }], activeSelectionV1: {
                v: 2, source: 'runtime_apply', runner: params.currentRunnerProcessIdentity,
                selection: { agentTargetKey: selection.agentTargetKey, providerConnectionId: null, modelId: selection.modelId },
                teamCredentialModel: { kind: 'team_credential_provider_model', ...team, expectedResourceRevision },
            },
        } });
        expect(resolveSessionModelSelectionDisposition({ ...params, metadata: applied })).toMatchObject({
            proposedSelectionV2: {
                ref: { source: 'team_resource', modelId: 'team-model', expectedResourceRevision: 7 },
            },
            selectedTeamCredentialModel: { modelId: 'team-model', expectedResourceRevision },
            selectionTransitionPending: false,
        });
    });

    it('keeps an active proposal pending until exact runner authority proves it active', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            modelSelectionIntentV1: {
                v: 1,
                updatedAt: 11,
                selection: {
                    agentTargetKey: 'agent:happier.agent.claude/claude',
                    providerConnectionId: null,
                    modelId: 'proposed-model',
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 10,
                currentModelId: 'last-reported-model',
                availableModels: [],
            },
        });

        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude',
            agentTargetKey: 'agent:happier.agent.claude/claude',
            metadata,
            sessionActive: true,
            currentRunnerProcessIdentity: null,
        })).toMatchObject({
            activeSelection: null,
            selectionTransitionPending: true,
            reportedSelection: {
                agentTargetKey: 'agent:happier.agent.claude/claude',
                providerConnectionId: null,
                modelId: 'last-reported-model',
            },
            reportedSelectionStatus: 'last_reported',
            contextSelection: null,
        });
    });

    it('does not project an incoherent Provider binding as last-reported model truth', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            providerBindingV1: {
                v: 1,
                connectionId: 'pc_provider',
                contributionKey: 'plugin.openrouter/openrouter',
                connectionRevision: 3,
                protocol: 'openai-responses',
                materialization: 'engineConfig',
                adapterBindingKey: 'openrouter',
                compatibilityFingerprint: 'compatibility-v1',
                bindingSecurityFingerprint: 'incoherent-fingerprint',
                displaySnapshot: {
                    providerName: 'OpenRouter',
                    connectionName: 'Work',
                    connectionRole: 'named',
                    connectionDisplayNameMode: 'custom',
                },
                model: {
                    id: 'provider-last-reported',
                    name: 'Provider last reported',
                    contextWindowTokens: 400_000,
                },
                runtimeBindingBasis: {
                    v: 1,
                    deployment: { kind: 'external' },
                    agentTargetKey: 'agent:happier.agent.claude/claude',
                    connectionId: 'pc_provider',
                    contributionKey: 'plugin.openrouter/openrouter',
                    endpoint: {
                        endpointTemplateId: 'responses',
                        normalizedUrl: 'https://provider.example/v1',
                        protocol: 'openai-responses',
                        publicHeaders: { 'x-provider': 'openrouter' },
                    },
                    runtimeCredentialTransport: {
                        id: 'runtime-bearer',
                        protocols: ['openai-responses'],
                        uses: ['runtime'],
                        destination: {
                            kind: 'httpHeader',
                            name: 'authorization',
                            format: 'bearer',
                        },
                    },
                    prepared: {
                        v: 1,
                        materialization: 'engineConfig',
                        adapterBindingKey: 'openrouter',
                    },
                    adapterVersion: 1,
                    credentialAuthorization: {
                        connectionSecurityFingerprint: 'connection-security-v1',
                        grantFingerprint: 'grant-v1',
                        selectedSecretBindingId: 'binding-v1',
                        selectedSecretRecordFingerprint: 'record-v1',
                    },
                    agentSupport: {
                        acceptsProtocols: ['openai-responses'],
                        required: { streaming: true },
                        credentialSupport: {
                            supportsNoAuth: false,
                            apiKeyTransports: [{
                                protocol: 'openai-responses',
                                destination: {
                                    kind: 'httpHeader',
                                    names: ['authorization'],
                                    formats: ['bearer'],
                                },
                            }],
                        },
                        authIsolation: {
                            suppressConnectedServiceIds: [],
                            ownedEnvKeys: ['OPENAI_API_KEY'],
                        },
                        materialization: 'engineConfig',
                        applyPolicy: 'live',
                        supportsFreeformModelIds: true,
                    },
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'provider-last-reported',
                availableModels: [{
                    id: 'provider-last-reported',
                    name: 'Provider last reported',
                    contextWindowTokens: 400_000,
                }],
            },
        });

        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude',
            agentTargetKey: 'agent:happier.agent.claude/claude',
            metadata,
            sessionActive: false,
            currentRunnerProcessIdentity: null,
        })).toMatchObject({
            reportedSelection: null,
            reportedSelectionStatus: null,
            contextSelection: null,
        });

        const parsed = readSessionProviderBindingMetadataStateV1(metadata);
        if (parsed.kind !== 'valid') throw new Error('Expected a structurally valid binding fixture');
        const binding = parsed.binding;
        const basis = binding.runtimeBindingBasis;
        if (!basis || !('normalizedUrl' in basis.endpoint) || !binding.model) throw new Error('Expected external Provider basis');
        const selection = { agentTargetKey: basis.agentTargetKey, providerConnectionId: binding.connectionId, modelId: binding.model.id };
        const coherent = { ...metadata,
            sessionModelsV1: { ...metadata.sessionModelsV1!, activeSelectionV1: { v: 1 as const, source: 'runtime_apply' as const,
                selection, runner: { pid: 42, processStartTimeMs: 10 } } },
            providerBindingV1: { ...binding,
                bindingSecurityFingerprint: createProviderBindingSecurityFingerprintV1({
                    agentTargetKey: basis.agentTargetKey, connectionId: basis.connectionId, modelId: binding.model.id,
                    modelCapabilities: binding.model.capabilities ?? {}, endpointTemplateId: basis.endpoint.endpointTemplateId,
                    endpointUrl: basis.endpoint.normalizedUrl, protocol: basis.endpoint.protocol, publicHeaders: basis.endpoint.publicHeaders,
                    materialization: basis.prepared.materialization, adapterBindingKey: basis.prepared.adapterBindingKey,
                    ...(basis.runtimeCredentialTransport ? { credentialDestination: basis.runtimeCredentialTransport.destination } : {}),
                    compatibilityFingerprint: binding.compatibilityFingerprint, adapterVersion: basis.adapterVersion,
                }),
            },
        };
        expect(resolveSessionModelSelectionDisposition({ metadata: { ...coherent,
            sessionModelsV1: { ...coherent.sessionModelsV1, availableModels: [] } },
            agentId: 'claude', agentTargetKey: selection.agentTargetKey, sessionActive: true,
            currentRunnerProcessIdentity: { pid: 42, processStartTimeMs: 10 },
        })).toMatchObject({ activeSelection: selection, selectionTransitionPending: false,
            reportedSelectionStatus: 'running' });
        const native = { label: 'Native', authSource: 'native' as const, connectedCount: 0 };
        for (const sessionActive of [true, false]) {
            const disposition = resolveSessionModelSelectionDisposition({ agentId: 'claude', agentTargetKey: basis.agentTargetKey,
                metadata: coherent, sessionActive, currentRunnerProcessIdentity: null });
            expect(disposition.activeSelection).toBeNull();
            if (sessionActive) expect(disposition.contextSelection).toBeNull();
            const presentation = resolveSessionRoutePresentation({ phase: sessionActive ? 'running' : 'draft',
                selection: disposition.contextSelection,
                appliedSelection: disposition.activeSelection, reportedSelection: disposition.lastAppliedSelection,
                appliedProviderSource: { connectionId: binding.connectionId, ...binding.displaySnapshot }, native });
            expect(presentation.applied.kind).toBe(sessionActive ? 'unknown' : 'provider');
            expect(presentSessionRouteChip(presentation, native)).toEqual({
                label: t('connectedServices.authChip.runsThrough', { source: 'OpenRouter · Work' }),
            });
        }
    });
});
