import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import {
  PluginContributionReferenceV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from '../publicTypes.js';

const HostMethodSchema = z.enum(['context', 'watchContext', 'executeAction', 'readResource', 'watchResource', 'openSurface', 'diagnostic', 'readClipboard', 'writeClipboard', 'openExternalLink']);
const PlacementSchema = z.enum(['session.details', 'session.preview', 'session.tool', 'session.side', 'session.rightSidebarTab', 'workspace.details', 'workspace.main', 'project.details', 'project.main', 'project.rightSidebarTab', 'app.settingsPage', 'app.sidePanel', 'app.bottomPanel', 'app.rightSidebarTab', 'browser.panel', 'services.panel']);
const DeclarativeControlSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), settingId: PluginContributionLocalIdSchema }).strict(),
  z.object({ kind: z.literal('number'), settingId: PluginContributionLocalIdSchema }).strict(),
  z.object({ kind: z.literal('toggle'), settingId: PluginContributionLocalIdSchema }).strict(),
  z.object({ kind: z.literal('select'), settingId: PluginContributionLocalIdSchema, options: z.array(z.object({ value: PluginJsonValueV2Schema, label: PluginLocalizedStringV2Schema }).strict()) }).strict(),
  z.object({ kind: z.literal('secret'), settingId: PluginContributionLocalIdSchema }).strict(),
]);
export const PluginDeclarativeNodeV2Schema: z.ZodType<unknown> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: PluginLocalizedStringV2Schema, tone: z.enum(['default', 'muted', 'success', 'warning', 'danger']).optional() }).strict(),
  z.object({ kind: z.literal('markdown'), text: PluginLocalizedStringV2Schema }).strict(),
  z.object({ kind: z.literal('stack'), direction: z.enum(['vertical', 'horizontal']).optional(), gap: z.enum(['small', 'medium', 'large']).optional(), children: z.array(PluginDeclarativeNodeV2Schema) }).strict(),
  z.object({ kind: z.literal('group'), title: PluginLocalizedStringV2Schema.optional(), description: PluginLocalizedStringV2Schema.optional(), children: z.array(PluginDeclarativeNodeV2Schema) }).strict(),
  z.object({ kind: z.literal('field'), label: PluginLocalizedStringV2Schema, description: PluginLocalizedStringV2Schema.optional(), control: DeclarativeControlSchema }).strict(),
  z.object({ kind: z.literal('status'), label: PluginLocalizedStringV2Schema, value: PluginLocalizedStringV2Schema, tone: z.enum(['default', 'muted', 'success', 'warning', 'danger']).optional() }).strict(),
  z.object({ kind: z.literal('action'), action: PluginContributionReferenceV2Schema, label: PluginLocalizedStringV2Schema, variant: z.enum(['primary', 'secondary', 'destructive']).optional(), input: PluginJsonValueV2Schema.optional() }).strict(),
]));
const RequiredMethodsSchema = z.array(HostMethodSchema).optional();
export const PluginUiRendererV2Schema = z.discriminatedUnion('kind', [
  z.object({ id: PluginContributionLocalIdSchema, kind: z.literal('reactNative'), artifact: PluginContributionLocalIdSchema, requiredHostMethods: RequiredMethodsSchema }).strict(),
  z.object({ id: PluginContributionLocalIdSchema, kind: z.literal('hostedWeb'), source: z.union([
    z.object({ kind: z.literal('artifact'), artifact: PluginContributionLocalIdSchema }).strict(),
    z.object({ kind: z.literal('url'), url: z.string().url(), allowedOrigins: z.array(z.string().url()).min(1) }).strict(),
  ]), requiredHostMethods: RequiredMethodsSchema }).strict(),
  z.object({ id: PluginContributionLocalIdSchema, kind: z.literal('declarative'), root: PluginDeclarativeNodeV2Schema, requiredHostMethods: RequiredMethodsSchema }).strict(),
]);
export type PluginUiRendererV2 = z.infer<typeof PluginUiRendererV2Schema>;
export const PluginUiViewV2Schema = z.object({
  id: PluginContributionLocalIdSchema, placement: PlacementSchema, renderer: PluginContributionLocalIdSchema,
  fallbackRenderers: z.array(PluginContributionLocalIdSchema).optional(), title: PluginLocalizedStringV2Schema.optional(),
}).strict();
export type PluginUiViewV2 = z.infer<typeof PluginUiViewV2Schema>;
export const PluginUiTranslationBundleV2Schema = z.object({
  locale: z.string().min(2).refine((value) => {
    try { return Intl.getCanonicalLocales(value)[0] === value; } catch { return false; }
  }, 'Locale must be a canonical BCP 47 language tag.'),
  messages: z.record(z.string(), z.string()),
}).strict();
export type PluginUiTranslationBundleV2 = z.infer<typeof PluginUiTranslationBundleV2Schema>;
export const PluginUiContributionsV2Schema = z.object({
  views: z.array(PluginUiViewV2Schema).default([]),
  renderers: z.array(PluginUiRendererV2Schema).default([]),
  translations: z.array(PluginUiTranslationBundleV2Schema).default([]),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.translations.forEach((translation, index) => {
    if (seen.has(translation.locale)) ctx.addIssue({ code: 'custom', path: ['translations', index, 'locale'], message: 'Duplicate translation locale.' });
    seen.add(translation.locale);
  });
}).default({ views: [], renderers: [], translations: [] });
export type PluginUiContributionsV2 = z.infer<typeof PluginUiContributionsV2Schema>;
