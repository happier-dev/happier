import { describe, expect, it } from 'vitest';

import { AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_UTF8_BYTES } from '../../runtime/agentSessionStartupInstructionsV1.js';
import { PluginAgentContributionV2Schema } from './v2.js';

const agent = {
  id: 'acme-agent',
  title: 'Acme Agent',
  runtime: { kind: 'custom' },
  primary: 'sessions',
  capabilities: {
    sessions: {
      open: ['create'],
      delivery: ['newTurn'],
      cancel: true,
    },
  },
  catalog: {
    codingPromptBehavior: {
      blocks: [{
        id: 'provider.acme.always',
        text: 'Use the Acme tool sequence.',
      }, {
        id: 'provider.acme.disable_todos',
        when: 'disableTodos',
        text: 'Do not create TODO items.',
      }],
    },
    resumeChecklist: {
      includeLoginStatus: true,
    },
  },
} as const;

describe('Agent catalog declarations', () => {
  it('admits only ordered data-only coding prompts and the closed resume-checklist policy', () => {
    expect(PluginAgentContributionV2Schema.parse(agent).catalog).toEqual(agent.catalog);
    expect(PluginAgentContributionV2Schema.safeParse({
      ...agent,
      catalog: {
        codingPromptBehavior: {
          blocks: [{
            id: 'provider.acme.callback',
            text: 'forbidden callback carrier',
            resolve: 'runtime-hook',
          }],
        },
      },
    }).success).toBe(false);
    expect(PluginAgentContributionV2Schema.safeParse({
      ...agent,
      catalog: {
        codingPromptBehavior: {
          blocks: [{
            id: 'provider.acme.oversized',
            text: 'a'.repeat(AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_UTF8_BYTES + 1),
          }],
        },
      },
    }).success).toBe(false);
    expect(PluginAgentContributionV2Schema.safeParse({
      ...agent,
      catalog: {
        codingPromptBehavior: {
          blocks: [{
            id: 'provider.acme.other-condition',
            text: 'forbidden host condition',
            when: 'hostCapabilityId',
          }],
        },
      },
    }).success).toBe(false);
    expect(PluginAgentContributionV2Schema.safeParse({
      ...agent,
      catalog: {
        resumeChecklist: {
          includeLoginStatus: true,
          capabilityIds: ['cli.acme-agent'],
        },
      },
    }).success).toBe(false);
  });
});
