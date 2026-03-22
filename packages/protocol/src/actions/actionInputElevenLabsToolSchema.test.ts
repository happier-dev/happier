import { describe, expect, it } from 'vitest';

import { actionSpecToElevenLabsClientToolParameters } from './actionInputElevenLabsToolSchema.js';
import { getActionSpec } from './actionSpecs.js';

function hasKeyDeep(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, key));
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, key)) return true;
  return Object.values(record).some((v) => hasKeyDeep(v, key));
}

describe('actionInputElevenLabsToolSchema', () => {
  it('produces an ElevenLabs-compatible parameters schema for review.start', () => {
    const spec = getActionSpec('review.start');

    const schema = actionSpecToElevenLabsClientToolParameters(spec);

    expect(schema).toMatchObject({
      type: 'object',
      properties: expect.any(Object),
    });

    // ElevenLabs client tool parameters do not accept JSON-schema `additionalProperties` or unions like `oneOf`.
    expect(hasKeyDeep(schema, 'additionalProperties')).toBe(false);
    expect(hasKeyDeep(schema, 'oneOf')).toBe(false);
    expect(hasKeyDeep(schema, 'anyOf')).toBe(false);
    expect(hasKeyDeep(schema, 'allOf')).toBe(false);

    // Leaf parameter schemas must include descriptions (ElevenLabs validates this).
    const sessionId = (schema as any).properties?.sessionId;
    expect(sessionId).toMatchObject({ type: 'string' });
    expect(typeof sessionId.description).toBe('string');

    const engineIds = (schema as any).properties?.engineIds;
    expect(engineIds).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(typeof engineIds.description).toBe('string');
    expect(typeof engineIds.items?.description).toBe('string');

    const base = (schema as any).properties?.base;
    expect(base?.type).toBe('object');
    expect(base?.properties?.kind).toMatchObject({ type: 'string' });
    expect(base?.properties?.kind?.enum).toEqual(expect.arrayContaining(['none', 'branch', 'commit']));
  });

  it('produces an ElevenLabs-compatible parameters schema for session.user_action.answer', () => {
    const spec = getActionSpec('session.user_action.answer');

    const schema = actionSpecToElevenLabsClientToolParameters(spec);

    expect(schema).toMatchObject({
      type: 'object',
      properties: expect.any(Object),
    });
    expect(hasKeyDeep(schema, 'additionalProperties')).toBe(false);
    expect(hasKeyDeep(schema, 'oneOf')).toBe(false);
    expect(hasKeyDeep(schema, 'anyOf')).toBe(false);
    expect(hasKeyDeep(schema, 'allOf')).toBe(false);

    const answers = (schema as any).properties?.answers;
    expect(answers).toMatchObject({ type: 'array', items: { type: 'object' } });
    expect(typeof answers.description).toBe('string');
    expect(typeof answers.items?.description).toBe('string');
    expect(typeof answers.items?.properties?.question?.description).toBe('string');
    expect(typeof answers.items?.properties?.answer?.description).toBe('string');
  });

  it('omits guidance for disabled discovery tools from parameter descriptions', () => {
    const spec = getActionSpec('session.spawn_new');

    const schema = actionSpecToElevenLabsClientToolParameters(spec, {
      disabledActionIds: ['machines.list'],
    });

    expect(String((schema as any).properties?.host?.description ?? '')).not.toContain('listMachines');
    expect((schema as any).properties?.workspaceId).toBeUndefined();
  });

  it('omits guidance for discovery tools that are not exposed in the available surface', () => {
    const spec = getActionSpec('session.spawn_new');

    const schema = actionSpecToElevenLabsClientToolParameters(spec, {
      availableActionIds: ['session.spawn_picker', 'agents.backends.list', 'agents.models.list'],
    });

    expect((schema as any).properties?.workspaceId).toBeUndefined();
    expect(String((schema as any).properties?.path?.description ?? '')).not.toContain('listRecentPaths');
    expect(String((schema as any).properties?.path?.description ?? '')).toContain('spawnSessionPicker');
    expect(String((schema as any).properties?.agentId?.description ?? '')).toContain('listAgentBackends');
  });

  it('describes backendTargetKey for configured ACP model discovery', () => {
    const spec = getActionSpec('agents.models.list');

    const schema = actionSpecToElevenLabsClientToolParameters(spec, {
      availableActionIds: ['agents.backends.list', 'agents.models.list'],
    });

    expect(String((schema as any).properties?.backendTargetKey?.description ?? '')).toContain('Required when using customAcp');
    expect(String((schema as any).properties?.backendTargetKey?.description ?? '')).toContain('acpBackend:');
  });

  it('keeps the customAcp backendTargetKey requirement even when backend discovery is unavailable', () => {
    const spec = getActionSpec('agents.models.list');

    const schema = actionSpecToElevenLabsClientToolParameters(spec, {
      availableActionIds: ['agents.models.list'],
    });

    expect(String((schema as any).properties?.backendTargetKey?.description ?? '')).toContain('Required when using customAcp');
    expect(String((schema as any).properties?.backendTargetKey?.description ?? '')).toContain('acpBackend:');
  });

  it('omits discovery guidance when the available action set is explicitly empty', () => {
    const spec = getActionSpec('agents.models.list');

    const schema = actionSpecToElevenLabsClientToolParameters(spec, {
      availableActionIds: [],
    });

    expect(String((schema as any).properties?.backendTargetKey?.description ?? '')).toContain('Required when using customAcp');
    expect(String((schema as any).properties?.backendTargetKey?.description ?? '')).not.toContain('listAgentBackends');
  });

  it('drops non-string enums that ElevenLabs rejects on numeric parameters', () => {
    const spec = getActionSpec('memory.search');

    const schema = actionSpecToElevenLabsClientToolParameters(spec);

    expect((schema as any).properties?.query?.properties?.v).toMatchObject({
      type: 'number',
      description: expect.any(String),
    });
    expect((schema as any).properties?.query?.properties?.v?.enum).toBeUndefined();
    expect((schema as any).properties?.query?.properties?.mode?.enum).toEqual(
      expect.arrayContaining(['hints', 'deep', 'auto']),
    );
  });
});
