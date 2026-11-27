import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { AccountPlanResponseV1Schema } from '../../plans/accountPlanV1.js';
import { SupporterCodeV1Schema } from '../../plans/supporterV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

const EmptyObjectSchema = z.strictObject({});
const nonEmpty = z.string().check(z.minLength(1));
const trimmed = z.string().check(z.trim(), z.minLength(1));
const natural = z.int().check(z.minimum(0));
const BillingCheckoutOpenInputSchema = z.strictObject({
  offerId: trimmed,
  interval: z.enum(['month', 'year', 'once']),
  amountMinor: z.optional(z.int().check(z.positive())),
});
const BillingManageOpenInputSchema = z.strictObject({ target: z.optional(trimmed) });
const SupporterCodeApplyInputSchema = lazyZodSchema(() => z.strictObject({ code: SupporterCodeV1Schema }));
const SupporterProfileUpdateInputSchema = z.strictObject({
  publicName: z.optional(z.nullable(trimmed)),
  publicLink: z.optional(z.nullable(z.url().check(z.startsWith('https://')))),
  label: z.optional(z.boolean()),
});
const SupporterRingSetInputSchema = z.strictObject({ visible: z.boolean() });
const SupporterAskCloseInputSchema = z.strictObject({ ask: z.enum(['star', 'supporter_prompt']) });
const AppIconSetInputSchema = z.strictObject({ iconId: trimmed });
const SessionRetentionLeavingDismissInputSchema = z.strictObject({ through: natural });
const SessionExportInputSchema = z.strictObject({
  sessionId: z.optional(nonEmpty),
  all: z.optional(z.literal(true)),
  seqs: z.optional(z.array(natural).check(z.minLength(1))),
  format: z.enum(['markdown', 'json']),
}).check(z.superRefine((value, ctx) => {
  if ((value.sessionId === undefined) === (value.all === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'provide exactly one of sessionId or all', path: ['sessionId'] });
  }
  if (value.seqs !== undefined && value.sessionId === undefined) {
    ctx.addIssue({ code: 'custom', message: 'seqs requires sessionId', path: ['seqs'] });
  }
}));
export type SessionExportInput = z.infer<typeof SessionExportInputSchema>;
const NoticedRetentionRuleSchema = z.object({ retentionDays: natural, noticeDays: natural, floorAt: natural });
const RetentionTickSchema = z.object({ atMs: natural, messages: natural, pinned: z.boolean(), leaving: z.boolean() });
const UI_SURFACES = { ui: true, voice: false, agent: false, mcp: false, cli: false, rpc: false, api: false } as const;

export const PLANS_ACTION_SPECS = lazyActionSpecArray(() => [
  {
    id: 'account.plan.get',
    title: 'Get account plan',
    description: 'Read the account plan, its limits and the offers available on this server.',
    safety: 'safe',
    sideEffectClass: 'read',
    approval: { result: 'required' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    outputSchema: AccountPlanResponseV1Schema,
    inputSchema: EmptyObjectSchema,
    inputHints: { title: 'Get account plan', fields: [] },
  },
  {
    id: 'billing.checkout.open',
    title: 'Open checkout',
    description: 'Open checkout for an offer on this device. Spends money, so agents ask first by default.',
    safety: 'safe',
    sideEffectClass: 'external',
    approval: { result: 'none' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    inputSchema: BillingCheckoutOpenInputSchema,
    inputHints: {
      title: 'Open checkout',
      fields: [
        { path: 'offerId', title: 'Offer', widget: 'text', required: true },
        {
          path: 'interval',
          title: 'Interval',
          widget: 'select',
          required: true,
          options: [
            { value: 'month', label: 'Monthly' },
            { value: 'year', label: 'Yearly' },
            { value: 'once', label: 'Once' },
          ],
        },
        { path: 'amountMinor', title: 'Amount (minor units)', widget: 'text' },
      ],
    },
  },
  {
    id: 'billing.manage.open',
    title: 'Manage billing',
    description: 'Open the billing provider’s email-code portal on this device. The result never carries the portal URL.',
    safety: 'safe',
    sideEffectClass: 'external',
    approval: { result: 'none' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    inputSchema: BillingManageOpenInputSchema,
    inputHints: {
      title: 'Manage billing',
      fields: [{ path: 'target', title: 'Target', widget: 'text' }],
    },
  },
  {
    id: 'billing.restore',
    title: 'Restore purchases',
    description: 'Re-read store purchases on this device. Unsupported on web.',
    safety: 'safe',
    sideEffectClass: 'write',
    approval: { result: 'none' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    inputSchema: EmptyObjectSchema,
    inputHints: { title: 'Restore purchases', fields: [] },
  },
  {
    id: 'billing.refresh',
    title: 'Refresh billing',
    description: 'Re-check purchases for this account with the billing provider.',
    safety: 'safe',
    sideEffectClass: 'write',
    approval: { result: 'none' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    inputSchema: EmptyObjectSchema,
    inputHints: { title: 'Refresh billing', fields: [] },
  },
  {
    id: 'supporter.code.apply',
    title: 'Apply supporter code',
    description: 'Apply a supporter code on this device. Agents never take the code.',
    safety: 'safe',
    sideEffectClass: 'write',
    approval: { result: 'none' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    inputSchema: SupporterCodeApplyInputSchema,
    inputHints: {
      title: 'Apply supporter code',
      fields: [{ path: 'code', title: 'Supporter code', widget: 'text', required: true }],
    },
  },
  {
    id: 'supporter.profile.get',
    title: 'Get supporter profile',
    description: 'Read the supporter profile: public name, public link and issue label.',
    safety: 'safe',
    sideEffectClass: 'read',
    approval: { result: 'required' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    outputSchema: SupporterProfileUpdateInputSchema,
    inputSchema: EmptyObjectSchema,
    inputHints: { title: 'Get supporter profile', fields: [] },
  },
  {
    id: 'supporter.profile.update',
    title: 'Update supporter profile',
    description: 'Change what the public supporter wall and credits show. Null turns a field off. Public, so agents ask first by default.',
    safety: 'safe',
    sideEffectClass: 'write',
    approval: { result: 'none' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    inputSchema: SupporterProfileUpdateInputSchema,
    inputHints: {
      title: 'Update supporter profile',
      fields: [
        { path: 'publicName', title: 'Public name', widget: 'text' },
        { path: 'publicLink', title: 'Public link', widget: 'text' },
        { path: 'label', title: 'Supporter issue label', widget: 'boolean' },
      ],
    },
  },
  {
    id: 'supporter.credits.list',
    title: 'List supporter credits',
    description: 'List the public supporter credits.',
    safety: 'safe',
    sideEffectClass: 'read',
    approval: { result: 'required' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    outputSchema: z.object({ supporters: z.array(z.object({ name: nonEmpty, link: z.optional(z.url()) })) }),
    inputSchema: EmptyObjectSchema,
    inputHints: { title: 'List supporter credits', fields: [] },
  },
  {
    id: 'supporter.ring.set',
    title: 'Show supporter ring',
    description: 'Show or hide the supporter ring others see on your avatar. Agents ask first by default.',
    safety: 'safe',
    sideEffectClass: 'write',
    approval: { result: 'none' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    inputSchema: SupporterRingSetInputSchema,
    inputHints: {
      title: 'Show supporter ring',
      fields: [{ path: 'visible', title: 'Visible', widget: 'boolean', required: true }],
    },
  },
  {
    id: 'supporter.github.link',
    title: 'Link GitHub for supporter perks',
    description: 'Link a GitHub account for the supporter issue label and sponsor perks. UI only.',
    safety: 'safe',
    sideEffectClass: 'external',
    approval: { result: 'none' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    inputSchema: EmptyObjectSchema,
    inputHints: { title: 'Link GitHub', fields: [] },
  },
  {
    id: 'supporter.ask.close',
    title: 'Close supporter ask',
    description: 'Close the star ask or the supporter prompt for this account for good.',
    safety: 'safe',
    sideEffectClass: 'write',
    approval: { result: 'none' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    inputSchema: SupporterAskCloseInputSchema,
    inputHints: {
      title: 'Close supporter ask',
      fields: [
        {
          path: 'ask',
          title: 'Ask',
          widget: 'select',
          required: true,
          options: [
            { value: 'star', label: 'Star ask' },
            { value: 'supporter_prompt', label: 'Supporter prompt' },
          ],
        },
      ],
    },
  },
  {
    id: 'github.star.status',
    title: 'Get GitHub star status',
    description: 'Check whether the machine GitHub CLI account has starred the Happier repository.',
    safety: 'safe',
    sideEffectClass: 'read',
    approval: { result: 'required' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    outputSchema: z.object({ starred: z.boolean() }),
    inputSchema: EmptyObjectSchema,
    inputHints: { title: 'Get GitHub star status', fields: [] },
  },
  {
    // UI only, never agent-reachable: GitHub's terms name automated starring, and approval
    // defaults are user-changeable, so an agent path could become automatic.
    id: 'github.star',
    title: 'Star Happier on GitHub',
    description: 'Star the Happier repository through the machine GitHub CLI. UI only.',
    safety: 'safe',
    sideEffectClass: 'external',
    approval: { result: 'none' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    inputSchema: EmptyObjectSchema,
    inputHints: { title: 'Star Happier on GitHub', fields: [] },
  },
  {
    id: 'app.icon.list',
    title: 'List app icons',
    description: 'List the app icons on this device, with locked icons marked.',
    safety: 'safe',
    sideEffectClass: 'read',
    approval: { result: 'required' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    outputSchema: z.object({ icons: z.array(z.object({ id: nonEmpty, name: nonEmpty })) }),
    inputSchema: EmptyObjectSchema,
    inputHints: { title: 'List app icons', fields: [] },
  },
  {
    id: 'app.icon.set',
    title: 'Set app icon',
    description: 'Set the app icon on this device.',
    safety: 'safe',
    sideEffectClass: 'write',
    approval: { result: 'none' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    inputSchema: AppIconSetInputSchema,
    inputHints: {
      title: 'Set app icon',
      fields: [{ path: 'iconId', title: 'Icon', widget: 'text', required: true }],
    },
  },
  {
    id: 'session.retention.leaving.list',
    title: 'List sessions leaving',
    description: 'List sessions due to leave the cloud under the retention policy, with titles decrypted on this device.',
    safety: 'safe',
    sideEffectClass: 'read',
    approval: { result: 'required' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    outputSchema: z.object({ count: natural, sessions: z.array(z.object({ id: nonEmpty, leavesAt: natural, title: z.nullable(z.string()) })) }),
    inputSchema: EmptyObjectSchema,
    inputHints: { title: 'List sessions leaving', fields: [] },
  },
  {
    id: 'session.retention.leaving.dismiss',
    title: 'Dismiss leaving notice',
    description: 'Hide the sessions-leaving notice on this device until the given time.',
    safety: 'safe',
    sideEffectClass: 'write',
    approval: { result: 'none' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    inputSchema: SessionRetentionLeavingDismissInputSchema,
    inputHints: {
      title: 'Dismiss leaving notice',
      fields: [{ path: 'through', title: 'Dismiss through (epoch ms)', widget: 'text', required: true }],
    },
  },
  {
    id: 'session.retention.summary.get',
    title: 'Get retention summary',
    description: 'Read the account session retention summary.',
    safety: 'safe',
    sideEffectClass: 'read',
    approval: { result: 'required' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    outputSchema: z.object({ rule: z.nullable(NoticedRetentionRuleSchema), windowDays: natural, sessions: natural, ticks: z.array(RetentionTickSchema), pinnedOlderThanCutoff: natural }),
    inputSchema: EmptyObjectSchema,
    inputHints: { title: 'Get retention summary', fields: [] },
  },
  {
    id: 'session.export',
    title: 'Export sessions',
    description: 'Export one session, selected messages of it, or every session as a Markdown or JSON file on this device.',
    safety: 'safe',
    sideEffectClass: 'read',
    approval: { result: 'required' },
    placements: [],
    executionPlacement: 'client',
    surfaces: UI_SURFACES,
    outputSchema: z.object({ saved: z.boolean(), failedSessionIds: z.optional(z.array(nonEmpty)), skippedExternalCount: z.optional(natural) }),
    inputSchema: SessionExportInputSchema,
    inputHints: {
      title: 'Export sessions',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'all', title: 'Every session', widget: 'boolean' },
        { path: 'seqs', title: 'Message seqs', widget: 'text_list', listSeparator: 'comma' },
        {
          path: 'format',
          title: 'Format',
          widget: 'select',
          required: true,
          options: [
            { value: 'markdown', label: 'Markdown' },
            { value: 'json', label: 'JSON' },
          ],
        },
      ],
    },
  },
] as const satisfies readonly PreNormalizedActionSpec[]);
