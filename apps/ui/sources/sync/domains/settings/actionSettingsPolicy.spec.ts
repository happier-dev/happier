import { describe, expect, it } from 'vitest';

import { ACTION_ID_FAMILIES_V1, type ActionId } from '@happier-dev/protocol';

import { isInventoryPrivacyAction } from './actionSettingsPolicy';

describe('isInventoryPrivacyAction', () => {
  it('classifies every protocol inventory-family action as an inventory privacy action', () => {
    for (const actionId of ACTION_ID_FAMILIES_V1.inventory) {
      expect(isInventoryPrivacyAction(actionId as ActionId)).toBe(true);
    }
  });

  it('classifies the agent backend/model and review-engine inventory tools (FIND-018 leak)', () => {
    expect(isInventoryPrivacyAction('agents.backends.list')).toBe(true);
    expect(isInventoryPrivacyAction('agents.models.list')).toBe(true);
    expect(isInventoryPrivacyAction('review.engines.list')).toBe(true);
  });

  it('keeps the original path/machine/server inventory tools classified', () => {
    expect(isInventoryPrivacyAction('paths.list_recent')).toBe(true);
    expect(isInventoryPrivacyAction('machines.list')).toBe(true);
    expect(isInventoryPrivacyAction('servers.list')).toBe(true);
  });

  it('does not classify non-inventory actions as inventory privacy actions', () => {
    expect(isInventoryPrivacyAction('session.message.send')).toBe(false);
    expect(isInventoryPrivacyAction('session.open')).toBe(false);
  });
});
