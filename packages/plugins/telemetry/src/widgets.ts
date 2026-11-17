/**
 * The Telemetry widgets (D36): installed contributions the person adds from Add widget → Telemetry.
 * Installed is not added: every one is `available`, never shown on Home before the person picks it.
 * Each binds one Environment through the host's `deployments.environments.telemetry` option source;
 * the body reads the collector only while the host presents it.
 */

import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import type { UiRenderer, UiView } from '@happier-dev/plugin-sdk/ui';

/** The host option source that lists the Home's Environments with telemetry on (protocol `inputs`). */
export const TELEMETRY_WIDGET_ENVIRONMENT_OPTIONS_SOURCE_ID =
  'deployments.environments.telemetry';

export const TELEMETRY_WIDGET_ARTIFACTS = Object.freeze({
  appVitals: 'telemetry-app-vitals-widget-native',
  metric: 'telemetry-metric-widget-native',
  slowestRoutes: 'telemetry-slowest-routes-widget-native',
});

const environmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['serverId', 'environmentId'],
  properties: {
    serverId: { type: 'string', minLength: 1 },
    environmentId: { type: 'string', minLength: 1 },
  },
} satisfies PluginJsonSchema;

const environmentField = {
  path: 'environment',
  title: 'Environment',
  widget: 'select',
  required: true,
  optionsSourceId: TELEMETRY_WIDGET_ENVIRONMENT_OPTIONS_SOURCE_ID,
} as const;

const environmentInputs = { fields: [environmentField] };
const environmentInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['environment'],
  properties: { environment: environmentSchema },
} satisfies PluginJsonSchema;

const METRIC_OPTIONS = [
  { value: 'p95', label: 'p95 request time' },
  { value: 'p50', label: 'Median request time' },
  { value: 'errorRate', label: 'Error rate' },
  { value: 'requests', label: 'Requests' },
  { value: 'heap', label: 'Heap used' },
];
const RANGE_OPTIONS = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
];

const metricInputs = {
  fields: [
    environmentField,
    {
      path: 'metric',
      title: 'Metric',
      widget: 'select',
      required: true,
      options: METRIC_OPTIONS,
      defaultValue: 'p95',
    },
    {
      path: 'range',
      title: 'Range',
      widget: 'select',
      required: true,
      options: RANGE_OPTIONS,
      defaultValue: '24h',
    },
  ],
};
const metricInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['environment', 'metric', 'range'],
  properties: {
    environment: environmentSchema,
    metric: {
      type: 'string',
      enum: METRIC_OPTIONS.map((option) => option.value),
    },
    range: {
      type: 'string',
      enum: RANGE_OPTIONS.map((option) => option.value),
    },
  },
} satisfies PluginJsonSchema;

export const TELEMETRY_WIDGET_VIEWS: readonly UiView[] = [
  {
    id: 'app-vitals',
    container: 'widget',
    target: { kind: 'app' },
    renderer: 'app-vitals-widget',
    icon: 'pulse',
    title: {
      key: 'plugins.telemetry.widgets.appVitals',
      fallback: 'App vitals',
    },
    home: { default: 'available' },
    sizeDeclaration: { sizes: ['medium', 'wide'], defaultSize: 'medium' },
    inputs: environmentInputs,
    inputSchema: environmentInputSchema,
  },
  {
    id: 'metric',
    container: 'widget',
    target: { kind: 'app' },
    renderer: 'metric-widget',
    icon: 'chart',
    title: { key: 'plugins.telemetry.widgets.metric', fallback: 'Metric' },
    home: { default: 'available' },
    sizeDeclaration: {
      sizes: ['small', 'medium', 'wide'],
      defaultSize: 'medium',
    },
    inputs: metricInputs,
    inputSchema: metricInputSchema,
  },
  {
    id: 'slowest-routes',
    container: 'widget',
    target: { kind: 'app' },
    renderer: 'slowest-routes-widget',
    icon: 'list',
    title: {
      key: 'plugins.telemetry.widgets.slowestRoutes',
      fallback: 'Slowest routes',
    },
    home: { default: 'available' },
    sizeDeclaration: {
      sizes: ['medium', 'wide', 'tall'],
      defaultSize: 'medium',
    },
    inputs: environmentInputs,
    inputSchema: environmentInputSchema,
  },
];

/** The widgets read collector Actions (and the Environment list for their names) through the mounted host. */
export const TELEMETRY_WIDGET_RENDERERS: readonly UiRenderer[] = [
  {
    id: 'app-vitals-widget',
    kind: 'reactNative',
    artifact: TELEMETRY_WIDGET_ARTIFACTS.appVitals,
    requiredHostMethods: ['executeAction'],
  },
  {
    id: 'metric-widget',
    kind: 'reactNative',
    artifact: TELEMETRY_WIDGET_ARTIFACTS.metric,
    requiredHostMethods: ['executeAction'],
  },
  {
    id: 'slowest-routes-widget',
    kind: 'reactNative',
    artifact: TELEMETRY_WIDGET_ARTIFACTS.slowestRoutes,
    requiredHostMethods: ['executeAction'],
  },
];
