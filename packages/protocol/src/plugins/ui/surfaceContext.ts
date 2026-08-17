import { z } from 'zod';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import {
  PluginContributionIdentityV1Schema,
  type PluginContributionIdentityV1,
} from '../contributionIdentity.js';
import { PluginUiChannelV1Schema, PluginUiPlatformV1Schema } from '../contributions/ui/compatibility.js';
import { PluginSessionResourceTargetV1Schema } from '../contributions/ui/resources.js';
import {
  PluginUiContainerV1Schema,
  type PluginUiContainerV1,
} from '../contributions/ui/surfaceRegistry.js';
import { PluginUiTargetedContributionsV1Schema } from './targetedContributions.js';
import {
  PluginUiSurfacePlacementV1Schema,
  type PluginUiSurfacePlacementV1,
} from './surfaceContextPlacement.js';

// Preserve the surface-context schema import while keeping request-envelope
// initialization independent from the destination registry. Mounted hosts
// consume the registry-derived context carried by a normalized binding; the
// semantic contribution families supply their own two context values.
export { PluginUiSurfacePlacementV1Schema } from './surfaceContextPlacement.js';
export type { PluginUiSurfacePlacementV1 } from './surfaceContextPlacement.js';

/**
 * The author-visible mounting fact for a plugin UI surface.
 *
 * A destination is stamped from the normalized destination binding; embedded
 * surfaces intentionally carry no invented destination identity or container.
 * This schema is separate from the host-private legacy request context below:
 * the latter remains the controller's coarse dispatch key, while this union is
 * the one public SDK truth rendered to an author.
 */
export const PluginUiMountContextV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('destination'),
    destination: asProtocolZod(PluginContributionIdentityV1Schema),
    container: PluginUiContainerV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('embedded'),
    role: z.string().trim().min(1),
    presentation: z.enum(['content', 'fill']),
  }).strict(),
]);
export type PluginUiMountContextV1 =
  | Readonly<{
    kind: 'destination';
    destination: PluginContributionIdentityV1;
    container: PluginUiContainerV1;
  }>
  | Readonly<{
    kind: 'embedded';
    role: string;
    presentation: 'content' | 'fill';
  }>;

/**
 * Preserve transport values exactly while rejecting strings that cannot name a
 * current public surface fact. The mounted transport already has JSON-safe
 * values; this is an author-facing payload grammar, not a normalizer.
 */
const PluginUiHostApiSurfaceNonBlankStringV1Schema = z.string().refine(
  (value) => value.trim().length > 0,
  'Expected a non-blank string.',
);

/** The exact mounted target disclosure carried to an author-facing UI. */
export const PluginUiHostApiSurfaceTargetV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('app') }).strict(),
  z.object({
    kind: z.literal('session'),
    sessionId: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    agentId: PluginUiHostApiSurfaceNonBlankStringV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('project'),
    projectId: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('browser'),
    targetId: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    origin: PluginUiHostApiSurfaceNonBlankStringV1Schema.optional(),
  }).strict(),
  z.object({ kind: z.literal('services') }).strict(),
]);
export type PluginUiHostApiSurfaceTargetV1 = z.infer<
  typeof PluginUiHostApiSurfaceTargetV1Schema
>;

const PluginUiHostApiSurfaceMetricV1Schema = z.number().finite().nonnegative();

const PluginUiHostApiSurfaceThemeTypographyV1Schema = z.object({
  body: z.object({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontWeight: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }).strict(),
  label: z.object({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontWeight: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }).strict(),
  title: z.object({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontWeight: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }).strict(),
  caption: z.object({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontWeight: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }).strict(),
  code: z.object({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontFamily: PluginUiHostApiSurfaceNonBlankStringV1Schema.optional(),
  }).strict(),
}).strict();

/** The complete semantic theme payload, not a style-system object. */
export const PluginUiHostApiSurfaceThemeV1Schema = z.object({
  version: z.literal(1),
  colors: z.object({
    canvas: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    surface: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    elevatedSurface: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    text: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    secondaryText: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    mutedText: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    border: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    divider: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    focus: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    accent: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    onAccent: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    success: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    warning: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    danger: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    info: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    control: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    controlDisabled: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    overlay: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }).strict(),
  spacing: z.object({
    xsmall: PluginUiHostApiSurfaceMetricV1Schema,
    small: PluginUiHostApiSurfaceMetricV1Schema,
    medium: PluginUiHostApiSurfaceMetricV1Schema,
    large: PluginUiHostApiSurfaceMetricV1Schema,
    xlarge: PluginUiHostApiSurfaceMetricV1Schema,
  }).strict(),
  radii: z.object({
    small: PluginUiHostApiSurfaceMetricV1Schema,
    control: PluginUiHostApiSurfaceMetricV1Schema,
    panel: PluginUiHostApiSurfaceMetricV1Schema,
    pill: PluginUiHostApiSurfaceMetricV1Schema,
  }).strict(),
  typography: PluginUiHostApiSurfaceThemeTypographyV1Schema,
}).strict();
export type PluginUiHostApiSurfaceThemeV1 = z.infer<
  typeof PluginUiHostApiSurfaceThemeV1Schema
>;

/**
 * The one strict browser-safe rich payload for `context()` and `watchContext`.
 *
 * `PluginUiSurfaceContextV1Schema` below remains the separate host-private
 * request dispatch key. It is not an alternate author payload grammar.
 */
export const PluginUiHostApiSurfaceContextV1Schema = z.object({
  mount: PluginUiMountContextV1Schema,
  target: PluginUiHostApiSurfaceTargetV1Schema,
  accountEncryptionMode: z.enum(['plain', 'e2ee']),
  platform: PluginUiPlatformV1Schema,
  locale: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  direction: z.enum(['ltr', 'rtl']),
  colorScheme: z.enum(['light', 'dark']),
  contrast: z.enum(['normal', 'high']),
  textScale: z.number().finite().positive(),
  reducedMotion: z.boolean(),
  screenReaderEnabled: z.boolean(),
  safeAreaInsets: z.object({
    top: PluginUiHostApiSurfaceMetricV1Schema,
    right: PluginUiHostApiSurfaceMetricV1Schema,
    bottom: PluginUiHostApiSurfaceMetricV1Schema,
    left: PluginUiHostApiSurfaceMetricV1Schema,
  }).strict(),
  theme: PluginUiHostApiSurfaceThemeV1Schema,
  translations: z.record(z.string(), z.string()),
  targetedContributions: PluginUiTargetedContributionsV1Schema,
}).strict();
export type PluginUiHostApiSurfaceContextV1 = z.infer<
  typeof PluginUiHostApiSurfaceContextV1Schema
>;

export const PluginUiSurfaceContextV1Schema = z.object({
  pluginId: z.string().trim().min(1),
  contributionId: z.string().trim().min(1),
  surfaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).optional(),
  placement: PluginUiSurfacePlacementV1Schema.default('unknown'),
  platform: PluginUiPlatformV1Schema,
  channel: PluginUiChannelV1Schema,
  resourceScope: z.array(PluginSessionResourceTargetV1Schema).default([]),
  diagnostics: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginUiSurfaceContextV1 = z.infer<typeof PluginUiSurfaceContextV1Schema>;
