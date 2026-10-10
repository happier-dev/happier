import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  getActionSpec,
  PLUGIN_ACTION_INPUT_SCHEMAS,
  PLUGIN_ACTION_OUTPUT_SCHEMAS,
  PUBLIC_ACTION_INPUT_SCHEMAS,
  PUBLIC_ACTION_OUTPUT_SCHEMAS,
  PublicActionIdSchema,
  SignedRootActionIdSchema,
  type PluginActionInputById,
  type PluginActionResultById,
  type PublicActionId,
  type PublicActionInputById,
  type PublicActionResultById,
} from './actionSpecs.js';

describe('Action public projection', () => {
  it('admits private recap export as client rendering with the same strict compose input', () => {
    expect(PublicActionIdSchema.safeParse('usage.recap.export').success).toBe(true);
    const spec = getActionSpec('usage.recap.export');
    expect(spec.executionPlacement).toBe('client');
    expect(spec.pluginCallerPolicy).toEqual({ kind: 'caller' });
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true, plugin: true });
    expect(spec.inputSchema.safeParse({ query: { period: { startMs: 100, endMs: 200 } }, selectedFields: ['tokens'] }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ query: { accountId: 'forged' }, node: {} }).success).toBe(false);
    const compose = { kind: 'composed', v: 1, style: 'sigil', format: 'story', selectedFields: ['tokens'], unavailableFields: [],
      period: { startMs: 100, endMs: 200, timeZoneOffsetMinutes: 0 }, asOfMs: 200,
      coverage: { accounting: null, sourceCoverage: [], sourceStatuses: [], pending: false },
      facts: { tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 } } };
    const output = { kind: 'exported', compose, file: { v: 1, mediaType: 'image/png', fileName: 'happier-usage-sigil-story-19700101.png',
      base64: 'iVBORw==', selectedFields: ['tokens'], asOfMs: 200 } };
    expect(spec.outputSchema?.safeParse(output).success).toBe(true);
    for (const file of [{ ...output.file, accountId: 'forged' }, { ...output.file, base64: 'file:///tmp/capture.png' },
      { ...output.file, selectedFields: ['dollars'] }, { ...output.file, asOfMs: 201 }, { ...output.file, fileName: '../capture.png' }]) {
      expect(spec.outputSchema?.safeParse({ ...output, file }).success).toBe(false);
    }
  });
  it('admits private recap composition through the same authenticated plugin caller policy', () => {
    const spec = getActionSpec('usage.recap.compose');
    expect(PublicActionIdSchema.safeParse('usage.recap.compose').success).toBe(true);
    expect(spec.pluginCallerPolicy).toEqual({ kind: 'caller' });
    expect(spec.surfaces.plugin).toBe(true);
    expect(spec.inputSchema.safeParse({ query: { period: { startMs: 100, endMs: 200 } }, selectedFields: ['tokens'] }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ query: { accountId: 'forged' } }).success).toBe(false);
  });
  it('admits the same strict personal Usage query on public and plugin surfaces', () => {
    expect(PublicActionIdSchema.safeParse('usage.query').success).toBe(true);
    const spec = getActionSpec('usage.query' as PublicActionId);
    expect(spec.safety).toBe('safe');
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true, plugin: true });
    expect(spec.pluginCallerPolicy).toEqual({ kind: 'caller' });
    expect(spec.inputSchema.safeParse({ queries: [{ period: { startMs: 100, endMs: 200 }, metric: 'tokens' }] }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ queries: [{ accountId: 'forged' }] }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ queries: [{ period: { startMs: 100, endMs: 200 }, sources: ['native'], unknownFilter: true }] }).success).toBe(false);
  });
  it('exposes Session memory and context edits with a strict reviewed metadata basis', () => {
    for (const id of ['session.memory.set', 'session.context.update', 'session.instructions.set'] as const) {
      const spec = getActionSpec(id);
      expect(PublicActionIdSchema.safeParse(id).success).toBe(true);
      for (const surface of ['ui', 'agent', 'mcp', 'voice', 'cli'] as const) expect(spec.surfaces[surface]).toBe(true);
      const input = { sessionId: 'session', serverId: 'home', expectedMetadataRevision: 3,
        ...(id === 'session.memory.set' ? { enabled: false }
          : id === 'session.instructions.set' ? { ref: null }
          : { intent: { kind: 'inherited_enable', entryId: 'account.context', enabled: false } }) };
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      const { expectedMetadataRevision: _basis, ...withoutBasis } = input;
      expect(spec.inputSchema.safeParse(withoutBasis).success).toBe(false);
      expect(spec.inputSchema.safeParse({ ...input, accountId: 'forged' }).success).toBe(false);
    }
  });
  it('exposes personal Project context on every eligible surface with strict entry intents', () => {
    const id = 'projects.context.update' as PublicActionId;
    expect(PublicActionIdSchema.safeParse(id).success).toBe(true);
    const spec = getActionSpec(id);
    expect(spec.safety).toBe('safe');
    for (const surface of ['ui', 'agent', 'mcp', 'voice', 'cli'] as const) {
      expect(spec.surfaces[surface]).toBe(true);
    }
    const input = { target: { serverId: 'home', projectKey: 'project' }, expectedRevision: 'absent',
      intent: { kind: 'attach', entry: { id: 'instructions', ref: { kind: 'doc', artifactId: 'doc' }, placement: 'system_append' } } };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, accountId: 'other' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, intent: { ...input.intent, entry: { ...input.intent.entry, placement: 'provider_asset' } } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, intent: { ...input.intent, entry: { ...input.intent.entry, ref: { ...input.intent.entry.ref, credential: 'secret' } } } }).success).toBe(false);
  });
  it('keeps Artifact and Team automation rows in the public type and runtime projections', () => {
    const publicIds = [
      'artifact.access.grants.list',
      'artifact.access.grants.set',
      'artifact.access.grants.remove',
      'teams.directory.groups.list',
      'teams.directory.people.list',
      'teams.directory.sourceSetup.list',
      'teams.directory.sources.get',
      'teams.directory.sources.list',
      'teams.directory.sources.remove',
      'teams.directory.sources.remove.preview',
      'teams.externalGroupBindings.list',
      'teams.externalGroupBindings.remove',
      'teams.externalGroupBindings.set',
      'teams.identity.connections.list',
      'teams.identity.connections.remove.preview',
      'teams.identity.connections.test.consume',
      'teams.identity.connections.test.start',
      'teams.identity.workos.adminPortalLink.create',
    ] as const satisfies readonly PublicActionId[];
    type PublicFamilyId = typeof publicIds[number];
    expectTypeOf<Pick<PublicActionInputById, PublicFamilyId>>()
      .toEqualTypeOf<Pick<PluginActionInputById, PublicFamilyId>>();
    expectTypeOf<Pick<PublicActionResultById, PublicFamilyId>>()
      .toEqualTypeOf<Pick<PluginActionResultById, PublicFamilyId>>();
    for (const id of publicIds) {
      expect(getActionSpec(id).requiredAuthority).toBe('account_automation');
      expect(PublicActionIdSchema.safeParse(id).success).toBe(true);
      expect(PUBLIC_ACTION_INPUT_SCHEMAS[id]).toBe(PLUGIN_ACTION_INPUT_SCHEMAS[id]);
      expect(PUBLIC_ACTION_OUTPUT_SCHEMAS[id]).toBe(PLUGIN_ACTION_OUTPUT_SCHEMAS[id]);
    }

    const presentUserIds = [
      'teams.directory.sources.create',
      'teams.directory.sources.sync',
      'teams.identity.connections.create',
      'teams.identity.connections.remove',
    ] as const;
    expectTypeOf<Extract<PublicActionId, typeof presentUserIds[number]>>().toEqualTypeOf<never>();
    for (const id of presentUserIds) {
      expect(getActionSpec(id).requiredAuthority).toBe('present_user');
      expect(PublicActionIdSchema.safeParse(id).success).toBe(false);
      expect(SignedRootActionIdSchema.safeParse(id).success).toBe(true);
    }
  });
});
