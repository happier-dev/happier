import { describe, expect, it } from 'vitest';

import { derivePluginDaemonContributionRegistrationRights } from './catalog.js';

const sessionCapabilities = Object.freeze({
  open: Object.freeze(['create'] as const),
  delivery: Object.freeze(['newTurn'] as const),
  cancel: true,
});

const executionRunCapabilities = Object.freeze({
  open: Object.freeze(['create'] as const),
  checkpoint: false,
  stop: true,
});

describe('Agent runner-factory registration correspondence', () => {
  it('requires the factory and runner locator for a session-capable custom Agent', () => {
    expect(derivePluginDaemonContributionRegistrationRights({
      agents: [{
        id: 'session-agent',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: { sessions: sessionCapabilities },
      }],
    })).toEqual([{
      family: 'agents',
      localId: 'session-agent',
      target: { realm: 'daemon' },
      requiredFields: ['factory', 'sessionRunnerFactory'],
    }]);
  });

  it('does not permit a runner locator for an execution-only custom Agent', () => {
    expect(derivePluginDaemonContributionRegistrationRights({
      agents: [{
        id: 'execution-agent',
        runtime: { kind: 'custom' },
        primary: 'executionRuns',
        capabilities: { executionRuns: executionRunCapabilities },
      }],
    })).toEqual([{
      family: 'agents',
      localId: 'execution-agent',
      target: { realm: 'daemon' },
      requiredFields: ['factory'],
    }]);
  });

  it('rejects an execution-primary Agent that also declares Session capability', () => {
    expect(() => derivePluginDaemonContributionRegistrationRights({
      agents: [{
        id: 'composite-agent',
        runtime: { kind: 'custom' },
        primary: 'executionRuns',
        capabilities: {
          executionRuns: executionRunCapabilities,
          sessions: sessionCapabilities,
        },
      }],
    })).toThrow("Execution-primary Agent 'composite-agent' cannot declare Session capabilities");
  });
});
