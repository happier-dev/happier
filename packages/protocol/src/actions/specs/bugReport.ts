export { BUG_REPORT_SUBMISSION_ACTION_IDS } from './bugReportActionIdsV1.js';
import { PassthroughEmptyObjectSchema } from './common.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { DAEMON_ADMIN_RPC_SURFACES, DAEMON_ADMIN_INPUT_HINTS } from './common.js';
import type { PreNormalizedActionSpec } from './definition.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { BUG_REPORT_DEFAULT_ISSUE_OWNER, BUG_REPORT_DEFAULT_ISSUE_REPO } from '../../bugs/reports/types.js';

// This is the submission envelope, not a second form-validation policy. The
// answering client's existing draft owner validates required fields and consent.
export const BugReportDraftInputSchema = lazyZodSchema(() => z.strictObject({
  title: z.string(), summary: z.string(), reporterGithubUsername: z.optional(z.string()),
  currentBehavior: z.optional(z.string()), expectedBehavior: z.optional(z.string()),
  reproductionStepsText: z.string(), whatChangedRecently: z.string(),
  frequency: z.optional(z.enum(['always', 'often', 'sometimes', 'once'])),
  severity: z.optional(z.enum(['blocker', 'high', 'medium', 'low'])),
  environment: z.strictObject({
    appVersion: z.string(), platform: z.string(),
    osVersion: z.optional(z.string()), deviceModel: z.optional(z.string()),
    serverUrl: z.optional(z.string()), serverVersion: z.optional(z.string()),
    deploymentType: z.enum(['cloud', 'self-hosted', 'enterprise']),
  }),
  includeDiagnostics: z.boolean(), diagnosticsKinds: z.optional(z.array(z.string())),
  acceptedPrivacyNotice: z.boolean(),
}));

export const BugReportSubmitInputSchema = lazyZodSchema(() => z.strictObject({
  draft: BugReportDraftInputSchema,
  destination: z.strictObject({
    providerUrl: z.nullable(z.string().check(z.url(), z.refine(value => {
      const url = new URL(value);
      return !url.username && !url.password;
    }, 'Report destination must not contain credentials'))),
    issueOwner: z.literal(BUG_REPORT_DEFAULT_ISSUE_OWNER),
    issueRepo: z.literal(BUG_REPORT_DEFAULT_ISSUE_REPO),
    existingIssueNumber: z.optional(z.number().check(z.int(), z.positive())),
  }),
  pastedCliDoctorSnapshotJson: z.optional(z.string()),
}));

export const BugReportSubmitOutputSchema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('fallback') }),
  z.strictObject({ mode: z.literal('submitted'), reportId: z.string().check(z.minLength(1)), issueNumber: z.number().check(z.int(), z.positive()),
    issueUrl: z.string().check(z.url()), artifactCount: z.number().check(z.int(), z.nonnegative()) }),
]));
export type BugReportDraftInput = z.infer<typeof BugReportDraftInputSchema>;
export type BugReportSubmitInput = z.infer<typeof BugReportSubmitInputSchema>;
export type BugReportSubmitOutput = z.infer<typeof BugReportSubmitOutputSchema>;

/** Only the declared review operands enter observation or durable approval custody. */
export function projectBugReportSubmitInput(input: unknown) {
  const parsed = BugReportSubmitInputSchema.safeParse(input);
  if (!parsed.success) return {};
  return {
    draft: {
      includeDiagnostics: parsed.data.draft.includeDiagnostics,
      diagnosticsKinds: parsed.data.draft.diagnosticsKinds ?? 'Configured diagnostic defaults',
      acceptedPrivacyNotice: parsed.data.draft.acceptedPrivacyNotice,
    },
    ...(parsed.data.pastedCliDoctorSnapshotJson ? { pastedCliDoctorSnapshotJson: '[supplied privately]' } : {}),
    destination: parsed.data.destination,
  };
}

export const BugReportGetLogTailInputSchema = lazyZodSchema(() => z.looseObject({
  path: z.optional(z.string().check(z.minLength(1))),
  maxBytes: z.optional(z.number().check(z.int(), z.minimum(1024), z.maximum(1_000_000))),
}));
export const BugReportUploadArtifactInputSchema = lazyZodSchema(() => z.looseObject({
  uploadUrl: z.optional(z.string()),
}));

export const BUG_REPORT_ACTION_SPECS = Object.freeze([
  {
    id: 'bugreport.submit', approvalPolicy: { uiConfirmation: 'policy' }, approval: {result: 'required'},
    confirmVerb: { key: 'common.send', fallback: 'Send' }, irreversible: true,
    title: 'Submit bug report',
    description: 'Submit the report and selected diagnostics to the configured report service and Happier issue destination under your approval policy. Crash reporting and replay follow the existing crash-report preference separately.',
    safety: 'danger',
    sideEffectClass: 'external',
    requiredAuthority: 'account_automation',
    executionPlacement: 'client',
    placements: [],
    bindings: { mcpToolName: 'bugreport_submit' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: BugReportSubmitInputSchema,
    outputSchema: BugReportSubmitOutputSchema,
    // The raw report and pasted diagnostics stay on this live invocation.
    // Approval can replay only that retained input through the same owner.
    approvalInputCustody: 'live_only',
    projectObservationInput: projectBugReportSubmitInput,
    approvalPresentation: { summary: () => 'Submit this report and selected diagnostic attachments to the reviewed destination. Ask-first follows your approval policy. Crash reporting and replay retain their separate preference.' },
    inputHints: { fields: [
      { path: 'draft.title', title: 'Report title', widget: 'text', required: true },
      { path: 'draft.summary', title: 'Summary', widget: 'text', required: true },
      { path: 'draft.includeDiagnostics', title: 'Include diagnostics', widget: 'text', required: true },
      { path: 'draft.diagnosticsKinds', title: 'Diagnostic selections', widget: 'json' },
      { path: 'draft.acceptedPrivacyNotice', title: 'Privacy notice acknowledged', widget: 'text', required: true },
      { path: 'pastedCliDoctorSnapshotJson', title: 'Pasted diagnostics', widget: 'secret' },
      { path: 'destination', title: 'Exact report destination', widget: 'json', required: true },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'bugreport.collectDiagnostics', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Collect bug report diagnostics',
    description: 'Collect bounded, redacted daemon diagnostics for a bug report.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.collectDiagnostics' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: PassthroughEmptyObjectSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'bugreport.getLogTail', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Read bug report log tail',
    description: 'Read a bounded daemon log tail from diagnostics-approved candidate paths.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.getLogTail' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: BugReportGetLogTailInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'bugreport.uploadArtifact', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Upload bug report artifact',
    description: 'Return daemon-side bug report artifact upload availability without exposing secret material.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.uploadArtifact' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'none',
    outputSchema: StrictJsonValueSchema,
    inputSchema: BugReportUploadArtifactInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  } satisfies PreNormalizedActionSpec,
] as const);
