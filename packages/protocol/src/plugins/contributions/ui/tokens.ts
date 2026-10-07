import { z } from 'zod';

export const PLUGIN_UI_ICON_TOKENS_V1 = [
  'action',
  'browser',
  'copy',
  'file',
  'globe',
  'info',
  'preview',
  'refresh',
  'settings',
  'terminal',
  'warning',
  'add',
  'back',
  'check',
  'close',
  'error',
  'external',
  'forward',
  'more',
  'search',
  'change-open',
  'change-complete',
  // Kinds and marks a triage-style list needs to tell entries apart at a
  // glance: an issue, an error group, and a pinned entry.
  'issue',
  'bug',
  'pin',
  // A destination about external conversations (two overlapping speech
  // bubbles, distinct from a Session's single bubble), and a paused state mark.
  'conversations',
  'waveform',
  'desktop',
  'pause',
  // Whole-surface failures distinguish temporary unavailability from denied access.
  'failure',
  'unavailable',
  'denied',
  // Why an entry is in front of the reader (an attention chip's leading mark): a review asked of them, an
  // agent or person waiting on them, an error escalating, a change ready to merge, a mention, an assignment,
  // something new in a release, and waiting on someone else.
  'review',
  'attention',
  'escalating',
  'merge-ready',
  'mention',
  'assigned',
  'new',
  'waiting',
] as const;

export const PluginUiIconTokenV1Schema = z.enum(PLUGIN_UI_ICON_TOKENS_V1);
export type PluginUiIconTokenV1 = z.infer<typeof PluginUiIconTokenV1Schema>;

export const PluginUiToneV1Schema = z.enum([
  'neutral',
  'info',
  'success',
  'warning',
  'danger',
  'accent',
]);
export type PluginUiToneV1 = z.infer<typeof PluginUiToneV1Schema>;

export const PluginUiDisplayV1Schema = z.object({
  titleKey: z.string().trim().min(1),
  descriptionKey: z.string().trim().min(1).optional(),
  labelKey: z.string().trim().min(1).optional(),
  iconToken: PluginUiIconTokenV1Schema.optional(),
  tone: PluginUiToneV1Schema.optional(),
  developerFallback: z.string().trim().min(1).optional(),
}).strict();
export type PluginUiDisplayV1 = z.infer<typeof PluginUiDisplayV1Schema>;
