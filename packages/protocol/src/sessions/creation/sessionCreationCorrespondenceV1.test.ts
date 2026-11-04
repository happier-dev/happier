import { describe, expect, it } from 'vitest';

import { deriveSessionCreationTagV1 } from './sessionCreationIdentityV1.js';
import {
  normalizeSessionCreationOrganizationPlacementV1,
  SessionCreationCorrespondenceV1ReadSchema,
  SessionCreationCorrespondenceV1Schema,
  sessionCreationCorrespondenceMatchesV1,
} from './sessionCreationCorrespondenceV1.js';
import { openSessionOwnerMetadataEnvelopeV1 } from '../metadata/sessionMetadataEnvelopesV1.js';
import { sealAccountScopedBlobCiphertext } from '../../crypto/accountScopedCipher.js';

const correspondence = {
  v: 1,
  sessionCreationTag: deriveSessionCreationTagV1({
    callerCreationNamespace: 'user',
    creationKey: 'manual:attempt-1',
  }),
  recipe: {
    execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/workspace/project' } },
    organization: { folderId: null, tagIds: ['tag-a', 'tag-b'] },
    agentTarget: {
      kind: 'agent',
      identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
    },
    modelSelection: null,
    profileId: null,
    requestedPermissionMode: null,
    agentModeId: null,
    configuration: null,
    connectedServices: null,
    capabilitySelection: null,
    transcriptStorage: null,
    terminal: null,
    agentSessionStartupInstructionsMarkerV1: null,
    checkout: null,
  },
} as const;

// Retained recipe shape from c080ffae7a^ (string path) and d21562d62d^
// (MCP carrier), reproduced in QA owner rows cmujud4k30009tm6wvv9dkcf8
// and cmv4fpftk004mm2sarz6k3i12. Values are non-sensitive test fixtures.
const retainedCorrespondence = {
  v: 1,
  sessionCreationTag: correspondence.sessionCreationTag,
  recipe: {
    execution: { machineId: 'machine-1', directory: '/workspace/project' },
    organization: { folderId: null, tagIds: ['tag-a', 'tag-b'] },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    modelSelection: null,
    profileId: null,
    requestedPermissionMode: null,
    agentModeId: null,
    configuration: null,
    connectedServices: null,
    mcpSelection: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['selected-server'], forceExcludeServerIds: [] },
    transcriptStorage: null,
    terminal: null,
    agentSessionStartupInstructionsMarkerV1: null,
    checkout: null,
  },
} as const;

describe('SessionCreationCorrespondenceV1', () => {
  it('retains actual checkout branch evidence without treating an observation as retry intent', () => {
    const checkout = { kind: 'git_worktree' as const, finalDirectory: '/checkout', baseRef: 'main', branchMode: 'new' as const };
    const observed = { ...correspondence, recipe: { ...correspondence.recipe, checkout: { ...checkout, branchName: 'feature/actual' } } };
    expect(SessionCreationCorrespondenceV1Schema.parse(observed)).toEqual(observed);
    expect(sessionCreationCorrespondenceMatchesV1(observed, { ...observed, recipe: { ...observed.recipe,
      checkout: { ...checkout, branchName: null } } })).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(observed, { ...observed, recipe: { ...observed.recipe, checkout } })).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(observed, { ...observed, recipe: { ...observed.recipe,
      checkout: { ...checkout, baseRef: 'different' } } })).toBe(false);
  });
  it('retains Discussion slot ownership and the entire ordinary recipe in retry meaning', () => {
    const discussionParticipant = { discussionId: 'discussion-1', participantSlotId: 'slot-1' };
    const selected = { ...correspondence, recipe: { ...correspondence.recipe, discussionParticipant } };
    expect(SessionCreationCorrespondenceV1Schema.parse(selected)).toEqual(selected);
    expect(sessionCreationCorrespondenceMatchesV1(selected, correspondence)).toBe(false);
    for (const recipe of [
      { ...selected.recipe, discussionParticipant: { ...discussionParticipant, participantSlotId: 'slot-2' } },
      { ...selected.recipe, execution: { ...selected.recipe.execution, machineId: 'different-machine' } },
      { ...selected.recipe, requestedPermissionMode: 'read-only' },
    ]) expect(sessionCreationCorrespondenceMatchesV1(selected, { ...selected, recipe })).toBe(false);
    const seeded = { ...selected, recipe: { ...selected.recipe, capabilitySelection: { skills: {
      v: 1, forceIncludeSkillIds: ['profile-skill'], forceExcludeSkillIds: [], excludeNativeSkillNames: [],
    } } } };
    expect(SessionCreationCorrespondenceV1Schema.parse(seeded)).toEqual(seeded);
    expect(sessionCreationCorrespondenceMatchesV1(seeded, { ...seeded, recipe: { ...seeded.recipe,
      capabilitySelection: { skills: { ...seeded.recipe.capabilitySelection.skills, forceIncludeSkillIds: ['changed-profile-skill'] } },
    } })).toBe(false);
  });
  it.each(['string', 'intent'] as const)('opens retained %s-directory creation provenance through the owner envelope without weakening current writes', directoryKind => {
    const retained = { ...retainedCorrespondence, recipe: { ...retainedCorrespondence.recipe,
      execution: { ...retainedCorrespondence.recipe.execution,
        directory: directoryKind === 'string' ? '/workspace/project' : { kind: 'path', path: '/workspace/project' } },
    } };
    const expected = { ...correspondence, recipe: { ...correspondence.recipe,
      capabilitySelection: { mcp: retainedCorrespondence.recipe.mcpSelection },
    } };
    expect(SessionCreationCorrespondenceV1Schema.safeParse(retained).success).toBe(false);
    const material = { type: 'dataKey', machineKey: new Uint8Array(32).fill(13) } as const;
    const ownerMetadata = { v: 1, system: { sessionCreationCorrespondenceV1: retained } };
    for (const accountMode of ['plain', 'e2ee'] as const) {
      const envelope = accountMode === 'plain' ? { t: 'plain', v: ownerMetadata } : { t: 'encrypted',
        c: sealAccountScopedBlobCiphertext({ kind: 'session_owner_metadata', material, payload: ownerMetadata,
          randomBytes: length => new Uint8Array(length).fill(7) }) };
      expect(openSessionOwnerMetadataEnvelopeV1({ accountMode, envelope, material: accountMode === 'plain' ? null : material }))
        .toMatchObject({ ok: true, ownerMetadata: { system: { sessionCreationCorrespondenceV1: expected } } });
    }
    expect(SessionCreationCorrespondenceV1ReadSchema.parse(retained)).toEqual(expected);
    expect(sessionCreationCorrespondenceMatchesV1(retained, expected)).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(retained, { ...expected, recipe: { ...expected.recipe,
      capabilitySelection: null,
    } })).toBe(false);
  });

  it('retains null legacy selection while refusing malformed or missing provenance and preserving managed-checkout constraints', () => {
    const retained = { ...retainedCorrespondence, recipe: { ...retainedCorrespondence.recipe, mcpSelection: null } };
    expect(sessionCreationCorrespondenceMatchesV1(retained, correspondence)).toBe(true);
    for (const recipe of [
      { ...retained.recipe, execution: { ...retained.recipe.execution, directory: '' } },
      { ...retained.recipe, mcpSelection: { forceIncludeServerIds: 42 } },
      { ...retained.recipe, mcpSelection: 42 },
      { ...retained.recipe, mcpSelection: undefined },
      { ...retained.recipe, capabilitySelection: { mcp: { forceIncludeServerIds: 42 } } },
      { ...retained.recipe, execution: { machineId: 'machine-1', directory: { kind: 'managed' } },
        checkout: { kind: 'git_worktree', finalDirectory: '/checkout', baseRef: null, branchMode: 'new' } },
    ]) expect(SessionCreationCorrespondenceV1ReadSchema.safeParse({ ...retained, recipe }).success).toBe(false);
  });

  it.each([true, false])('retains exact managed birth resource and optional controller in retry meaning (bound=%s)', bound => {
    const controller = { machineId: 'controller', installationId: 'installation' };
    const managedCreation = { homeId: 'home', managedId: 'managed', ...(bound ? { controller } : {}) };
    const selected = { ...correspondence, recipe: { ...correspondence.recipe, managedCreation } };
    expect(SessionCreationCorrespondenceV1Schema.parse(selected)).toEqual(selected);
    expect(SessionCreationCorrespondenceV1ReadSchema.parse(selected)).toEqual(selected);
    expect(sessionCreationCorrespondenceMatchesV1(selected, selected)).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(selected, correspondence)).toBe(false);
    expect(sessionCreationCorrespondenceMatchesV1(selected, { ...selected, recipe: { ...selected.recipe,
      managedCreation: { ...managedCreation, controller: { ...controller, installationId: 'replacement' } },
    } })).toBe(false);
    expect(SessionCreationCorrespondenceV1Schema.safeParse({ ...selected, recipe: { ...selected.recipe,
      managedCreation: { ...managedCreation, controller: { machineId: controller.machineId } },
    } }).success).toBe(false);
    expect(SessionCreationCorrespondenceV1Schema.safeParse({ ...selected, recipe: { ...selected.recipe,
      managedCreation: { ...managedCreation, sessionId: 'caller-selected-source' },
    } }).success).toBe(false);
  });
  it('binds selected qualified Instructions in the same creation retry meaning', () => {
    const promptStack = [{ id: 'session.instructions',
      ref: { kind: 'doc', serverId: 'instructions-home', artifactId: 'instructions' },
      enabled: true, required: true, placement: 'system_append' }];
    const selected = { ...correspondence, recipe: { ...correspondence.recipe, promptStack } };
    expect(SessionCreationCorrespondenceV1Schema.parse(selected)).toEqual(selected);
    expect(sessionCreationCorrespondenceMatchesV1(selected, selected)).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(selected, correspondence)).toBe(false);
    expect(sessionCreationCorrespondenceMatchesV1(selected, { ...selected, recipe: {
      ...selected.recipe, promptStack: [{ ...promptStack[0],
        ref: { ...promptStack[0]!.ref, serverId: 'different-home' } }],
    } })).toBe(false);
  });

  it('keeps admitted Bot birth and explicit memory choices in retry meaning after the live marker changes', () => {
    const bot = { ...correspondence, recipe: { ...correspondence.recipe,
      identity: { bot: { kind: 'bot' }, createdAsBot: true }, memoryEnabled: false,
    } };
    expect(SessionCreationCorrespondenceV1Schema.parse(bot)).toEqual(bot);
    expect(sessionCreationCorrespondenceMatchesV1(bot, bot)).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(bot, correspondence)).toBe(false);
    expect(sessionCreationCorrespondenceMatchesV1(bot, { ...bot, recipe: { ...bot.recipe, memoryEnabled: true } })).toBe(false);
  });
  it('matches managed retries by intent and rejects a managed versus path correspondence', () => {
    const managed = { ...correspondence, recipe: { ...correspondence.recipe,
      execution: { ...correspondence.recipe.execution, directory: { kind: 'managed' } },
    } };
    expect(sessionCreationCorrespondenceMatchesV1(managed, managed)).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(managed, correspondence)).toBe(false);
    expect(SessionCreationCorrespondenceV1Schema.safeParse({ ...managed, recipe: {
      ...managed.recipe,
      checkout: { kind: 'git_worktree', finalDirectory: '/checkout', baseRef: null, branchMode: 'new' },
    } }).success).toBe(false);
  });
  it('strictly validates one bounded immutable recipe', () => {
    expect(SessionCreationCorrespondenceV1Schema.parse(correspondence)).toEqual(correspondence);
    expect(SessionCreationCorrespondenceV1Schema.safeParse({
      ...correspondence,
      title: 'mutable presentation is excluded',
    }).success).toBe(false);
  });

  it('normalizes placement tag order before correspondence', () => {
    expect(normalizeSessionCreationOrganizationPlacementV1({
      folderId: null,
      tagIds: ['tag-b', 'tag-a'],
    })).toEqual({ folderId: null, tagIds: ['tag-a', 'tag-b'] });
  });

  it('detects a semantic mismatch without hashing the recipe', () => {
    expect(sessionCreationCorrespondenceMatchesV1(correspondence, correspondence)).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(correspondence, {
      ...correspondence,
      recipe: {
        ...correspondence.recipe,
        execution: { ...correspondence.recipe.execution, machineId: 'machine-2' },
      },
    })).toBe(false);
  });

  it('compares known retained correspondence fields without admitting unknown request fields', () => {
    const retained = {
      ...correspondence,
      futureField: true,
      recipe: { ...correspondence.recipe, execution: {
        ...correspondence.recipe.execution,
        directory: { ...correspondence.recipe.execution.directory, futureField: true },
      } },
    };
    expect(SessionCreationCorrespondenceV1Schema.safeParse(retained).success).toBe(false);
    expect(sessionCreationCorrespondenceMatchesV1(retained, correspondence)).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(retained, {
      ...correspondence,
      recipe: { ...correspondence.recipe, execution: {
        ...correspondence.recipe.execution, directory: { kind: 'managed' },
      } },
    })).toBe(false);
  });

  it('ignores selection ordering times while retaining semantic model, provider and configuration differences', () => {
    const selected = {
      ...correspondence,
      recipe: {
        ...correspondence.recipe,
        modelSelection: {
          v: 1,
          ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'model-a' },
          updatedAt: 1,
        },
      },
    };
    const retried = {
      ...selected,
      recipe: { ...selected.recipe, modelSelection: { ...selected.recipe.modelSelection, updatedAt: 2 } },
    };
    expect(SessionCreationCorrespondenceV1Schema.safeParse(selected).success).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(selected, retried)).toBe(true);
    for (const ref of [
      { ...selected.recipe.modelSelection.ref, modelId: 'model-b' },
      { ...selected.recipe.modelSelection.ref, providerConnectionId: 'pc_other' },
      { ...selected.recipe.modelSelection.ref, agentTargetKey: 'agent:happier.agent.claude/claude' },
    ]) {
      expect(sessionCreationCorrespondenceMatchesV1(selected, {
        ...retried,
        recipe: { ...retried.recipe, modelSelection: { ...retried.recipe.modelSelection, ref } },
      })).toBe(false);
    }
    expect(sessionCreationCorrespondenceMatchesV1(selected, {
      ...retried,
      recipe: { ...retried.recipe, profileId: 'profile-other' },
    })).toBe(false);
    const configuration = {
      mode: { value: null, updatedAtMs: 1 },
      model: { value: null, updatedAtMs: 1 },
      permissionIntent: { value: null, updatedAtMs: 1 },
      options: { reasoning: { value: 'medium', updatedAtMs: 1 } },
    };
    const configured = { ...selected, recipe: { ...selected.recipe, configuration } };
    expect(SessionCreationCorrespondenceV1Schema.safeParse(configured).success).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(configured, {
      ...retried,
      recipe: { ...retried.recipe, configuration: {
        mode: { value: null, updatedAtMs: 2 },
        model: { value: null, updatedAtMs: 2 },
        permissionIntent: { value: null, updatedAtMs: 2 },
        options: { reasoning: { value: 'medium', updatedAtMs: 2 } },
      } },
    })).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(configured, {
      ...retried,
      recipe: {
        ...retried.recipe,
        configuration: { ...configuration, options: { reasoning: { value: 'high', updatedAtMs: 1 } } },
      },
    })).toBe(false);
  });
});
