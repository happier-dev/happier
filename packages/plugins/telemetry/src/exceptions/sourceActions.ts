import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { TriageSourcesContributionProtocolV1 } from '@happier-dev/triage-protocol/v1';

import {
  getTelemetryException,
  scanTelemetryExceptions,
  TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1,
} from './source.js';

export const TELEMETRY_ACCOUNT_EXECUTION = {
  target: 'account',
  account: { artifactId: 'telemetry-account-runtime', exportName: 'activate' },
} as const;

export const TELEMETRY_EXCEPTION_SOURCE_ACTION_IDS = {
  listInstances: 'exceptions/list-instances-v1',
  scan: 'exceptions/scan-v1',
  get: 'exceptions/get-v1',
} as const;

const { listInstances, scan, get } = TriageSourcesContributionProtocolV1.operations;
const read = {
  surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'],
  scopes: ['global'],
  execution: TELEMETRY_ACCOUNT_EXECUTION,
  dangerLevel: 'safe',
  readOnly: true,
} as const;
const readIssues = { ...read, hostAccess: ['account-storage'] } as const;

export const TELEMETRY_EXCEPTION_SOURCE_ACTIONS = {
  [TELEMETRY_EXCEPTION_SOURCE_ACTION_IDS.listInstances]: {
    ...read,
    title: 'Discover Happier exceptions',
    description: 'Discover the built-in Happier exceptions source for PRs & Issues setup.',
    inputSchema: listInstances.declaration.input.schema,
    resultSchema: listInstances.declaration.resultSchema,
    run: async () => ({
      kind: 'complete' as const,
      candidates: [TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1],
      failures: [],
    }),
  },
  [TELEMETRY_EXCEPTION_SOURCE_ACTION_IDS.scan]: {
    ...readIssues,
    title: 'Read Happier exceptions',
    description: 'Read native exception issues in this Account and those a Team shared with it, without collector occurrences.',
    inputSchema: scan.declaration.input.schema,
    resultSchema: scan.declaration.resultSchema,
    run: (input: unknown, context: PluginAccountActionContext) =>
      scanTelemetryExceptions(scan.declaration.input.schema.parse(input), context),
  },
  [TELEMETRY_EXCEPTION_SOURCE_ACTION_IDS.get]: {
    ...readIssues,
    title: 'Read a Happier exception',
    description: 'Read one exact native exception issue, including one a Team shared with this Account.',
    inputSchema: get.declaration.input.schema,
    resultSchema: get.declaration.resultSchema,
    run: (input: unknown, context: PluginAccountActionContext) =>
      getTelemetryException(get.declaration.input.schema.parse(input), context),
  },
};
