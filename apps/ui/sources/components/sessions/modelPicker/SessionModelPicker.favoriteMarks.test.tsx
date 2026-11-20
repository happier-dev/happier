/**
 * Round 4 (owner 2026-11-19): on an Agent's own page its favourites carry no Agent or Provider mark; the name says
 * enough there. Other Agents' favourites keep their identity mark on the cross-Agent Favorites page, which draws
 * every row with its Agent (`NewSessionFavoriteModelsDetail`). This pins the own-page half.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

const { SessionModelPicker } = await import('./SessionModelPicker');
const { sessionModelSelectionKey } = await import('./sessionModelSelectionKey');

const AGENT = 'agent:happier.agent.claude/claude';
const opus = {
  agentTargetKey: AGENT,
  providerConnectionId: null,
  modelId: 'claude-opus-5-5',
};

describe("SessionModelPicker favourites on the Agent's own page", () => {
  it('draws its own favourites without an Agent or Provider mark', async () => {
    const screen = await renderScreen(
      <SessionModelPicker
        multiColumn
        agentTargetKey={AGENT}
        nativeSourceLabel="Claude subscription · Work pool"
        nativeModels={[
          { value: 'claude-opus-5-5', label: 'Opus 5.5' },
          { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
        ]}
        providerGroups={[]}
        providerProjectionAuthoritative
        selected={{
          agentTargetKey: AGENT,
          providerConnectionId: null,
          modelId: 'claude-haiku-5-5',
        }}
        favoriteEntries={[{ ref: opus, label: 'Opus 5.5' }]}
        favoriteKeys={new Set([sessionModelSelectionKey(opus)])}
        onToggleFavorite={() => {}}
        onSelect={() => {}}
      />,
    );
    try {
      const key = sessionModelSelectionKey(opus);
      expect(
        screen.findByTestId(`model-picker-overlay-option:${key}`),
      ).not.toBeNull();
      expect(
        screen.findByTestId(`model-picker-overlay-option-icon:${key}`),
      ).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
