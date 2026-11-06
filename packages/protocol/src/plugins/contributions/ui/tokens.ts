import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

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
  // The two arrangements of one collection (a segmented View control): rows, and status columns.
  'list',
  'board',
  // What narrows and orders a collection, folded behind one round toolbar button on a phone.
  'filter',
  // A PR the agent is watching for updates (an open eye), and linking one thing to another.
  'watch',
  'link',
  // Forge objects a release or CI page names: a tag, a release asset, a branch and a commit; downloading
  // an asset, a locked (immutable) release, running and stopping a job, handing work to a session and
  // generating text from changes.
  'tag',
  'asset',
  'branch',
  'commit',
  'download',
  'locked',
  'run',
  'stop',
  'send',
  'generate',
  // A CI workflow and its runs (a play mark in a ring), distinct from a Project script's bare play.
  'workflow',
  // Skipped or neutral CI work: the status owner's circle-and-dash mark.
  'neutral',
  'task',
  // Marks a person gives a Session Section, drawn exactly by a Space saved from that Section.
  'rocket',
  'star',
  'flag',
  'target',
  'flask',
  'book',
  'heart',
  // A security finding (a Dependabot or code scanning alert), and editing something the reader wrote.
  'shield',
  'edit',
] as const;

export const PluginUiIconTokenV1Schema = lazyZodSchema(() => z.enum(PLUGIN_UI_ICON_TOKENS_V1));
export type PluginUiIconTokenV1 = z.infer<typeof PluginUiIconTokenV1Schema>;

export const PluginUiToneV1Schema = lazyZodSchema(() => z.enum([
  'neutral',
  'info',
  'success',
  'warning',
  'danger',
  'accent',
]));
export type PluginUiToneV1 = z.infer<typeof PluginUiToneV1Schema>;

export const PluginUiDisplayV1Schema = lazyZodSchema(() => z.strictObject({
  titleKey: z.string().check(z.trim(), z.minLength(1)),
  descriptionKey: z.optional(z.string().check(z.trim(), z.minLength(1))),
  labelKey: z.optional(z.string().check(z.trim(), z.minLength(1))),
  iconToken: z.optional(PluginUiIconTokenV1Schema),
  tone: z.optional(PluginUiToneV1Schema),
  developerFallback: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export type PluginUiDisplayV1 = z.infer<typeof PluginUiDisplayV1Schema>;
