import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import { ToolHappyMetaV2Schema, ToolHappierMetaV2Schema } from './meta.js';

import {
  AgentTeamCreateInputV2Schema,
  AgentTeamSendMessageInputV2Schema,
  AgentTeamSendMessageResultV2Schema,
} from './schemas.js';

describe('AgentTeam tool schemas', () => {
  it('preserves classic JSON Schema projection and open tool-envelope composition', () => {
    const input = z.object({
      _happier: ToolHappierMetaV2Schema.optional(),
      _happy: ToolHappyMetaV2Schema.optional(),
      _raw: z.unknown().optional(),
      team_name: z.string().optional(), teamName: z.string().optional(),
      description: z.string().optional(),
      lead_agent_id: z.string().optional(), leadAgentId: z.string().optional(),
    }).passthrough();
    for (const target of ['draft-2020-12', 'draft-7'] as const) {
      expect(zodSchemaToJsonSchemaObject(AgentTeamCreateInputV2Schema, { target }))
        .toEqual(zodSchemaToJsonSchemaObject(input, { target }));
      expect(zodSchemaToJsonSchemaObject(AgentTeamCreateInputV2Schema.extend({ confirmed: z.boolean().optional() }), { target }))
        .toEqual(zodSchemaToJsonSchemaObject(input.extend({ confirmed: z.boolean().optional() }), { target }));
    }
    expect(AgentTeamCreateInputV2Schema.extend({ confirmed: z.boolean().default(true) })
      .parse({ team_name: 'probe', nativeField: 1 }))
      .toEqual({ team_name: 'probe', confirmed: true, nativeField: 1 });
    expect(AgentTeamCreateInputV2Schema.shape.team_name.parse(undefined)).toBeUndefined();
  });

  it('parses stable AgentTeamCreate input fields', () => {
    const parsed = AgentTeamCreateInputV2Schema.parse({
      team_name: 'probe',
      description: 'probe team',
    });

    expect(parsed.team_name).toBe('probe');
    expect(parsed.description).toBe('probe team');
  });

  it('rejects invalid stable AgentTeamCreate input fields', () => {
    expect(() => AgentTeamCreateInputV2Schema.parse({
      team_name: 42,
    })).toThrow(z.ZodError);
  });

  it('parses stable AgentTeamSendMessage input fields', () => {
    const parsed = AgentTeamSendMessageInputV2Schema.parse({
      team_name: 'probe',
      type: 'broadcast',
      content: 'hello team',
    });

    expect(parsed.team_name).toBe('probe');
    expect(parsed.type).toBe('broadcast');
    expect(parsed.content).toBe('hello team');
  });

  it('rejects invalid stable AgentTeamSendMessage result fields', () => {
    const parsed = AgentTeamSendMessageResultV2Schema.safeParse({
      tool_use_result: {
        status: 1,
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error).toBeInstanceOf(z.ZodError);
      expect(parsed.error.issues).toMatchObject([{ code: 'invalid_type', path: ['tool_use_result', 'status'] }]);
    }
  });
});
