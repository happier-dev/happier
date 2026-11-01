import * as z from 'zod/mini';
import type { core } from 'zod/mini';
import { ActionJsonSchemaProjectionError, zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import { compileProtocolJsonSchema } from '../actions/jsonSchemaCompiler.js';
import { createPluginManifestJsonSchemaV2 } from '../manifest/jsonSchema.js';
import { PluginManifestV2Schema } from '../manifest/v2.js';
import { describe, expect, it } from 'vitest';

import { AgentUiProjectedDeclarationV1Schema } from './agentUiGrammar.js';
import { PluginAgentUiBehaviorContributionV2Schema } from './v2.js';

/**
 * A complete, realistic installed-Agent declaration: the composer option an
 * Agent owns, the host-owned control that edits it, and the External Sessions
 * browse presentation. Everything here is something an external author can
 * actually reach, so the grammar has to accept all of it — a grammar narrower
 * than the interpreter would silently remove author capability.
 */
const SUPPORTED_DECLARATION = {
  behavior: {
    descriptorId: 'acme.uiBehavior.v1',
    permissions: { footer: { usePermissionUpdates: true, stopHandling: 'denyAndAbortRun' } },
    resume: {
      experimentSwitches: [{
        id: 'acme.fastResume',
        settingKey: { scope: 'account', localId: 'experiments' },
        when: { all: [{ kind: 'experimentsEnabled' }, { kind: 'settingTrue', settingKey: { scope: 'account', localId: 'experiments' } }] },
      }],
    },
    contextWindow: { defaultTokens: 200000, observedUsageBumpTokens: [400000] },
    newSession: {
      transcriptStorageModes: ['persisted', 'direct'],
      agentOptions: [{ key: 'allowIndexing', kind: 'boolean', spawnConfigOption: true }],
    },
    payload: {
      spawnSessionExtras: { kind: 'static', value: { acmeMode: 'fast' } },
      sessionExtras: { outputKey: 'acmeMode', values: ['fast', 'thorough'] },
    },
    askUserQuestion: {
      dialogs: [{
        dialogId: 'review_scope_confirmation',
        settingMutation: {
          settingId: { scope: 'account', localId: 'reviewScopePreference' },
          allowedValues: ['ask_every_time', 'always_include'],
        },
        terminalNotice: {
          headerKey: 'tools.askUserQuestion.reviewScope.header',
          questionKey: 'tools.askUserQuestion.reviewScope.question',
        },
        terminalSecondaryAction: {
          kind: 'openAttachedTerminal',
          labelKey: 'tools.askUserQuestion.reviewScope.openTerminal',
          descriptionKey: 'tools.askUserQuestion.reviewScope.description',
        },
      }],
    },
    externalSessions: {
      browse: {
        order: 4,
        sourceOptions: [{
          key: 'acme:archive',
          labelKey: 'acme.browse.archive',
          source: { kind: 'acmeArchive' },
        }],
      },
      sessionHandoff: { clearMetadataKeys: ['acmeRunId'] },
    },
  },
  message: {
    metaOverrides: [{
      id: 'acme.mode',
      targetKey: 'acmeMode',
      value: { kind: 'sessionConfigOptionOverride', key: 'acmeMode' },
      normalize: 'trimLowercase',
    }],
  },
  session: {
    providerBehavior: {
      kind: 'session.providerBehavior.v1',
      participants: {
        sidechainIds: {
          kind: 'toolCallInputString',
          toolNames: ['AcmeWorker'],
          inputKey: 'workerId',
        },
      },
    },
    visibleMessages: {
      kind: 'session.visibleMessages.v1',
      subagentKinds: ['acme_worker'],
      fallbackToolNames: ['AcmeWorker'],
      excludeJsonEventTypes: ['acme_internal'],
    },
  },
  components: {
    slots: [{
      id: 'acme-allow-indexing',
      slot: 'newSession.agentInputExtraActionChips',
      chip: {
        kind: 'booleanOption',
        optionStateKey: 'allowIndexing',
        iconName: 'magnifying-glass',
        onLabelKey: 'acme.indexing.on',
        offLabelKey: 'acme.indexing.off',
      },
    }],
  },
} as const;

function parse(value: unknown) {
  return PluginAgentUiBehaviorContributionV2Schema.safeParse(value);
}

describe('public Agent UI authoring grammar', () => {
  it('admits boolean runtime selection without a spawn configuration output', () => {
    expect(parse({ behavior: { payload: { sessionExtras: {
      values: ['sdk', 'terminal'], settingKey: { scope: 'account', localId: 'useTerminal' },
      booleanValues: { true: 'terminal', false: 'sdk' }, defaultValue: 'sdk',
    } } } }).success).toBe(true);
  });
  it('admits an optional Agent identity hue without requiring behavior or controls', () => {
    const declaration = { identityColor: { light: '#eb6834', dark: '#d95926' } };
    const result = parse(declaration);
    expect(result.success ? result.data : result.error.issues).toEqual(declaration);
    expect(AgentUiProjectedDeclarationV1Schema.parse(declaration)).toEqual(declaration);
    expect(parse({ identityColor: { light: 'red', dark: '#d95926' } }).success).toBe(false);
    expect(parse({ identityColor: { light: '#eb6834' } }).success).toBe(false);
    expect(parse({ identityColor: { ...declaration.identityColor, agentId: 'claude' } }).success).toBe(false);
    expect(parse({ ...declaration, identityColour: declaration.identityColor }).success).toBe(false);
  });

  it('accepts the full declarative language an installed Agent can reach', () => {
    const result = parse(SUPPORTED_DECLARATION);
    expect(result.success ? null : result.error.issues).toBeNull();
  });

  it('refuses a misspelled declaration instead of letting it no-op at render time', () => {
    expect(parse({
      behavior: { newSession: { agentOptions: [{ key: 'allowIndexing', kind: 'bool' }] } },
    }).success).toBe(false);
    expect(parse({
      behavior: { newSession: { agentOption: [{ key: 'allowIndexing', kind: 'boolean' }] } },
    }).success).toBe(false);
    expect(parse({
      behavior: { newSession: { transcriptStorageModes: ['ephemeral'] } },
    }).success).toBe(false);
    expect(parse({
      behavior: {
        askUserQuestion: {
          dialogs: [{ dialogId: 'review_scope_confirmation' }],
        },
      },
    }).success).toBe(false);
    expect(parse({
      behavior: {
        askUserQuestion: {
          dialogs: [
            {
              dialogId: 'review_scope_confirmation',
              settingMutation: {
                settingId: { scope: 'account', localId: 'reviewScopePreference' },
                allowedValues: ['ask_every_time'],
              },
            },
            {
              dialogId: 'review_scope_confirmation',
              terminalNotice: {
                headerKey: 'tools.askUserQuestion.reviewScope.header',
                questionKey: 'tools.askUserQuestion.reviewScope.question',
              },
            },
          ],
        },
      },
    }).success).toBe(false);
  });

  it('requires every setting reference to name its scope', () => {
    expect(parse({
      behavior: { resume: { experimentSwitches: [{ id: 'resume', settingKey: 'legacyBareId' }] } },
    }).success).toBe(false);
    expect(parse({
      behavior: {
        resume: {
          experimentSwitches: [{
            id: 'resume',
            settingKey: { scope: 'account', localId: 'ownedSetting' },
          }],
        },
      },
    }).success).toBe(true);
  });

  it('keeps host preferences readable but refuses them as plugin setting mutation targets', () => {
    expect(parse({
      behavior: {
        resume: {
          experimentSwitches: [{
            id: 'resume',
            settingKey: { scope: 'host', localId: 'experiments' },
          }],
        },
      },
    }).success).toBe(true);
    expect(parse({
      behavior: {
        askUserQuestion: {
          dialogs: [{
            dialogId: 'review_scope_confirmation',
            settingMutation: {
              settingId: { scope: 'host', localId: 'reviewScopePreference' },
              allowedValues: ['always_include'],
            },
          }],
        },
      },
    }).success).toBe(false);
  });

  it('rejects a nested Agent identity that could conflict with the enclosing contribution', () => {
    expect(parse({
      behavior: {
        payload: {
          sessionExtras: {
            providerId: 'another.agent',
            outputKey: 'acmeMode',
            values: ['fast'],
          },
        },
      },
    }).success).toBe(false);
  });

  /**
   * Each of these is a shape the client interpreter answers with a refusal
   * diagnostic — a compiled first-party component, a compiled payload adapter,
   * a compiled message-meta descriptor. A public grammar that accepted them
   * would promise external authors a capability that cannot work.
   */
  it('refuses compiled component ids while admitting same-plugin inline surfaces', () => {
    expect(parse({
      components: { slots: [{ id: 'x', slot: 'session.detailsTabs', componentId: 'firstParty.claude.teammateDetailsTab' }] },
    }).success).toBe(false);
    expect(parse({
      components: {
        slots: [{
          id: 'x',
          slot: 'sessionSubagents.teammateDetailsTab',
          surfaceId: 'subagent-details',
          resourceKind: 'acmeTeams',
          iconName: 'people',
          tab: { keyPrefix: 'acme', titleKey: 'acme.tab.title' },
        }],
      },
    }).success).toBe(true);
    expect(parse({
      components: {
        slots: [{
          id: 'x',
          slot: 'sessionSubagents.launchCards',
          surfaceId: 'subagent-launch',
          props: { teamIds: { kind: 'subagentGroupKeys', subagentKinds: ['agent_team_member'] } },
        }],
      },
    }).success).toBe(true);
    // The declarative twin is the host-owned control, which really renders.
    expect(parse({
      components: {
        slots: [{
          id: 'acme-indexing',
          slot: 'newSession.agentInputExtraActionChips',
          chip: {
            kind: 'booleanOption',
            optionStateKey: 'allowIndexing',
            iconName: 'magnifying-glass',
            onLabelKey: 'acme.chip.on',
            offLabelKey: 'acme.chip.off',
          },
        }],
      },
    }).success).toBe(true);
    // A slot row without the control is refused where it is written rather
    // than silently contributing nothing.
    expect(parse({
      components: { slots: [{ id: 'acme-indexing', slot: 'newSession.agentInputExtraActionChips' }] },
    }).success).toBe(false);

    expect(parse({
      behavior: { payload: { spawnSessionExtras: { kind: 'adapter', adapterId: 'codex.backendMode' } } },
    }).success).toBe(false);
    expect(parse({
      behavior: { payload: { spawnSessionExtras: { kind: 'static', value: { acmeMode: 'fast' } } } },
    }).success).toBe(true);
    expect(parse({
      behavior: { payload: { spawnSessionExtras: { kind: 'static', value: { acmeMode: { nested: true } } } } },
    }).success).toBe(false);
    expect(parse({
      behavior: { payload: { spawnSessionExtras: { kind: 'static', value: { acmeMode: ['fast'] } } } },
    }).success).toBe(false);

    expect(parse({ message: { metaDescriptorIds: ['claude.thinking'] } }).success).toBe(false);
    expect(parse({
      message: {
        metaOverrides: [{
          id: 'acme.mode',
          targetKey: 'acmeMode',
          value: { kind: 'sessionConfigOptionOverride', key: 'acmeMode' },
        }],
      },
    }).success).toBe(true);
  });

  it('keeps Agent-owned runtime descriptors outside the generic UI declaration grammar', () => {
    expect(parse({
      behavior: {
        payload: {
          backendTransport: {
            backendMode: { values: ['acp'] },
            runtimeHandleFields: ['backendMode'],
          },
        },
      },
    }).success).toBe(false);
    expect(parse({
      behavior: {
        externalSessions: {
          browse: {
            linkEnsureRequestExtras: {
              runtimeDescriptorFromCandidate: {
                backendMode: { values: ['acp'] },
                sourceFields: [],
              },
            },
          },
        },
      },
    }).success).toBe(false);
  });

  it('accepts setting-backed environment variables without descriptor interpretation fields', () => {
    expect(parse({
      behavior: {
        payload: {
          environmentVariables: {
            backendMode: {
              envKey: 'ACME_MODE',
              settingKey: { scope: 'account', localId: 'acmeMode' },
              defaultValue: 'server',
              values: ['server'],
            },
          },
        },
      },
    }).success).toBe(true);
  });

  it('refuses an unknown top-level block rather than carrying it as an opaque bag', () => {
    expect(parse({ behaviour: { guidance: {} } }).success).toBe(false);
    expect(parse({ behavior: { session: {} } }).success).toBe(false);
  });

  it('refuses compiled Session adapter ids while admitting the data-only public descriptors', () => {
    expect(parse({
      session: { providerBehaviorDescriptorId: 'acme.privateBehavior.v1' },
    }).success).toBe(false);
    expect(parse({
      session: { visibleMessageFilterDescriptorId: 'acme.privateMessages.v1' },
    }).success).toBe(false);
    expect(parse({
      session: {
        providerBehavior: {
          kind: 'session.providerBehavior.v1',
          participants: {
            sidechainIds: { kind: 'providerCallback', callbackId: 'acme.callback' },
          },
        },
      },
    }).success).toBe(false);
  });

  /**
   * The grammar is the AUTHORING gate; the projection is transport. Tightening
   * the carrier would turn one unreadable field — a newer plugin's declaration
   * reaching an older client, or a single typo in a trusted plugin — into a
   * missing Agent, when the client interpreter already answers it with a
   * per-field diagnostic and the neutral default.
   */
  it('still carries a declaration the authoring grammar refuses, so one bad field cannot remove the Agent', () => {
    const declarationFromANewerGrammar = {
      behavior: { newSession: { agentOptions: [{ key: 'allowIndexing', kind: 'tristate' }] } },
      session: { newerSessionDescriptor: { kind: 'session.future.v2' } },
    };
    expect(parse(declarationFromANewerGrammar).success).toBe(false);
    expect(AgentUiProjectedDeclarationV1Schema.safeParse(declarationFromANewerGrammar).success).toBe(true);
  });
});

describe('Agent UI grammar in the full public Manifest projection', () => {
  it('keeps shared identifiers, setting references, and dialogs concrete in both dialects', () => {
    const projections: { schema: ReturnType<typeof createPluginManifestJsonSchemaV2>;
      dialect: 'draft-07' | 'draft-2020-12' }[] = [
      { schema: createPluginManifestJsonSchemaV2(), dialect: 'draft-2020-12' },
    ];
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      projections.push({ schema: zodSchemaToJsonSchemaObject(PluginManifestV2Schema, { target, unrepresentable: 'any' }),
        dialect: target === 'draft-7' ? 'draft-07' : 'draft-2020-12' });
      // Custom authoring nodes are intentionally unrepresentable by the strict action helper.
      expect(() => zodSchemaToJsonSchemaObject(PluginManifestV2Schema, { target }))
        .toThrow(ActionJsonSchemaProjectionError);
    }
    const manifestForDeclaration = (ui: unknown) => ({
      schemaVersion: 2, id: 'acme.grammar', version: '0.1.0', displayName: 'Grammar fixture',
      engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/index.js' },
      contributes: { agents: [{
        id: 'example', title: 'Example', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } }, ui,
      }] },
    });
    for (const { schema, dialect } of projections) {
      // Validate the real public graph rather than assuming where Zod places its aliases.
      const validateManifest = compileProtocolJsonSchema(schema, dialect);
      const validManifest = manifestForDeclaration(SUPPORTED_DECLARATION);
      expect(PluginManifestV2Schema.safeParse(validManifest).success).toBe(true);
      expect(validateManifest(validManifest)).toBe(true);
      for (const scope of ['host', 'account', 'daemon']) {
        const scopedManifest = manifestForDeclaration({
          ...SUPPORTED_DECLARATION, behavior: { ...SUPPORTED_DECLARATION.behavior,
            payload: { sessionExtras: { ...SUPPORTED_DECLARATION.behavior.payload.sessionExtras,
              settingKey: { scope, localId: 'experiments' } } } },
        });
        expect(PluginManifestV2Schema.safeParse(scopedManifest).success).toBe(true);
        expect(validateManifest(scopedManifest)).toBe(true);
      }
      for (const candidate of [
        { ...SUPPORTED_DECLARATION, behavior: { ...SUPPORTED_DECLARATION.behavior, descriptorId: '' } },
        { ...SUPPORTED_DECLARATION, behavior: { ...SUPPORTED_DECLARATION.behavior,
          payload: { sessionExtras: { outputKey: 'acmeMode', values: false } } } },
        { ...SUPPORTED_DECLARATION, behavior: { ...SUPPORTED_DECLARATION.behavior,
          payload: { sessionExtras: { outputKey: 'acmeMode', settingKey: { localId: 'experiments' } } } } },
        { ...SUPPORTED_DECLARATION, behavior: { ...SUPPORTED_DECLARATION.behavior,
          payload: { sessionExtras: { ...SUPPORTED_DECLARATION.behavior.payload.sessionExtras,
            settingKey: { scope: 'global', localId: 'experiments' } } } } },
        { ...SUPPORTED_DECLARATION, behavior: { ...SUPPORTED_DECLARATION.behavior,
          askUserQuestion: { dialogs: [{ dialogId: '' }] } } },
        { ...SUPPORTED_DECLARATION, behavior: { ...SUPPORTED_DECLARATION.behavior,
          askUserQuestion: { dialogs: [{}] } } },
      ]) {
        const invalidManifest = manifestForDeclaration(candidate);
        expect(parse(candidate).success).toBe(false);
        expect(PluginManifestV2Schema.safeParse(invalidManifest).success).toBe(false);
        expect(validateManifest(invalidManifest)).toBe(false);
      }
    }
  });
});
