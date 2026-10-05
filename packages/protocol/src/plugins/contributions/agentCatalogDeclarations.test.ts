import { describe, expect, it } from 'vitest';

import { AGENT_CODING_PROMPT_BLOCK_V1_MAX_UTF8_BYTES, PluginAgentContributionV2Schema } from './v2.js';

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
  it('admits declared JSON output independently of continuation and rejects unknown formats or capability fields', () => {
    const contribution = { ...agent, capabilities: {
      ...agent.capabilities, structuredOutput: { formats: ['json'] },
    } };
    expect(PluginAgentContributionV2Schema.safeParse(contribution).success).toBe(true);
    expect(PluginAgentContributionV2Schema.parse(agent).capabilities).not.toHaveProperty('structuredOutput');
    expect(PluginAgentContributionV2Schema.safeParse({ ...contribution, capabilities: {
      ...contribution.capabilities, structuredOutput: { formats: ['xml'] },
    } }).success).toBe(false);
    expect(PluginAgentContributionV2Schema.safeParse({ ...contribution, capabilities: {
      ...contribution.capabilities, structuredOutput: { formats: ['json'], resume: true },
    } }).success).toBe(false);
  });

  it('declares revision delivery through resume explicitly and fails closed for undeclared or unknown mechanisms', () => {
    const withStartup = (revisionChanges?: string) => ({
      ...agent,
      capabilities: { sessions: { ...agent.capabilities.sessions,
        open: ['create', 'resume'], startupInstructions: { versions: [1],
          ...(revisionChanges ? { revisionChanges } : {}) },
      } },
    });
    expect(PluginAgentContributionV2Schema.safeParse(withStartup('resume')).success).toBe(true);
    expect(PluginAgentContributionV2Schema.safeParse(withStartup('patch')).success).toBe(false);
    expect(PluginAgentContributionV2Schema.parse(withStartup()).capabilities.sessions?.startupInstructions)
      .not.toHaveProperty('revisionChanges');
  });

  it('keeps Agent lifecycle capability grammar exclusive to the declared primary runtime', () => {
    expect(PluginAgentContributionV2Schema.safeParse({
      ...agent,
      capabilities: {
        ...agent.capabilities,
        executionRuns: { open: ['create'], checkpoint: false, stop: true },
      },
    }).success).toBe(false);

    expect(PluginAgentContributionV2Schema.safeParse({
      ...agent,
      primary: 'executionRuns',
      capabilities: {
        executionRuns: { open: ['create'], checkpoint: false, stop: true },
        sessions: agent.capabilities.sessions,
      },
    }).success).toBe(false);
  });

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
            text: 'a'.repeat(AGENT_CODING_PROMPT_BLOCK_V1_MAX_UTF8_BYTES + 1),
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
