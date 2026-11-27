import { describe, expect, it, vi } from 'vitest';

import { QualifiedConnectedAccountPurposeBindingsV1RecordSchema, QualifiedConnectedAccountPurposeBindingsV1Schema } from '../../connect/connectedAccountPurposeBindings.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';
import {
  admitAgentConnectedAccountPurposeBindings,
  admitAgentConnectedAccountPurposeDeclarations,
  migrateLegacyAgentConnectedAccountPurposeDefaultsForActivation,
  projectAgentConnectedAccountPurposeDefaultsToSessionBindings,
  resolveAgentConnectedAccountPurposeDefaults,
  writeAgentConnectedAccountPurposeDefault,
  writeAgentConnectedServiceDefault,
  removeAgentConnectedAccountDefaultsForDeletedTarget,
} from './connectedServicesSettings.js';

const codex = { pluginId: 'happier.agent.codex', localId: 'codex' } as const;
const codexService = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
const claude = { pluginId: 'happier.agent.claude', localId: 'claude' } as const;
const claudeService = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' } as const;
const codexDeclarations = [{ purpose: 'model-openai', service: codexService }] as const;
const claudeDeclarations = [{ purpose: 'model-anthropic', service: claudeService }] as const;

/** Exactly what a released 0.2 Account Settings document stores (scalar Agent and service ids). */
const RELEASED_0_2_DEFAULT_AUTH = {
  v: 1,
  bindingsByAgentId: {
    codex: {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'group', groupId: 'codex-main' },
      },
    },
    claude: {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'work' },
      },
    },
  },
} as const;

/** What an earlier 0.3 build's Connected Services page wrote for a Team resource default. */
const EARLIER_0_3_TEAM_DEFAULT = {
  v: 1,
  bindingsByAgentId: {
    codex: {
      v: 2,
      bindingsByServiceId: {
        'happier.agent.codex/openai-codex': {
          source: 'team_resource',
          resourceId: 'resource-1',
          deliveryMode: 'brokered',
          serverId: 'home-a',
          accountId: 'account-a',
          teamId: 'team-acme',
          expectedResourceRevision: 3,
        },
      },
    },
  },
} as const;

/**
 * What the W28/W29 0.3 builds wrote into the purpose store: a Team default as
 * a `kind: 'team_resource'` purpose target. The purpose target union is back
 * to `account | group` (lane 10 child 02 :271, child 06 :506), so this is
 * earlier-0.3 data that must still read.
 */
const EARLIER_0_3_TEAM_PURPOSE_TARGET = {
  v: 1,
  bindings: [{
    purpose: { consumer: codex, purpose: 'model-openai' },
    target: {
      kind: 'team_resource',
      service: codexService,
      teamId: 'team-acme',
      selection: {
        source: 'team_resource',
        resourceId: 'resource-2',
        deliveryMode: 'direct',
        disclosedMember: { service: codexService, accountId: 'member-1' },
      },
    },
  }],
} as const;

const releasedAgents = [
  { agentId: 'codex', identity: codex, connectedAccounts: codexDeclarations },
  { agentId: 'claude', identity: claude, connectedAccounts: claudeDeclarations },
] as const;

function activate(
  settings: Parameters<typeof migrateLegacyAgentConnectedAccountPurposeDefaultsForActivation>[0]['settings'],
  agents: Parameters<typeof migrateLegacyAgentConnectedAccountPurposeDefaultsForActivation>[0]['agents'] = releasedAgents,
) {
  const result = migrateLegacyAgentConnectedAccountPurposeDefaultsForActivation({ settings, agents, purposeBindings: { v: 1, bindings: [] } });
  if (result.status !== 'ready') throw new Error(result.reason);
  return result.purposeBindings;
}

describe('Agent default authentication (one store)', () => {
  it('admits the complete current catalog beyond the legacy Settings reader limit', () => {
    const bindings = Array.from({ length: 257 }, (_, index) => ({
      purpose: { consumer: codex, purpose: `purpose-${index}` },
      target: { kind: 'account' as const, account: { service: codexService, accountId: 'work' } },
    }));
    const catalog = QualifiedConnectedAccountPurposeBindingsV1RecordSchema.parse({ v: 1, bindings });
    const purposeBindings = admitAgentConnectedAccountPurposeBindings(catalog);
    expect(purposeBindings.bindings).toHaveLength(bindings.length);
    expect(resolveAgentConnectedAccountPurposeDefaults({ consumer: codex, purposeBindings,
      declarations: admitAgentConnectedAccountPurposeDeclarations(codex, [{ purpose: 'purpose-256', service: codexService }]),
    })[0]?.target).toEqual(bindings[256]!.target);
  });

  it('joins owned immutable acquisitions without reparsing, while raw aliases and copied proofs still validate', () => {
    const consumer = { ...codex };
    const rawDeclarations = [{ purpose: 'model-openai', service: { ...codexService } }];
    const rawBindings = { v: 1, bindings: [{ purpose: { consumer: { ...codex }, purpose: 'model-openai' },
      target: { kind: 'account', account: { service: { ...codexService }, accountId: 'work' } } }] };
    const declarations = admitAgentConnectedAccountPurposeDeclarations(consumer, rawDeclarations);
    const purposeBindings = admitAgentConnectedAccountPurposeBindings(rawBindings);
    // Admission facts never become part of the persisted shape.
    expect(QualifiedConnectedAccountPurposeBindingsV1RecordSchema.parse(purposeBindings)).toEqual(rawBindings);
    rawDeclarations[0]!.purpose = '';
    rawBindings.bindings[0]!.target.account.accountId = 'changed';
    consumer.localId = 'changed';
    const input = { consumer: codex, declarations, purposeBindings };
    const parse = vi.spyOn(QualifiedConnectedAccountPurposeV1Schema, 'parse');
    try {
      for (let index = 0; index < 100; index++) {
        expect(resolveAgentConnectedAccountPurposeDefaults(input)[0]).toMatchObject({
          purpose: { consumer: codex, purpose: 'model-openai' },
          target: { kind: 'account', account: { service: codexService, accountId: 'work' } },
        });
      }
      expect(parse).toHaveBeenCalledTimes(0);
      expect(Object.isFrozen(purposeBindings.bindings[0]!.target)).toBe(true);
      expect(Object.isFrozen(declarations[0]!.service)).toBe(true);
      // Copying a carrier does not transfer its admission.
      const copiedBindings = Object.defineProperties({}, Object.getOwnPropertyDescriptors(purposeBindings));
      expect(resolveAgentConnectedAccountPurposeDefaults({ ...input, purposeBindings: copiedBindings as typeof purposeBindings })[0]?.target)
        .toEqual(purposeBindings.bindings[0]!.target);
      expect(parse).toHaveBeenCalledTimes(1);
      const copiedDeclarations = Object.defineProperties([], Object.getOwnPropertyDescriptors(declarations));
      resolveAgentConnectedAccountPurposeDefaults({ ...input, declarations: copiedDeclarations });
      expect(parse).toHaveBeenCalledTimes(2);
      // A real consumer change must qualify anew rather than reuse the old consumer's prepared key.
      expect(resolveAgentConnectedAccountPurposeDefaults({ ...input, consumer: claude })[0]?.target).toBeNull();
      expect(parse).toHaveBeenCalledTimes(3);
      expect(() => resolveAgentConnectedAccountPurposeDefaults({ ...input, declarations: rawDeclarations })).toThrow();
      expect(() => resolveAgentConnectedAccountPurposeDefaults({ ...input, purposeBindings: {
        v: 1, bindings: [{ ...purposeBindings.bindings[0]!, purpose: { consumer: codex, purpose: '' } }],
      } })).toThrow();
    } finally { parse.mockRestore(); }
  });

  it('refuses rebuilt admission facts on replacement binding and declaration carriers', () => {
    const purposeBindings = admitAgentConnectedAccountPurposeBindings({ v: 1, bindings: [{
      purpose: { consumer: codex, purpose: 'model-openai' },
      target: { kind: 'account', account: { service: codexService, accountId: 'work' } },
    }] });
    const declarations = admitAgentConnectedAccountPurposeDeclarations(codex, codexDeclarations);
    const input = { consumer: codex, declarations, purposeBindings };
    const rebuildReflectedFacts = <T extends object>(source: object, replacement: T): T => {
      for (const symbol of Object.getOwnPropertySymbols(source)) {
        const facts: unknown = Object.getOwnPropertyDescriptor(source, symbol)?.value;
        if (facts && typeof facts === 'object') {
          Object.defineProperty(replacement, symbol, { value: { ...facts, owner: replacement } });
        }
      }
      return replacement;
    };
    const replacementBindings = rebuildReflectedFacts(purposeBindings, { v: 1 as const, bindings: [{
      purpose: { consumer: codex, purpose: '' },
      target: { kind: 'account' as const, account: { service: codexService, accountId: 'other' } },
    }] });
    expect(() => resolveAgentConnectedAccountPurposeDefaults({ ...input, purposeBindings: replacementBindings })).toThrow();
    replacementBindings.bindings[0]!.purpose.purpose = 'model-openai';
    expect(resolveAgentConnectedAccountPurposeDefaults({ ...input, purposeBindings: replacementBindings })[0]?.target)
      .toEqual(replacementBindings.bindings[0]!.target);
    const replacementDeclarations = rebuildReflectedFacts(declarations, [{ purpose: '', service: codexService }]);
    expect(() => resolveAgentConnectedAccountPurposeDefaults({ ...input, declarations: replacementDeclarations })).toThrow();
    replacementDeclarations[0]!.purpose = 'another-purpose';
    expect(resolveAgentConnectedAccountPurposeDefaults({ ...input, declarations: replacementDeclarations })[0]?.target).toBeNull();
  });

  it('keeps indexed defaults immutable through both reflection and returned target aliases', () => {
    const purposeBindings = admitAgentConnectedAccountPurposeBindings({ v: 1, bindings: [{
      purpose: { consumer: codex, purpose: 'model-openai' },
      target: { kind: 'account', account: { service: codexService, accountId: 'work' } },
    }] });
    const declarations = admitAgentConnectedAccountPurposeDeclarations(codex, codexDeclarations);
    const input = { consumer: codex, declarations, purposeBindings };
    const expected = { kind: 'account', account: { service: codexService, accountId: 'work' } };
    for (const symbol of Object.getOwnPropertySymbols(purposeBindings)) {
      const facts: unknown = Object.getOwnPropertyDescriptor(purposeBindings, symbol)?.value;
      if (!facts || typeof facts !== 'object' || !('index' in facts)) continue;
      const index = facts.index;
      if (!index || typeof index !== 'object' || !('defaultFor' in index) || typeof index.defaultFor !== 'function') continue;
      const exposed: unknown = index.defaultFor(JSON.stringify([codex.pluginId, codex.localId, 'model-openai']));
      if (exposed && typeof exposed === 'object') {
        Reflect.set(exposed, 'target', { kind: 'account', account: { service: codexService, accountId: 'mutated-through-proof' } });
      }
    }
    const target = resolveAgentConnectedAccountPurposeDefaults(input)[0]?.target;
    expect(target).toEqual(expected);
    if (!target || target.kind !== 'account') throw new Error('Expected admitted account default');
    expect(Reflect.set(target.account, 'accountId', 'mutated-through-output')).toBe(false);
    expect(Reflect.set(target.account.service, 'localId', 'mutated-service')).toBe(false);
    expect(resolveAgentConnectedAccountPurposeDefaults(input)[0]?.target).toEqual(expected);
    expect(purposeBindings.bindings[0]!.target).toEqual(expected);
  });

  it('never reads either predecessor carrier as an Agent default, even while the catalog is unavailable', () => {
    const consumer = { pluginId: 'happier.agent.antigravity', localId: 'antigravity' };
    const service = { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' };
    const declarations = [{ purpose: 'model_upstream', service }];
    const settings = {
      connectedServicesDefaultAuthByAgentIdV1: RELEASED_0_2_DEFAULT_AUTH,
      connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {
        agy: { v: 1, bindingsByServiceId: { antigravity: { source: 'connected', selection: 'profile', profileId: 'retired-default' } } },
      } },
    };
    const readers = [
      { settings, agentId: 'codex', consumer: codex, declarations: codexDeclarations },
      { settings, agentId: 'antigravity', consumer, declarations },
    ];
    expect(readers.map(input => resolveAgentConnectedAccountPurposeDefaults(input)[0]?.target)).toEqual([null, null]);
    const purposeBindings = QualifiedConnectedAccountPurposeBindingsV1RecordSchema.parse({ v: 1, bindings: [] });
    expect(readers.map(input => resolveAgentConnectedAccountPurposeDefaults({ ...input, purposeBindings })[0]?.target)).toEqual([null, null]);
    expect(settings.connectedServicesDefaultAuthByAgentIdV1.bindingsByAgentId.codex).toBeDefined();
    expect(settings.connectedServicesAdditionalDefaultAuthByAgentIdV1.bindingsByAgentId.agy).toBeDefined();
  });

  it('refuses malformed additional default intent instead of recovering to native', () => {
    expect(migrateLegacyAgentConnectedAccountPurposeDefaultsForActivation({ agents: releasedAgents,
      purposeBindings: { v: 1, bindings: [] }, settings: {
      connectedServicesAdditionalDefaultAuthByAgentIdV1: {
        v: 1,
        bindingsByAgentId: {
          antigravity: { v: 1, bindingsByServiceId: {
            'happier.agent.antigravity/antigravity-account': { source: 'connected', selection: 'profile' },
          } },
        },
      },
      } })).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
  });

  it.each(['profile', 'group'] as const)('migrates the disjoint 0.2 additional %s default during activation and clears it from the ready catalog', (selection) => {
    const consumer = { pluginId: 'happier.agent.antigravity', localId: 'antigravity' };
    const service = { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' };
    const declarations = [{ purpose: 'model_upstream', service }];
    const target = selection === 'profile'
      ? { kind: 'account' as const, account: { service, accountId: 'google-work' } }
      : { kind: 'group' as const, service, groupId: 'google-pool' };
    const additional = { v: 1, bindingsByAgentId: {
      agy: { v: 1, bindingsByServiceId: { antigravity: selection === 'profile'
        ? { source: 'connected', selection, profileId: 'google-work' }
        : { source: 'connected', selection, groupId: 'google-pool' } } },
    } };
    const settings = ({
      connectedServicesDefaultAuthByAgentIdV1: RELEASED_0_2_DEFAULT_AUTH,
      connectedServicesAdditionalDefaultAuthByAgentIdV1: additional,
    });
    const purposeBindings = activate(settings, [...releasedAgents,
      { agentId: 'antigravity', identity: consumer, connectedAccounts: declarations },
    ]);
    const input = { purposeBindings, consumer, declarations };
    expect(resolveAgentConnectedAccountPurposeDefaults(input)[0]?.target).toEqual(target);
    const { connectedAccountPurposeBindingsV1: edited } = writeAgentConnectedAccountPurposeDefault({
      consumer, purposeBindings, purpose: 'model_upstream', target: null,
    });
    expect(resolveAgentConnectedAccountPurposeDefaults({ ...input, purposeBindings: edited })[0]?.target).toBeNull();
    expect(resolveAgentConnectedAccountPurposeDefaults({ purposeBindings: edited, consumer: codex, declarations: codexDeclarations })[0]?.target)
      .toEqual({ kind: 'group', service: codexService, groupId: 'codex-main' });
  });

  it.each(['group', 'account'] as const)('removes only a successfully deleted %s target from the ready catalog', (kind) => {
    const target = kind === 'group'
      ? { kind, service: codexService, groupId: 'codex-main' }
      : { kind, account: { service: codexService, accountId: 'work' } };
    const otherTarget = { kind: 'group' as const, service: claudeService, groupId: 'codex-main' };
    const purposeBindings = QualifiedConnectedAccountPurposeBindingsV1RecordSchema.parse({
        v: 1,
        bindings: [
          { purpose: { consumer: codex, purpose: 'model-openai' }, target },
          // An unloaded/custom Agent's persisted purpose is cleaned too.
          { purpose: { consumer: { pluginId: 'custom.agent', localId: 'custom' }, purpose: 'model' }, target },
          { purpose: { consumer: claude, purpose: 'model-anthropic' }, target: otherTarget },
          { purpose: { consumer: codex, purpose: 'other' }, target: { kind: 'account', account: { service: codexService, accountId: 'other' } } },
        ],
        teamResourceSelections: [{ purpose: { consumer: codex, purpose: 'team' }, teamId: 'team-a',
          selection: { source: 'team_resource', resourceId: 'resource-a', deliveryMode: 'brokered' } }],
      });
    const written = removeAgentConnectedAccountDefaultsForDeletedTarget({ purposeBindings, target })!;
    expect(written).not.toBeNull();
    expect(written.connectedAccountPurposeBindingsV1.bindings).toEqual(purposeBindings.bindings.slice(2));
    expect(written.connectedAccountPurposeBindingsV1.teamResourceSelections).toEqual(purposeBindings.teamResourceSelections);
    const defaults = resolveAgentConnectedAccountPurposeDefaults({ purposeBindings: written.connectedAccountPurposeBindingsV1, consumer: codex, declarations: codexDeclarations });
    expect(defaults[0]?.target).toBeNull();
    expect(projectAgentConnectedAccountPurposeDefaultsToSessionBindings(defaults)).toBeNull();
    expect(removeAgentConnectedAccountDefaultsForDeletedTarget({ purposeBindings: written.connectedAccountPurposeBindingsV1, target })).toBeNull();
  });

  it('keeps an explicit unavailable default until that exact target is deleted', () => {
    const settings = ({ connectedServicesDefaultAuthByAgentIdV1: RELEASED_0_2_DEFAULT_AUTH });
    const purposeBindings = activate(settings);
    expect(removeAgentConnectedAccountDefaultsForDeletedTarget({ purposeBindings, target: { kind: 'group', service: codexService, groupId: 'other-pool' } })).toBeNull();
    expect(resolveAgentConnectedAccountPurposeDefaults({ purposeBindings, consumer: codex, declarations: codexDeclarations })[0]?.target)
      .toEqual({ kind: 'group', service: codexService, groupId: 'codex-main' });
  });

  it('retains another service default of the same Agent, including a Team resource', () => {
    const team = EARLIER_0_3_TEAM_DEFAULT.bindingsByAgentId.codex.bindingsByServiceId['happier.agent.codex/openai-codex'];
    const settings = ({ connectedServicesDefaultAuthByAgentIdV1: {
      v: 1, bindingsByAgentId: {
        custom: { v: 2, bindingsByServiceId: {
          'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'group', groupId: 'work' },
          'happier.agent.codex/openai-codex': team,
        } },
      },
    } });
    const purposeBindings = activate(settings, [{ agentId: 'custom', identity: codex,
      connectedAccounts: [...codexDeclarations, ...claudeDeclarations] }]);
    const written = removeAgentConnectedAccountDefaultsForDeletedTarget({
      purposeBindings, target: { kind: 'group', service: claudeService, groupId: 'work' },
    });
    expect(written?.connectedAccountPurposeBindingsV1).toEqual({
      v: 1, bindings: [], teamResourceSelections: purposeBindings.teamResourceSelections,
    });
    expect(purposeBindings.teamResourceSelections).toHaveLength(1);
  });

  it('reads a released 0.2 service-keyed default as the purpose target it always meant', () => {
    const settings = ({ connectedServicesDefaultAuthByAgentIdV1: RELEASED_0_2_DEFAULT_AUTH });

    expect(resolveAgentConnectedAccountPurposeDefaults({
      purposeBindings: activate(settings), consumer: codex, declarations: codexDeclarations,
    })).toEqual([{
      purpose: { consumer: codex, purpose: 'model-openai' },
      service: codexService,
      target: { kind: 'group', service: codexService, groupId: 'codex-main' },
      teamResource: null,
    }]);
    expect(resolveAgentConnectedAccountPurposeDefaults({
      purposeBindings: activate(settings), consumer: claude, declarations: claudeDeclarations,
    })[0]?.target).toEqual({ kind: 'account', account: { service: claudeService, accountId: 'work' } });
  });

  it('reads an earlier 0.3 service-keyed Team default as the canonical Team selection of its Team', () => {
    const settings = ({ connectedServicesDefaultAuthByAgentIdV1: EARLIER_0_3_TEAM_DEFAULT });

    const [entry] = resolveAgentConnectedAccountPurposeDefaults({
      purposeBindings: activate(settings), consumer: codex, declarations: codexDeclarations,
    });
    expect(entry?.target).toBeNull();
    expect(entry?.teamResource).toEqual({
      teamId: 'team-acme',
      selection: { source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'brokered' },
    });
  });

  it('reads an earlier 0.3 Team purpose target forward and leaves the stored value untouched', () => {
    const stored = JSON.parse(JSON.stringify(EARLIER_0_3_TEAM_PURPOSE_TARGET));
    const purposeBindings = QualifiedConnectedAccountPurposeBindingsV1Schema.parse(stored);

    const [entry] = resolveAgentConnectedAccountPurposeDefaults({
      purposeBindings, consumer: codex, declarations: codexDeclarations,
    });
    expect(entry?.target).toBeNull();
    expect(entry?.teamResource).toEqual({
      teamId: 'team-acme',
      selection: EARLIER_0_3_TEAM_PURPOSE_TARGET.bindings[0].target.selection,
    });
    expect(stored).toEqual(EARLIER_0_3_TEAM_PURPOSE_TARGET);
  });

  it('persists a Team default as the canonical Team selection, never a widened purpose target', () => {
    const teamResource = {
      teamId: 'team-acme',
      selection: {
        source: 'team_resource',
        resourceId: 'resource-2',
        deliveryMode: 'direct',
        disclosedMember: { service: codexService, accountId: 'member-1' },
      },
    } as const;
    const settings = ({ connectedServicesDefaultAuthByAgentIdV1: {
      v: 1, bindingsByAgentId: { codex: RELEASED_0_2_DEFAULT_AUTH.bindingsByAgentId.codex },
    } });
    const written = writeAgentConnectedAccountPurposeDefault({
      purposeBindings: activate(settings), consumer: codex,
      purpose: 'model-openai', target: null, teamResource,
    });
    expect(written.connectedAccountPurposeBindingsV1).toEqual({
      v: 1,
      bindings: [],
      teamResourceSelections: [{ purpose: { consumer: codex, purpose: 'model-openai' }, ...teamResource }],
    });

    expect(resolveAgentConnectedAccountPurposeDefaults({
      purposeBindings: written.connectedAccountPurposeBindingsV1, consumer: codex, declarations: codexDeclarations,
    })[0]).toMatchObject({ target: null, teamResource });
    expect(resolveAgentConnectedAccountPurposeDefaults({ consumer: codex,
      purposeBindings: admitAgentConnectedAccountPurposeBindings(written.connectedAccountPurposeBindingsV1),
      declarations: admitAgentConnectedAccountPurposeDeclarations(codex, codexDeclarations),
    })[0]).toMatchObject({ target: null, teamResource });

    // A personal choice replaces the Team default: one purpose, one default.
    const personal = writeAgentConnectedAccountPurposeDefault({
        purposeBindings: written.connectedAccountPurposeBindingsV1, consumer: codex,
        purpose: 'model-openai', target: { kind: 'group', service: codexService, groupId: 'codex-main' },
    });
    expect(personal.connectedAccountPurposeBindingsV1.teamResourceSelections ?? []).toEqual([]);
    expect(resolveAgentConnectedAccountPurposeDefaults({
      purposeBindings: personal.connectedAccountPurposeBindingsV1, consumer: codex, declarations: codexDeclarations,
    })[0]).toMatchObject({ target: { kind: 'group', groupId: 'codex-main' }, teamResource: null });

    // Clearing the purpose makes the Agent use native sign-in.
    const cleared = writeAgentConnectedAccountPurposeDefault({
        purposeBindings: personal.connectedAccountPurposeBindingsV1, consumer: codex,
        purpose: 'model-openai', target: null,
    });
    expect(resolveAgentConnectedAccountPurposeDefaults({
      purposeBindings: cleared.connectedAccountPurposeBindingsV1, consumer: codex, declarations: codexDeclarations,
    })[0]).toMatchObject({ target: null, teamResource: null });
  });

  it('writes a service-keyed selection as the purpose default of that service, and a Team one only with its Team', () => {
    const settings = ({ connectedServicesDefaultAuthByAgentIdV1: {
      v: 1, bindingsByAgentId: { codex: RELEASED_0_2_DEFAULT_AUTH.bindingsByAgentId.codex },
    } });
    const selection = { source: 'team_resource', resourceId: 'resource-3', deliveryMode: 'brokered' } as const;
    expect(writeAgentConnectedServiceDefault({
      purposeBindings: activate(settings), consumer: codex, declarations: codexDeclarations,
      serviceKey: 'happier.agent.codex/openai-codex', selection,
    })).toBeNull();

    const written = writeAgentConnectedServiceDefault({
      purposeBindings: activate(settings), consumer: codex, declarations: codexDeclarations,
      serviceKey: 'happier.agent.codex/openai-codex', selection, teamId: 'team-acme',
    })!;
    expect(resolveAgentConnectedAccountPurposeDefaults({
      purposeBindings: written.connectedAccountPurposeBindingsV1, consumer: codex, declarations: codexDeclarations,
    })[0]?.teamResource).toEqual({ teamId: 'team-acme', selection });

    const native = writeAgentConnectedServiceDefault({
        purposeBindings: written.connectedAccountPurposeBindingsV1, consumer: codex, declarations: codexDeclarations,
        serviceKey: 'happier.agent.codex/openai-codex', selection: { source: 'native' },
    })!;
    expect(native.connectedAccountPurposeBindingsV1.bindings).toEqual([]);
    expect(native.connectedAccountPurposeBindingsV1.teamResourceSelections ?? []).toEqual([]);
  });

  it('projects purpose defaults onto the Session service-keyed launch selection', () => {
    const settings = ({ connectedServicesDefaultAuthByAgentIdV1: EARLIER_0_3_TEAM_DEFAULT });
    expect(projectAgentConnectedAccountPurposeDefaultsToSessionBindings(
      resolveAgentConnectedAccountPurposeDefaults({
        purposeBindings: activate(settings), consumer: codex, declarations: codexDeclarations,
      }),
    )).toEqual({
      v: 2,
      bindingsByServiceId: {
        'happier.agent.codex/openai-codex': {
          source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'brokered',
        },
      },
    });
    expect(projectAgentConnectedAccountPurposeDefaultsToSessionBindings([])).toBeNull();
  });
});
