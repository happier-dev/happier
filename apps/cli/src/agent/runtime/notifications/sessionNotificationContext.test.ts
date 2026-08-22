import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readAgentCatalogSnapshot } = vi.hoisted(() => ({
  readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

import {
  getSessionNotificationAgentDisplayName,
  getSessionNotificationTitle,
} from './sessionNotificationContext';

describe('sessionNotificationContext', () => {
  beforeEach(() => {
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map([
        ['claude', {
          id: 'claude',
          richDefinition: { definition: { id: 'claude', title: 'Claude' } },
          runtimeSpec: { id: 'claude', title: 'Claude Code CLI' },
        }],
        ['acme.agent', {
          id: 'acme.agent',
          richDefinition: { definition: { id: 'acme.agent', title: 'Acme Agent' } },
          runtimeSpec: null,
        }],
      ]),
      catalogEntriesById: {},
    });
  });

  it('normalizes session titles from metadata snapshots', () => {
    expect(getSessionNotificationTitle(() => ({
      summary: {
        text: '  Review   branch  ',
      },
    }))).toBe('Review branch');

    expect(getSessionNotificationTitle(() => ({ name: '  Named session  ' }))).toBe('Named session');
    expect(getSessionNotificationTitle(() => ({ title: '  Titled session  ' }))).toBe('Titled session');
    expect(getSessionNotificationTitle(() => ({ summary: { text: '   ' } }))).toBeNull();
    expect(getSessionNotificationTitle()).toBeNull();
  });

  it('returns null when metadata snapshots throw', () => {
    expect(getSessionNotificationTitle(() => {
      throw new Error('metadata unavailable');
    })).toBeNull();
  });

  it('resolves agent display names from metadata before catalog fallbacks', () => {
    expect(getSessionNotificationAgentDisplayName(() => ({
      agentDisplayName: '  Claude  ',
      flavor: 'codex',
    }))).toBe('Claude');

    expect(getSessionNotificationAgentDisplayName(() => ({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        provider: {},
      },
    }))).toBe('Claude');
  });

  it('renders the declared title of an installed external Agent', () => {
    expect(getSessionNotificationAgentDisplayName(() => ({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'acme.agent',
        provider: {},
      },
    }))).toBe('Acme Agent');
  });

  it('reports no display name for an Agent that is not installed', () => {
    expect(getSessionNotificationAgentDisplayName(() => ({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'never.installed',
        provider: {},
      },
    }))).toBeNull();
  });
});
