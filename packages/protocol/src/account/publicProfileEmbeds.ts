import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PublicProfileReadResultV1Schema, type PublicProfileReadResultV1 } from './publicProfilePublication.js';

const presentation = { theme: z.enum(['auto', 'light', 'dark']), syntax: z.enum(['url', 'markdown', 'html', 'picture']) };
export const PublicEmbedInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('profile_link'), ...presentation }),
  z.strictObject({ kind: z.literal('card'), ...presentation }),
  z.strictObject({ kind: z.literal('badge'), metric: z.enum(['tokens', 'agent-time', 'merged-prs', 'streak', 'peak-parallel']), ...presentation }),
]));
export type PublicEmbedInputV1 = z.infer<typeof PublicEmbedInputV1Schema>;
export const PublicEmbedResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), url: z.string().check(z.url()), snippet: z.string(), accessibleLabel: z.string() }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.enum(['not_published', 'field_hidden', 'service_unavailable']) }),
]));
export type PublicEmbedResultV1 = z.infer<typeof PublicEmbedResultV1Schema>;

function html(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function markdown(value: string): string {
  return value.replace(/[\\`*_[\]{}()#+.!|<>-]/g, '\\$&');
}

/** Formatting receives the currently admitted view, never an owner record or private Usage. */
export function buildPublicProfileEmbed(rawSource: PublicProfileReadResultV1, rawInput: PublicEmbedInputV1): PublicEmbedResultV1 {
  const source = PublicProfileReadResultV1Schema.parse(rawSource);
  const input = PublicEmbedInputV1Schema.parse(rawInput);
  if (source.kind !== 'published') return { kind: 'unavailable', reason: 'not_published' };
  const { view } = source;
  if (input.kind === 'badge') {
    const facts = view.snapshot.facts;
    const value = { tokens: facts.tokens, 'agent-time': facts.agentTimeMs, 'merged-prs': facts.mergedPrs,
      streak: facts.currentStreakDays, 'peak-parallel': facts.peakParallel }[input.metric];
    if (value === undefined) return { kind: 'unavailable', reason: 'field_hidden' };
  }
  const accessibleLabel = `${input.kind === 'badge' ? `${input.metric} · ` : ''}@${view.handle} · ${view.service.displayName}`;
  const imageUrl = (theme: PublicEmbedInputV1['theme']) => {
    const url = new URL(input.kind === 'badge' ? `${view.urls.badgeBase}/${encodeURIComponent(input.metric)}.svg` : view.urls.card);
    url.searchParams.set('theme', theme);
    return url.toString();
  };
  const url = input.kind === 'profile_link' ? view.urls.page : imageUrl(input.theme);
  const link = html(view.urls.page);
  const alt = html(accessibleLabel);
  let snippet = url;
  if (input.syntax === 'markdown') {
    const label = markdown(accessibleLabel);
    snippet = input.kind === 'profile_link' ? `[${label}](<${view.urls.page}>)`
      : `[![${label}](<${url}>)](<${view.urls.page}>)`;
  } else if (input.syntax === 'html') {
    snippet = input.kind === 'profile_link' ? `<a href="${link}">${alt}</a>`
      : `<a href="${link}"><img src="${html(url)}" alt="${alt}"></a>`;
  } else if (input.syntax === 'picture') {
    snippet = `<a href="${link}"><picture>`
      + `<source media="(prefers-color-scheme: dark)" srcset="${html(imageUrl('dark'))}">`
      + `<source media="(prefers-color-scheme: light)" srcset="${html(imageUrl('light'))}">`
      + `<img src="${html(imageUrl(input.theme))}" alt="${alt}"></picture></a>`;
  }
  return { kind: 'ready', url, snippet, accessibleLabel };
}
