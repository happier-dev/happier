import { describe, expect, it } from 'vitest';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol';

import {
    RememberedEngineSelectionsByScopeV1Schema,
    readRememberedEngineSelection,
    upsertRememberedEngineSelection,
} from './rememberedEngineSelections';

const codexTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const;
const ohMyPiTarget = { kind: 'backend', backendId: 'ohMyPi', sourceKind: 'built_in' } as const;

describe('remembered engine selections', () => {
    it('normalizes a legacy bare model to a native structured selection using the scoped target', () => {
        const parsed = RememberedEngineSelectionsByScopeV1Schema.parse({
            'server-a:backend:codex': {
                v: 1,
                modelId: 'gpt-5.5',
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
                updatedAt: 42,
            },
        });

        expect(parsed['server-a:backend:codex']).toEqual({
            v: 1,
            modelSelection: {
                v: 1,
                updatedAt: 42,
                ref: {
                    agentTargetKey: 'backend:codex',
                    providerConnectionId: null,
                    modelId: 'gpt-5.5',
                },
            },
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            updatedAt: 42,
        });
    });

    it('normalizes the legacy default sentinel to automatic rather than a literal model id', () => {
        const parsed = RememberedEngineSelectionsByScopeV1Schema.parse({
            'server-a:backend:codex': { v: 1, modelId: 'default', updatedAt: 42 },
        });

        expect(parsed['server-a:backend:codex']?.modelSelection).toBeNull();
    });

    it('writes an explicit model as a target-bound selection and automatic as null', () => {
        const explicit = upsertRememberedEngineSelection({
            selectionsByScope: {},
            serverId: 'server-a',
            backendTarget: codexTarget,
            selection: {
                modelSelection: {
                    v: 1,
                    updatedAt: 50,
                    ref: {
                        agentTargetKey: 'backend:codex',
                        providerConnectionId: null,
                        modelId: 'gpt-5.5',
                    },
                },
            },
            updatedAt: 50,
        });
        expect(readRememberedEngineSelection({
            enabled: true,
            selectionsByScope: explicit,
            serverId: 'server-a',
            backendTarget: codexTarget,
        })?.modelSelection?.ref).toEqual({
            agentTargetKey: 'backend:codex',
            providerConnectionId: null,
            modelId: 'gpt-5.5',
        });

        const automatic = upsertRememberedEngineSelection({
            selectionsByScope: explicit,
            serverId: 'server-a',
            backendTarget: codexTarget,
            selection: { modelSelection: null },
            updatedAt: 51,
        });
        expect(readRememberedEngineSelection({
            enabled: true,
            selectionsByScope: automatic,
            serverId: 'server-a',
            backendTarget: codexTarget,
        })?.modelSelection).toBeNull();
    });

    it('preserves provider connection identity and refuses a different target', () => {
        const modelSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 50,
            ref: {
                agentTargetKey: 'backend:codex',
                providerConnectionId: 'pc_01J00000000000000000000000',
                modelId: 'openai/gpt-5.5',
            },
        });
        const explicit = upsertRememberedEngineSelection({
            selectionsByScope: {},
            serverId: 'server-a',
            backendTarget: codexTarget,
            selection: { modelSelection },
            updatedAt: 50,
        });

        expect(readRememberedEngineSelection({
            enabled: true,
            selectionsByScope: explicit,
            serverId: 'server-a',
            backendTarget: codexTarget,
        })?.modelSelection).toEqual(modelSelection);

        expect(() => upsertRememberedEngineSelection({
            selectionsByScope: {},
            serverId: 'server-a',
            backendTarget: codexTarget,
            selection: {
                modelSelection: SessionModelSelectionV1Schema.parse({
                    ...modelSelection,
                    ref: { ...modelSelection.ref, agentTargetKey: 'backend:claude' },
                }),
            },
            updatedAt: 50,
        })).toThrow(/target mismatch/i);
    });

  it('drops a legacy entry when its scope cannot prove the agent target', () => {
        const parsed = RememberedEngineSelectionsByScopeV1Schema.parse({
            'server-a:not-a-target': { v: 1, modelId: 'gpt-5.5', updatedAt: 42 },
        });
    expect(parsed).toEqual({});
  });

  it('migrates Oh My Pi selection and cache keys to the qualified Agent identity', () => {
    const parsed = RememberedEngineSelectionsByScopeV1Schema.parse({
      'server-a:backend:ohMyPi': {
        v: 1,
        modelId: 'anthropic/claude-sonnet-4-6',
        updatedAt: 42,
      },
    });

    expect(parsed).toEqual({
      'server-a:agent:happier.agent.ohmypi/ohmypi': {
        v: 1,
        modelSelection: {
          v: 1,
          updatedAt: 42,
          ref: {
            agentTargetKey: 'agent:happier.agent.ohmypi/ohmypi',
            providerConnectionId: null,
            modelId: 'anthropic/claude-sonnet-4-6',
          },
        },
        updatedAt: 42,
      },
    });

    const written = upsertRememberedEngineSelection({
      selectionsByScope: {},
      serverId: 'server-a',
      backendTarget: ohMyPiTarget,
      selection: {
        modelSelection: {
          v: 1,
          updatedAt: 43,
          ref: {
            agentTargetKey: 'agent:happier.agent.ohmypi/ohmypi',
            providerConnectionId: null,
            modelId: 'openai/gpt-5.5',
          },
        },
      },
      updatedAt: 43,
    });
    expect(Object.keys(written)).toEqual([
      'server-a:agent:happier.agent.ohmypi/ohmypi',
    ]);
    expect(JSON.stringify(written)).not.toContain('ohMyPi');
  });

  it('imports the predecessor Oh My Pi Agent cache key into the qualified identity', () => {
    expect(RememberedEngineSelectionsByScopeV1Schema.parse({
      'server-a:agent:ohMyPi': {
        v: 1,
        modelId: 'anthropic/claude-sonnet-4-6',
        updatedAt: 42,
      },
    })).toEqual({
      'server-a:agent:happier.agent.ohmypi/ohmypi': {
        v: 1,
        modelSelection: {
          v: 1,
          updatedAt: 42,
          ref: {
            agentTargetKey: 'agent:happier.agent.ohmypi/ohmypi',
            providerConnectionId: null,
            modelId: 'anthropic/claude-sonnet-4-6',
          },
        },
        updatedAt: 42,
      },
    });
  });
});
