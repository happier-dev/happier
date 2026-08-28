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
        settingKey: 'experiments',
        when: { all: [{ kind: 'experimentsEnabled' }, { kind: 'settingTrue', settingKey: 'experiments' }] },
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
          settingId: 'reviewScopePreference',
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
                settingId: 'reviewScopePreference',
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

  /**
   * Under `payload.backendTransport` the interpreter reads `agentExtra` as an
   * identity only (`owner`/`schemaId`/`v`) and takes the runtime-handle fields
   * from the sibling `backendTransport.runtimeHandleFields`. Requiring them
   * inside `agentExtra` there refuses the exact shape the bundled Codex Agent
   * declares, so an external author copying it would be rejected at their
   * manifest for a field the interpreter never reads.
   */
  it('accepts a backend-transport agentExtra identity without repeating the runtime-handle fields', () => {
    const result = parse({
      behavior: {
        payload: {
          backendTransport: {
            backendMode: { values: ['acp', 'appServer'], aliases: { mcp: 'appServer' } },
            runtimeHandleFields: ['backendMode', 'providerSessionId'],
            agentExtra: { owner: 'acme', schemaId: 'acme.agentRuntimeDescriptorExtra', v: 1 },
          },
        },
      },
    });
    expect(result.success ? null : result.error.issues).toBeNull();
  });

  it('keeps current runtime transport output canonical instead of authoring legacy output keys', () => {
    expect(parse({
      behavior: {
        payload: {
          backendTransport: {
            legacyModeOutputKey: 'acmeBackendMode',
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
                runtimeDescriptorOutputKey: 'customDescriptor',
                backendMode: { values: ['acp'] },
                sourceFields: [],
              },
            },
          },
        },
      },
    }).success).toBe(false);
  });

  /**
   * Where the interpreter DOES read the fields off `agentExtra` itself — the
   * environment-variable and link-extras descriptors — omitting them makes the
   * whole `agentExtra` silently vanish, so the grammar still requires them.
   */
  it('still requires the runtime-handle fields on an agentExtra the interpreter reads them from', () => {
    expect(parse({
      behavior: {
        payload: {
          environmentVariables: {
            backendMode: {
              envKey: 'ACME_MODE',
              settingKey: 'acmeMode',
              legacyMetadataKey: 'acmeMode',
              runtimeDescriptorField: 'backendMode',
              defaultValue: 'server',
              values: ['server'],
            },
            agentExtra: { owner: 'acme', schemaId: 'acme.agentRuntimeDescriptorExtra', v: 1 },
          },
        },
      },
    }).success).toBe(false);
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
