import { describe, expect, it } from 'vitest';

import {
  AgentTeamCreateInputV2Schema,
  AgentTeamSendMessageInputV2Schema,
  AgentTeamSendMessageResultV2Schema,
} from './index.js';

describe('AgentTeam tool schemas', () => {
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
    })).toThrow();
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
    expect(() => AgentTeamSendMessageResultV2Schema.parse({
      tool_use_result: {
        status: 1,
      },
    })).toThrow();
  });
});
