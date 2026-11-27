import type { z } from '../../zodRuntimePolicy.js';

import type { ActionInputFieldHint, PreNormalizedActionSpec } from '../actionSpecs.js';

type ApprovalReferenceForField = NonNullable<NonNullable<PreNormalizedActionSpec['approvalPresentation']>['referenceForField']>;

export function homeAccountApprovalReferenceForField(accountPath: string): ApprovalReferenceForField {
  return (path, value) => path === accountPath && typeof value === 'string' && value.trim()
    ? { kind: 'homeAccount', id: value.trim() }
    : undefined;
}

export function homeDomainApprovalField(
  path: string,
  title: string,
  options: Partial<Pick<ActionInputFieldHint, 'widget' | 'required' | 'listSeparator'>> = {},
): ActionInputFieldHint {
  return { path, title, widget: options.widget ?? 'text', ...options };
}

/**
 * The one row shape for the Home family.
 *
 * Each row is the single declaration of its intent: the path it travels, the
 * strict input it accepts and the strict result it returns. Hosts derive their
 * lookup from the registered rows rather than from a parallel table, so a path
 * or codec can never disagree with the catalog.
 *
 * This base row leaves `mcp` off. External MCP exposure needs its own
 * supported authority and approval contract; the in-session Agent surface is the
 * exposure the Home family is actually admitted on today, and adding a tool name
 * would enable the external bridge before that contract exists. Explicit
 * organization-resource rows override this default through their consumed
 * Home transport and the canonical Action authority/approval policy.
 */
type HomeDomainActionRowInput<
  TActionId extends PreNormalizedActionSpec['id'],
  TInputSchema extends z.ZodMiniType,
  TOutputSchema extends z.ZodMiniType,
> = Readonly<{
  id: TActionId;
  approval: PreNormalizedActionSpec['approval'];
  approvalPolicy?: PreNormalizedActionSpec['approvalPolicy'];
  approvalPresentation?: PreNormalizedActionSpec['approvalPresentation'];
  title: string;
  confirmVerb?: PreNormalizedActionSpec['confirmVerb'];
  irreversible?: PreNormalizedActionSpec['irreversible'];
  description: string;
  safety: 'safe' | 'danger';
  sideEffectClass: 'read' | 'write' | 'external' | 'danger';
  cliPath: readonly string[];
  inputSchema: TInputSchema;
  /** Sealed effect grammar when the Action input describes authored plaintext. */
  wireInputSchema?: z.ZodMiniType;
  outputSchema: TOutputSchema;
  /**
   * The REST verb this row travels on. POST is the default because the Home
   * families are intent-shaped; the directory family is resource-shaped and
   * declares its own verb per row.
   */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  preservePathFieldsInBody?: true;
  path: string;
  /**
   * The generated-SDK method path, when the derived one would nest under a
   * sibling Action. An id that is the exact prefix of another id — `…remove`
   * beside `…remove.preview` — cannot be both a callable method and a
   * namespace, so the shorter one takes an explicit verb leaf. This changes the
   * generated SDK shape only: the Action id, its route and its authorization
   * are untouched.
   */
  sdkMethod?: string;
  /**
   * Whether an autonomous Agent may invoke the Action directly. Human UI/CLI,
   * public API and trusted-plugin exposure remain independently derived.
   */
  agent?: boolean;
  mcp?: boolean;
  voiceClientToolName?: string;
  inputHints?: PreNormalizedActionSpec['inputHints'];
  projectObservationInput?: PreNormalizedActionSpec['projectObservationInput'];
  projectObservationOutput?: PreNormalizedActionSpec['projectObservationOutput'];
  approvalInputCustody?: PreNormalizedActionSpec['approvalInputCustody'];
  approvalResultCustody?: PreNormalizedActionSpec['approvalResultCustody'];
  accountAuthorityRetirementStatuses?: PreNormalizedActionSpec['accountAuthorityRetirementStatuses'];
}>;

export type HomeDomainActionRow<
  TActionId extends PreNormalizedActionSpec['id'],
  TInputSchema extends z.ZodMiniType,
  TOutputSchema extends z.ZodMiniType,
  TRequiredAuthority extends NonNullable<PreNormalizedActionSpec['requiredAuthority']> = 'account_automation',
> = Omit<PreNormalizedActionSpec, 'id' | 'inputSchema' | 'outputSchema' | 'requiredAuthority' | 'executionPlacement'> & Readonly<{
  id: TActionId;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  requiredAuthority: TRequiredAuthority;
  executionPlacement: 'account';
}>;

export function homeDomainActionRow<
  const TActionId extends PreNormalizedActionSpec['id'],
  const TInputSchema extends z.ZodMiniType,
  const TOutputSchema extends z.ZodMiniType,
>(spec: HomeDomainActionRowInput<TActionId, TInputSchema, TOutputSchema>): HomeDomainActionRow<
  TActionId,
  TInputSchema,
  TOutputSchema,
  'account_automation'
> {
  // Authored fields describe the domain's safe approval reading. Schema
  // completion is input grammar, not a demand to disclose bearers, versions,
  // pagination or retry keys in that reading.
  const review = spec.approvalPresentation;
  const authoredHints = spec.inputHints;
  const approvalPresentation = authoredHints?.fields.length && !review?.inputHints && !review?.inputSchema && !review?.projectInput
    ? {
      summary: () => null,
      ...review,
      inputHints: { ...authoredHints, fields: authoredHints.fields.filter(field => field.widget !== 'secret') },
    }
    : review;
  return {
    id: spec.id, approval: spec.approval,
    ...(spec.approvalPolicy ? { approvalPolicy: spec.approvalPolicy } : {}),
    ...(approvalPresentation ? { approvalPresentation } : {}),
    title: spec.title,
    ...(spec.confirmVerb === undefined ? {} : { confirmVerb: spec.confirmVerb }),
    ...(spec.irreversible === undefined ? {} : { irreversible: spec.irreversible }),
    description: spec.description,
    safety: spec.safety,
    // The Home transaction rechecks the actual principal's capabilities; this
    // floor only says the operation is Account-scoped automation, never that a
    // holder of an Account bearer may perform it.
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: {
      commands: [{ path: [...spec.cliPath], visibility: 'canonical' }],
      acceptsServerId: true,
      requiresServerId: true,
    },
    ...(spec.sdkMethod || spec.voiceClientToolName ? { bindings: {
      ...(spec.sdkMethod ? { sdkMethod: spec.sdkMethod } : {}),
      ...(spec.voiceClientToolName ? { voiceClientToolName: spec.voiceClientToolName } : {}),
    } } : {}),
    placements: [],
    surfaces: { ui: true, voice: Boolean(spec.voiceClientToolName), agent: spec.agent ?? true, mcp: spec.mcp ?? false, cli: true, rpc: false },
    sideEffectClass: spec.sideEffectClass,
    inputHints: spec.inputHints ?? { fields: [] },
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    ...(spec.projectObservationInput ? { projectObservationInput: spec.projectObservationInput } : {}),
    ...(spec.projectObservationOutput ? { projectObservationOutput: spec.projectObservationOutput } : {}),
    ...(spec.approvalInputCustody ? { approvalInputCustody: spec.approvalInputCustody } : {}),
    ...(spec.approvalResultCustody ? { approvalResultCustody: spec.approvalResultCustody } : {}),
    ...(spec.accountAuthorityRetirementStatuses ? { accountAuthorityRetirementStatuses: spec.accountAuthorityRetirementStatuses } : {}),
    serverTransport: { method: spec.method ?? 'POST', path: spec.path,
      ...(spec.wireInputSchema ? { inputSchema: spec.wireInputSchema } : {}),
      ...(spec.preservePathFieldsInBody ? { preservePathFieldsInBody: true as const } : {}) },
  };
}
