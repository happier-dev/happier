import { describe, expect, it } from 'vitest';

import { DaemonPluginStructuredMessageActionExecuteRequestSchema } from './daemonInvocationV1.js';

describe('client Action automated invocation provenance', () => {
  it.each(['agent', 'mcp', 'cli'] as const)('admits the current client Action binding on the real %s surface', (executionSurface) => {
    const clientActionBinding = {
      pluginId: 'acme.search', contributionLocalId: 'search', occurrenceId: 'acme.search:current',
    };
    const request = {
      machineId: 'm1', expectedContributorOccurrenceId: 'action-occurrence-7',
      qualifiedActionId: 'acme.target/read', executionSurface,
      invocation: { kind: 'clientPluginAction', clientActionBinding },
    };
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse(request).success).toBe(true);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request, invocation: { kind: 'mountedPluginSurface', mountedBinding: clientActionBinding },
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request, presentUserIntent: 'confirmed',
    }).success).toBe(true);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request, invocation: undefined, presentUserIntent: 'confirmed',
    }).success).toBe(false);
  });
});
