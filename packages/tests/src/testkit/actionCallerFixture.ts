import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

type PluginInvocationCaller = NonNullable<PluginInvocationContext['caller']>;

export type AutomationRunCallerFixture = Extract<
  PluginInvocationCaller,
  { kind: 'automationRun' }
>;

export type PluginCallerFixture = Extract<
  PluginInvocationCaller,
  { kind: 'plugin' }
>;

/**
 * Host-stamped caller fixtures for Action-boundary tests. These values model
 * the public SDK context received by a target plugin; callers under test must
 * not derive or accept these fields from mutable Action input.
 */
export function createAutomationRunCallerFixture(input: Readonly<{
  runId: string;
  automationId: string;
  cause: AutomationRunCallerFixture['cause'];
}>): AutomationRunCallerFixture {
  return Object.freeze({
    kind: 'automationRun' as const,
    runId: input.runId,
    automationId: input.automationId,
    cause: input.cause,
  });
}

export function createPluginCallerFixture(input: Readonly<{
  pluginId: string;
  contribution: PluginCallerFixture['contribution'];
  materialization: PluginCallerFixture['materialization'];
  originSurface?: PluginCallerFixture['originSurface'];
}>): PluginCallerFixture {
  return Object.freeze({
    kind: 'plugin' as const,
    pluginId: input.pluginId,
    contribution: Object.freeze({ ...input.contribution }),
    materialization: Object.freeze({ ...input.materialization }),
    ...(input.originSurface === undefined ? {} : { originSurface: input.originSurface }),
  });
}
