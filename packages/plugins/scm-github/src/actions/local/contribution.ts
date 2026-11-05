import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { LocalActInspectInputV1Schema, LocalActInspectResultV1Schema, LocalActRunFormInputV1Schema,
  LocalActRunFormResultV1Schema, LocalActRunResultV1Schema, LocalRunSelectionV1Schema, LOCAL_ACT_ACTION_IDS,
  type LocalActInspectResultV1, type LocalActRunResultV1 } from './contracts.js';

const common = { surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'] as const, placementBindings: [],
  hostAccess: ['github-local-act-probes'] };
export const GITHUB_LOCAL_ACT_ACTIONS_V1 = {
  [LOCAL_ACT_ACTION_IDS.inspect]: {
    ...common, title: 'Inspect local workflow choices', dangerLevel: 'safe' as const,
    description: 'Inspect installed act and local workflow bytes on the accepted checkout’s primary Machine. '
      + 'Reads the current Project command preference and declared secret requirements; starts no containers and changes no settings.',
    inputSchema: LocalActInspectInputV1Schema, resultSchema: LocalActInspectResultV1Schema,
    run: async (input: unknown, context: PluginInvocationContext): Promise<LocalActInspectResultV1> => (await import('./inspect.js')).inspectLocalActV1(input, context),
  },
  [LOCAL_ACT_ACTION_IDS.run]: {
    ...common, title: 'Run a workflow locally', dangerLevel: 'externalSideEffect' as const,
    description: 'Run the selected workflow from the current accepted checkout through ordinary Project execution. '
      + 'Uses explicit Linux images/architecture, Advanced operands, declared Saved Secret references or an existing Machine secret file. '
      + 'Does not enable ad-hoc commands, edit .happier/project.json, install tools or change hosted CI/push readiness. '
      + 'A local pass is a hint; forced termination may leave containers whose cleanup is unverified.',
    confirmationWhen: { presentUserUi: false } as const,
    confirmation: { title: 'Run this workflow locally?', body: 'Run workflow code in Linux containers on the accepted checkout’s primary Machine, using the selected images, files and secret references.', confirmLabel: 'Run locally' },
    inputSchema: LocalRunSelectionV1Schema, resultSchema: LocalActRunResultV1Schema,
    run: async (input: unknown, context: PluginInvocationContext): Promise<LocalActRunResultV1> => (await import('./run.js')).runLocalActV1(input, context),
  },
  [LOCAL_ACT_ACTION_IDS.form]: {
    title: 'Open or edit the local workflow form', dangerLevel: 'safe' as const,
    description: 'Open the shared local-run form, or read/change an actual mounted form’s unsent operands. '
      + 'Opening and editing start no commands and grant no Project permission. Headless callers use local-inspect and local-run.',
    surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'] as const, placementBindings: [],
    execution: { target: 'client', client: { artifactId: 'github-local-act-actions', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] } as const,
    inputSchema: LocalActRunFormInputV1Schema, resultSchema: LocalActRunFormResultV1Schema,
  },
};
