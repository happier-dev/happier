import { describe, expect, it } from 'vitest';

import {
  AGENT_SESSION_RUNTIME_EVENT_KINDS_V1,
  type AgentSessionRuntimeEventV1,
} from '../../runtime/agentSessionV1.js';
import { PluginEventContributionV1Schema } from './events.js';

describe('plugin event contributions', () => {
  it('reserves every canonical agent runtime event id from plugin publication', () => {
    const exhaustive: Exclude<
      AgentSessionRuntimeEventV1['kind'],
      typeof AGENT_SESSION_RUNTIME_EVENT_KINDS_V1[number]
    > extends never ? true : false = true;
    expect(exhaustive).toBe(true);
    for (const id of AGENT_SESSION_RUNTIME_EVENT_KINDS_V1) {
      expect(PluginEventContributionV1Schema.safeParse({
        id,
        kind: 'event',
        title: id,
      }).success).toBe(false);
    }
    expect(PluginEventContributionV1Schema.safeParse({
      id: 'workspace-changed',
      kind: 'event',
      title: 'Workspace changed',
    }).success).toBe(true);
  });

  it('admits one strict discriminated static target for plugin and Host Event handlers', () => {
    expect(PluginEventContributionV1Schema.safeParse({
      id: 'watch-plugin',
      kind: 'subscription',
      target: {
        kind: 'plugin',
        event: { pluginId: 'com.acme.publisher', localId: 'changed' },
      },
    }).success).toBe(true);
    expect(PluginEventContributionV1Schema.safeParse({
      id: 'watch-turns',
      kind: 'subscription',
      target: {
        kind: 'host',
        eventId: '@happier/runtime/turn-complete',
        scope: { kind: 'session', sessionId: 'session-1' },
      },
    }).success).toBe(true);
    expect(PluginEventContributionV1Schema.safeParse({
      id: 'watch-turns',
      kind: 'subscription',
      target: {
        kind: 'host',
        eventId: '@happier/runtime/turn-complete',
        scope: { kind: 'host' },
      },
    }).success).toBe(false);
    expect(PluginEventContributionV1Schema.safeParse({
      id: 'watch-automation-runs',
      kind: 'subscription',
      target: {
        kind: 'host',
        eventId: '@happier/automation/run-state-changed',
        scope: { kind: 'account' },
      },
    }).success).toBe(true);
    expect(PluginEventContributionV1Schema.safeParse({
      id: 'watch-turns',
      kind: 'subscription',
      target: {
        kind: 'host',
        eventId: '@happier/runtime/turn-complete',
        scope: { kind: 'account' },
      },
    }).success).toBe(false);
  });

  it('keeps Automation eligibility as an optional declarative extension of the canonical Event owner', () => {
    expect(PluginEventContributionV1Schema.safeParse({
      id: 'repository-event',
      kind: 'event',
      title: 'Repository event',
      payloadSchema: { type: 'object', additionalProperties: false },
      automation: {
        v: 1,
        eligible: true,
        source: {
          sourceContractVersion: 1,
          supportedObservationTransports: ['checkpointedPull'],
          sourceConfigSchema: { type: 'object', additionalProperties: false },
        },
      },
    }).success).toBe(true);

    expect(PluginEventContributionV1Schema.safeParse({
      id: 'repository-event',
      kind: 'event',
      title: 'Repository event',
      automation: {
        v: 1,
        eligible: false,
      },
    }).success).toBe(false);
    expect(PluginEventContributionV1Schema.safeParse({
      id: 'watch-repository-event',
      kind: 'subscription',
      target: { kind: 'plugin', event: 'repository-event' },
      automation: {
        v: 1,
        eligible: true,
        source: {
          sourceContractVersion: 1,
          supportedObservationTransports: ['checkpointedPull'],
          sourceConfigSchema: { type: 'object' },
        },
      },
    }).success).toBe(false);
  });

  it('refuses Automation eligibility for an Event that publishes no payload contract', () => {
    const payloadless = PluginEventContributionV1Schema.safeParse({
      id: 'repository-event',
      kind: 'event',
      title: 'Repository event',
      automation: {
        v: 1,
        eligible: true,
        source: {
          sourceContractVersion: 1,
          supportedObservationTransports: ['checkpointedPull'],
          sourceConfigSchema: { type: 'object', additionalProperties: false },
        },
      },
    });
    expect(payloadless.success).toBe(false);
    expect(payloadless.error?.issues.map((issue) => issue.path.join('.')))
      .toContain('payloadSchema');

    // The same Event without the Automation extension is still publishable
    // without a payload contract, so the rule cannot be a blanket requirement.
    expect(PluginEventContributionV1Schema.safeParse({
      id: 'repository-event',
      kind: 'event',
      title: 'Repository event',
    }).success).toBe(true);
  });
});
