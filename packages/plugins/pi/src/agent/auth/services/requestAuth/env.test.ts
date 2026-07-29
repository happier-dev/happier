import { describe, expect, it } from 'vitest';

import { readPiRequestAuthMaterialization } from './env.js';

describe('Pi request-auth host projection', () => {
  it('maps only exact qualified purpose bindings to Pi provider ids', () => {
    expect(readPiRequestAuthMaterialization({
      capabilityPath: '/materialized/.happier/request-auth-capability.json',
      purposeBindings: [{
        purpose: {
          consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
          purpose: 'anthropic-model-request',
        },
        target: {
          kind: 'group',
          service: {
            pluginId: 'happier.agent.claude',
            localId: 'claude-subscription',
          },
          groupId: 'claude-team',
        },
      }, {
        purpose: {
          consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
          purpose: 'openai-codex-model-request',
        },
        target: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.agent.codex',
              localId: 'openai-codex',
            },
            accountId: 'codex-work',
          },
        },
      }],
    })).toEqual({
      capabilityPath: '/materialized/.happier/request-auth-capability.json',
      purposesByProviderId: {
        anthropic: {
          consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
          purpose: 'anthropic-model-request',
        },
        'openai-codex': {
          consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
          purpose: 'openai-codex-model-request',
        },
      },
    });
  });

  it('fails closed when the target service does not match the declared purpose', () => {
    expect(readPiRequestAuthMaterialization({
      capabilityPath: '/materialized/capability.json',
      purposeBindings: [{
        purpose: {
          consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
          purpose: 'anthropic-model-request',
        },
        target: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.agent.codex',
              localId: 'openai-codex',
            },
            accountId: 'wrong',
          },
        },
      }],
    })).toBeNull();
  });
});
