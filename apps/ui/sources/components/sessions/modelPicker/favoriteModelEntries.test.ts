import { describe, expect, it } from 'vitest';

import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';

import { projectFavoriteModelEntries } from './favoriteModelEntries';

const CODEX = 'agent:happier.agent.codex/codex';
const CLAUDE = 'agent:happier.agent.claude/claude';

function favorite(
  agentTargetKey: string,
  modelId: string,
  extra: Partial<FavoriteModelSelectionV1> = {},
  providerConnectionId: string | null = null,
): FavoriteModelSelectionV1 {
  return {
    selection: {
      v: 1,
      updatedAt: 1,
      ref: { agentTargetKey, providerConnectionId, modelId },
    },
    ...extra,
  } as FavoriteModelSelectionV1;
}

describe('projectFavoriteModelEntries', () => {
  it("keeps the backend's own favourites in saved order, once each, with their effort and source", () => {
    const entries = projectFavoriteModelEntries(
      [
        favorite(CODEX, 'gpt-6', {
          modelLabel: 'GPT 6',
          reasoningEffort: 'high',
        }),
        favorite(CLAUDE, 'opus'),
        favorite(
          CODEX,
          'gpt-6-mini',
          {
            modelLabel: 'GPT 6 mini',
            providerDisplaySnapshot: {
              providerName: 'OpenRouter',
              connectionName: 'Work',
            },
          } as Partial<FavoriteModelSelectionV1>,
          'pc_work',
        ),
        favorite(CODEX, 'gpt-6', { modelLabel: 'GPT 6 again' }),
      ],
      { backendTargetKey: CODEX },
    );

    expect(
      entries.map(({ label, reasoningEffort, sourceLabel }) => ({
        label,
        reasoningEffort,
        sourceLabel,
      })),
    ).toEqual([
      { label: 'GPT 6', reasoningEffort: 'high', sourceLabel: null },
      {
        label: 'GPT 6 mini',
        reasoningEffort: undefined,
        sourceLabel: 'OpenRouter — Work',
      },
    ]);
  });
});
