import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderPromptPlanV1 } from '@happier-dev/protocol';

const { readAgentCatalogSnapshot } = vi.hoisted(() => ({
  readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

import { resolveCodingProviderBehaviorBlocks } from './providerPromptBehaviorRegistry';

function agentDefinition(codingPromptBehavior: unknown) {
  return {
    richDefinition: {
      provenance: 'first_party',
      definition: {
        catalog: { codingPromptBehavior },
      },
    },
  };
}

describe('resolveCodingProviderBehaviorBlocks', () => {
  beforeEach(() => {
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map([
        ['claude', agentDefinition({
          blocks: [{
            id: 'provider.claude.ask_user_question_isolation',
            text: [
              'RELIABILITY RULES (IMPORTANT):',
              "- Tool-use sequencing is strict. If you use \"AskUserQuestion\", do NOT include any other tool_use in the same assistant turn. Wait for the user's answer before calling other tools.",
            ].join('\n'),
          }, {
            id: 'provider.claude.disable_todos',
            when: 'disableTodos',
            text: 'Do not create TODO items, TODO lists, or task lists in your output. If you would normally create TODOs, instead proceed with the work directly or ask the user for clarification.',
          }],
        })],
        ['codex', agentDefinition({
          blocks: [{
            id: 'provider.codex.exec_sequencing',
            text: [
              'Tool execution ordering:',
              '- When you need to run multiple `exec_command` calls, run them sequentially.',
              '- Do not enqueue multiple `exec_command` calls at once.',
              '- If any command may require user approval (especially writes), wait for the user decision and the command result before issuing the next command.',
              '- If a dependent read runs before its prerequisite write and fails, rerun the read after the write succeeds.',
            ].join('\n'),
          }],
        })],
      ]),
      catalogEntriesById: {},
      executionRunProfiles: [],
    });
  });

  it('does not keep provider-specific behavior in a CLI-local provider map', () => {
    const source = readFileSync(fileURLToPath(new URL('./providerPromptBehaviorRegistry.ts', import.meta.url)), 'utf8');

    expect(source).not.toContain('CODING_PROVIDER_BEHAVIOR_BLOCKS_BY_PROVIDER');
    expect(source).not.toContain('provider.claude.ask_user_question_isolation');
    expect(source).not.toContain('provider.codex.exec_sequencing');
  });

  it('returns Claude-specific sequencing guidance without duplicating generic attachment instructions', () => {
    const blocks = resolveCodingProviderBehaviorBlocks({
      agentId: 'claude',
    });

    const text = renderPromptPlanV1({ modality: 'coding', blocks });
    expect(text).toContain('AskUserQuestion');
    expect(text).not.toContain('[attachments]');
  });

  it('returns Codex exec sequencing guidance', () => {
    const blocks = resolveCodingProviderBehaviorBlocks({
      agentId: 'codex',
    });

    const text = renderPromptPlanV1({ modality: 'coding', blocks });
    expect(text).toContain('Tool execution ordering');
    expect(text).toContain('exec_command');
  });

  it('can append the remote Claude TODO suppression block', () => {
    const blocks = resolveCodingProviderBehaviorBlocks({
      agentId: 'claude',
      disableTodos: true,
    });

    const text = renderPromptPlanV1({ modality: 'coding', blocks });
    expect(text).toContain('Do not create TODO');
  });

  it('does not include a conditional block when its only declared host condition is false', () => {
    const blocks = resolveCodingProviderBehaviorBlocks({
      agentId: 'claude',
      disableTodos: false,
    });

    const text = renderPromptPlanV1({ modality: 'coding', blocks });
    expect(text).toContain('AskUserQuestion');
    expect(text).not.toContain('Do not create TODO');
  });

  it('does not carry prompt behavior or resume-checklist policy through the private runtime overlay', () => {
    const runtimeContributionPath = fileURLToPath(
      new URL('../../../plugins/projection/registry/agentRuntimeContribution.ts', import.meta.url),
    );
    const catalogHooksSource = readFileSync(
      fileURLToPath(new URL('../../../plugins/projection/registry/agentCatalogEntryHooks.ts', import.meta.url)),
      'utf8',
    );

    expect(existsSync(runtimeContributionPath)).toBe(false);
    expect(catalogHooksSource).not.toContain('params.contribution.codingPromptBehavior');
    expect(catalogHooksSource).not.toContain('params.contribution.checklists');
  });
});
