import { z } from 'zod';

export const PluginStructuredMessageRendererIdV1Schema = z.enum([
  'actionList',
  'keyValue',
  'markdownSummary',
  'notice',
  'resourceLink',
  'status',
  'summaryCard',
]);
export type PluginStructuredMessageRendererIdV1 = z.infer<typeof PluginStructuredMessageRendererIdV1Schema>;

export const PluginSessionSurfaceRendererIdV1Schema = z.enum([
  'actionPanel',
  'emptyState',
  'fileReference',
  'markdownDetails',
  'previewPlaceholder',
  'resourceSummary',
  'statusTimeline',
  'terminalReference',
]);
export type PluginSessionSurfaceRendererIdV1 = z.infer<typeof PluginSessionSurfaceRendererIdV1Schema>;

export const PluginSessionHeaderActionRendererIdV1Schema = z.enum([
  'badgeButton',
  'iconButton',
  'menuItem',
]);
export type PluginSessionHeaderActionRendererIdV1 = z.infer<typeof PluginSessionHeaderActionRendererIdV1Schema>;

export const PluginUiRendererFamilyV1Schema = z.enum([
  'structuredMessage',
  'sessionSurface',
  'sessionHeaderAction',
  'hostedWeb',
  'reactNativeBundle',
]);
export type PluginUiRendererFamilyV1 = z.infer<typeof PluginUiRendererFamilyV1Schema>;
