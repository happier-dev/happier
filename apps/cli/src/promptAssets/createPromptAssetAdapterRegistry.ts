import type { PromptAssetAdapter } from './types';
import { createAgentsSkillPromptAssetAdapter } from './adapters/agentsSkill/createAgentsSkillPromptAssetAdapter';
import { createClaudeSkillPromptAssetAdapter } from '@/backends/claude/promptAssets/createClaudeSkillPromptAssetAdapter';
import { createClaudeCommandPromptAssetAdapter } from '@/backends/claude/promptAssets/createClaudeCommandPromptAssetAdapter';
import { createGeminiSkillPromptAssetAdapter } from '@/backends/gemini/promptAssets/createGeminiSkillPromptAssetAdapter';
import { createCopilotSkillPromptAssetAdapter } from '@/backends/copilot/promptAssets/createCopilotSkillPromptAssetAdapter';
import { createOpenCodeCommandPromptAssetAdapter } from '@/backends/opencode/promptAssets/createOpenCodeCommandPromptAssetAdapter';
import { createOpenCodeSkillPromptAssetAdapter } from '@/backends/opencode/promptAssets/createOpenCodeSkillPromptAssetAdapter';

export function createPromptAssetAdapterRegistry(params?: Readonly<{
  homedir?: () => string;
  happierHomeDir?: () => string;
}>): Map<string, PromptAssetAdapter> {
  const adapters = [
    createAgentsSkillPromptAssetAdapter({
      homedir: params?.homedir,
      happierHomeDir: params?.happierHomeDir,
    }),
    createClaudeSkillPromptAssetAdapter({
      homedir: params?.homedir,
      happierHomeDir: params?.happierHomeDir,
    }),
    createClaudeCommandPromptAssetAdapter({
      homedir: params?.homedir,
    }),
    createGeminiSkillPromptAssetAdapter({
      homedir: params?.homedir,
      happierHomeDir: params?.happierHomeDir,
    }),
    createCopilotSkillPromptAssetAdapter({
      homedir: params?.homedir,
      happierHomeDir: params?.happierHomeDir,
    }),
    createOpenCodeCommandPromptAssetAdapter({
      homedir: params?.homedir,
    }),
    createOpenCodeSkillPromptAssetAdapter({
      homedir: params?.homedir,
      happierHomeDir: params?.happierHomeDir,
    }),
  ];

  return new Map(adapters.map((adapter) => [adapter.descriptor.id, adapter] as const));
}
