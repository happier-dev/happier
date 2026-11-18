/**
 * The Telemetry widgets (D36): installed contributions the person adds from Add widget → Telemetry.
 * Installed is not added: every one is `available`, never shown on Home before the person picks it.
 * Each binds one Environment through the host's `deployments.environments.telemetry` option source;
 * the body reads the collector only while the host presents it.
 */

import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import type { UiRenderer, UiView } from '@happier-dev/plugin-sdk/ui';
import type { InputFieldHint, InputHints } from '@happier-dev/plugin-sdk/actions';

/** The host option source that lists the Home's Environments with telemetry on (protocol `inputs`). */
export const TELEMETRY_WIDGET_ENVIRONMENT_OPTIONS_SOURCE_ID =
  'deployments.environments.telemetry';
/** The host option source that lists the routes the chosen Environment served (protocol `inputs`). */
export const TELEMETRY_WIDGET_ROUTE_OPTIONS_SOURCE_ID =
  'deployments.environments.telemetry.routes';

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

const environmentField: InputFieldHint = {
  path: 'environment',
  title: 'Environment',
  widget: 'select',
  required: true,
  optionsSourceId: TELEMETRY_WIDGET_ENVIRONMENT_OPTIONS_SOURCE_ID,
};

const environmentInputs: InputHints = { fields: [environmentField] };
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
const SHOW_OPTIONS = [
  { value: 'numberAndChart', label: 'Number and chart' },
  { value: 'number', label: 'Number' },
  { value: 'chart', label: 'Chart' },
];

const metricInputs: InputHints = {
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
      // Request time and error rate read for one route when one is chosen; otherwise for the whole service.
      path: 'route',
      title: 'Route',
      description: 'For request time and error rate. Leave empty for the whole service.',
      widget: 'select',
      required: false,
      optionsSourceId: TELEMETRY_WIDGET_ROUTE_OPTIONS_SOURCE_ID,
    },
    {
      path: 'range',
      title: 'Range',
      widget: 'select',
      required: true,
      options: RANGE_OPTIONS,
      defaultValue: '24h',
    },
    {
      path: 'show',
      title: 'Show',
      widget: 'select',
      required: true,
      options: SHOW_OPTIONS,
      defaultValue: 'numberAndChart',
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
    route: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'route'],
      properties: {
        method: { type: 'string', minLength: 1 },
        route: { type: 'string', minLength: 1 },
      },
    },
    range: {
      type: 'string',
      enum: RANGE_OPTIONS.map((option) => option.value),
    },
    show: {
      type: 'string',
      enum: SHOW_OPTIONS.map((option) => option.value),
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
    description: {
      key: 'plugins.telemetry.widgets.appVitals.description',
      fallback: 'Requests, p95 and errors, each with its line',
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
    title: { key: 'plugins.telemetry.widgets.metric', fallback: 'App metric' },
    description: {
      key: 'plugins.telemetry.widgets.metric.description',
      fallback: 'Latency, errors, requests or heap over time',
    },
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
    description: {
      key: 'plugins.telemetry.widgets.slowestRoutes.description',
      fallback: 'The slowest routes and their error rates',
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
