import { describe, expect, it } from 'vitest';

import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import {
    AGENTS_UI_BEHAVIOR,
    CANONICAL_AGENTS_UI_BEHAVIOR,
    resolveAgentUiBehavior,
    resolveAgentUiBehaviorFromFlavor,
    resolveAgentUiBehaviorFromSessionMetadata,
    resolvePendingDeliveryLabelKeyForSession,
    supportsEditableSessionGoals,
} from './registryUiBehavior';

const BASE_METADATA = {
    path: '/tmp/project',
    host: 'localhost',
    flavor: 'codex',
} satisfies Metadata;

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadata: BASE_METADATA,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...overrides,
    };
}

describe('resolveAgentUiBehaviorFromFlavor', () => {
    it('keeps customAcp out of the canonical UI behavior registry (no active UI behavior special-casing)', () => {
        expect(AGENTS_UI_BEHAVIOR).not.toHaveProperty('customAcp');
        expect(CANONICAL_AGENTS_UI_BEHAVIOR).not.toHaveProperty('customAcp');
        expect(resolveAgentUiBehavior('customAcp').newSession?.getAgentInputExtraActionChips).toBeUndefined();
        expect(resolveAgentUiBehavior('customAcp').newSession?.canSelectWithoutDetectedCli).toBeUndefined();
    });

    it('resolves provider behavior through shared flavor aliases', () => {
        const behavior = resolveAgentUiBehaviorFromFlavor('open-code');

        expect(behavior?.externalSessions?.browse?.getSourceOptions).toBeTypeOf('function');
    });

    it('resolves provider behavior from canonical session runtime metadata before stale flavor', () => {
        const behavior = resolveAgentUiBehaviorFromSessionMetadata({
            flavor: 'claude',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                provider: {
                    backendMode: 'appServer',
                },
            },
        });

        expect(behavior?.permissions?.footer?.stopHandling).toBe('denyOnly');
        expect(behavior?.permissions?.footer?.supportsExecPolicyAmendment).toBe(true);
    });

    it('resolves layout-v1 Agent behavior only from the owner metadata view', () => {
        const session = makeSession({
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                flavor: 'codex',
            } as unknown as Metadata,
            ownerMetadataView: {
                flavor: 'claude',
            } as unknown as Metadata,
        });

        expect(resolvePendingDeliveryLabelKeyForSession({
            session,
            localId: null,
            detail: 'custody_observed',
        })).toBe('session.pendingMessages.deliveryStatus.queuedInClaude');
        expect(resolvePendingDeliveryLabelKeyForSession({
            session: makeSession({
                metadataLayoutVersion: 1,
                metadata: {
                    v: 1,
                    flavor: 'codex',
                } as unknown as Metadata,
                ownerMetadataView: null,
            }),
            localId: null,
            detail: 'custody_observed',
        })).toBeNull();
    });

    it('keeps codex-specific permission footer overrides on the native codex agent', () => {
        const behavior = resolveAgentUiBehaviorFromFlavor('codex');

        expect(behavior?.permissions?.footer?.stopHandling).toBe('denyOnly');
        expect(behavior?.permissions?.footer?.supportsExecPolicyAmendment).toBe(true);
    });

    it('projects Claude context-window fallbacks through provider UI behavior', () => {
        const contextWindow = resolveAgentUiBehavior('claude').contextWindow;

        expect(contextWindow?.getDefaultContextWindowTokens?.()).toBe(200_000);
        expect(contextWindow?.getContextWindowTokensForModel?.({ modelId: 'claude-sonnet-4-6[1m]' })).toBe(1_000_000);
        expect(contextWindow?.bumpContextWindowTokensForObservedUsage?.({
            contextWindowTokens: 200_000,
            observedUsedTokens: 733_000,
        })).toBe(1_000_000);
    });

    it('projects Claude AskUserQuestion presentation through the plugin behavior registry', () => {
        expect(resolveAgentUiBehavior('claude').workflow?.resolveAskUserQuestionPresentation).toBeTypeOf('function');
    });

    it('projects pending delivery presentation through the Claude provider behavior', () => {
        expect(resolveAgentUiBehavior('claude').pendingDelivery?.resolveLabelKey).toBeTypeOf('function');
        expect(resolveAgentUiBehavior('codex').pendingDelivery?.resolveLabelKey).toBeUndefined();
    });

    it('projects current Codex catalog windows through provider UI behavior', () => {
        const contextWindow = resolveAgentUiBehavior('codex').contextWindow;

        expect(contextWindow?.getDefaultContextWindowTokens?.()).toBe(372_000);
        expect(contextWindow?.getContextWindowTokensForModel?.({ modelId: 'gpt-5.6-sol' })).toBe(372_000);
        expect(contextWindow?.getContextWindowTokensForModel?.({ modelId: 'gpt-5.4-mini' })).toBe(272_000);
    });

    it('uses the generic codex-decision footer behavior for opencode flavors', () => {
        const behavior = resolveAgentUiBehaviorFromFlavor('open-code');

        expect(behavior?.permissions?.footer?.stopHandling).toBe('denyAndAbortRun');
        expect(behavior?.permissions?.footer?.supportsExecPolicyAmendment).toBe(false);
    });

    it('uses a neutral fallback for unknown backend/provider ids instead of the custom ACP behavior profile', () => {
        const unknownBehavior = resolveAgentUiBehavior('acme.review.backend');

        expect(unknownBehavior).toBe(resolveAgentUiBehavior('customAcp'));
        expect(unknownBehavior.newSession?.getAgentInputExtraActionChips).toBeUndefined();
        expect(unknownBehavior.newSession?.canSelectWithoutDetectedCli).toBeUndefined();
    });

    it('allows editable goals for Codex app-server sessions without enabling them for ACP or other agents', () => {
        const appServerMetadata = {
            ...BASE_METADATA,
            agentRuntimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                provider: { backendMode: 'appServer' },
            },
        } satisfies Metadata;
        const acpMetadata = {
            ...BASE_METADATA,
            agentRuntimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                provider: { backendMode: 'acp' },
            },
        } satisfies Metadata;

        expect(supportsEditableSessionGoals({
            agentId: 'codex',
            session: makeSession({ metadata: appServerMetadata }),
        })).toBe(true);
        expect(supportsEditableSessionGoals({
            agentId: 'codex',
            session: makeSession({ metadata: acpMetadata }),
        })).toBe(false);
        expect(supportsEditableSessionGoals({
            agentId: 'claude',
            session: makeSession({ active: true, metadata: { ...BASE_METADATA, flavor: 'claude' } }),
        })).toBe(false);
    });

    it('keeps inactive Codex sessions goal-editable when a persisted goal work-state exists', () => {
        expect(supportsEditableSessionGoals({
            agentId: 'codex',
            session: makeSession({
                active: false,
                metadata: {
                    ...BASE_METADATA,
                    sessionWorkStateV1: {
                        v: 1,
                        agentId: 'codex',
                        backendId: 'codex',
                        items: [{ id: 'goal-1', kind: 'goal', title: 'Ship port' }],
                    },
                } satisfies Metadata,
            }),
        })).toBe(true);
    });
});
