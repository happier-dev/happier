import { z } from 'zod';
import { FEATURE_ID_ENUM } from '../features/featureIds.js';
import { IrohEndpointDescriptorV1Schema } from '../connectivity/iroh/endpointDescriptorV1.js';
import { BuildDefaultProfileFields } from './buildDefaultProfile.js';
import { createServerUrlComparableKey } from '../server/urls/serverUrlComparableKey.js';

export const OrganizationPolicyV1Schema = z.object({
  schemaVersion: z.literal(1),
  organization: z.string().trim().min(1),
  supportUrl: z.string().url().refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
    } catch { return false; }
  }).optional(),
  features: z.object({ deny: z.array(z.enum(FEATURE_ID_ENUM)) }).strict().optional(),
  accountService: BuildDefaultProfileFields.accountService.unwrap().extend({ locked: z.boolean() }).optional(),
  home: BuildDefaultProfileFields.home.unwrap().omit({ webappUrl: true }).extend({ locked: z.boolean() }).optional(),
  personalHome: BuildDefaultProfileFields.personalHome.unwrap().extend({ locked: z.boolean() }).optional(),
  relays: z.object({
    policy: z.enum(['automatic', 'disabled']),
    urls: IrohEndpointDescriptorV1Schema.shape.relayUrls,
  }).strict().refine((value) => value.policy !== 'disabled' || !value.urls?.length, { path: ['urls'] }).optional(),
}).strict();

export type OrganizationPolicyV1 = Readonly<z.infer<typeof OrganizationPolicyV1Schema>>;
export type OrganizationPolicyLoadResult =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'loaded'; policy: OrganizationPolicyV1 }>
  | Readonly<{ status: 'invalid'; error: Readonly<{ path: string; code: string }> }>;
export type OrganizationPolicyField = 'accountService' | 'home' | 'personalHome';
export type OrganizationPolicyLock = Readonly<{ organization: string; supportUrl?: string }>;

/** Diagnostics contain schema locations and codes, never input values or Zod messages. */
export function parseOrganizationPolicyV1(raw: string): OrganizationPolicyLoadResult {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return { status: 'invalid', error: { path: '$', code: 'invalid_json' } }; }
  const parsed = OrganizationPolicyV1Schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { status: 'invalid', error: { path: issue.path.join('.') || '$', code: issue.code } };
  }
  return { status: 'loaded', policy: parsed.data };
}

export function getOrganizationPolicyLock(result: OrganizationPolicyLoadResult, field: OrganizationPolicyField): OrganizationPolicyLock | null {
  if (result.status !== 'loaded' || result.policy[field]?.locked !== true) return null;
  return { organization: result.policy.organization, ...(result.policy.supportUrl ? { supportUrl: result.policy.supportUrl } : {}) };
}

export class OrganizationPolicyActionError extends Error {
  readonly name = 'OrganizationPolicyActionError';
  constructor(
    readonly code: 'organization_policy_invalid' | 'organization_policy_locked' | 'organization_policy_off',
    readonly path: string,
    readonly issueCode?: string,
  ) {
    super(`${code} at ${path}${issueCode ? `: ${issueCode}` : ''}`);
  }
}

/** Selection writes fail closed; reads continue so existing work remains recoverable. */
export function assertOrganizationPolicyActionAllowed(result: OrganizationPolicyLoadResult, field: OrganizationPolicyField): void {
  if (result.status === 'invalid') throw new OrganizationPolicyActionError('organization_policy_invalid', result.error.path, result.error.code);
  if (getOrganizationPolicyLock(result, field)) throw new OrganizationPolicyActionError('organization_policy_locked', field);
}

/** Admission may keep using a locked endpoint; it cannot redirect its authority. */
export function assertOrganizationPolicyEndpointAllowed(result: OrganizationPolicyLoadResult, field: 'accountService' | 'home', endpoint: string): void {
  if (result.status === 'invalid') throw new OrganizationPolicyActionError('organization_policy_invalid', result.error.path, result.error.code);
  if (result.status !== 'loaded' || !result.policy[field]?.locked) return;
  try {
    if (createServerUrlComparableKey(endpoint) === createServerUrlComparableKey(result.policy[field].url)) return;
  } catch {
    // A malformed candidate cannot satisfy a locked endpoint.
  }
  throw new OrganizationPolicyActionError('organization_policy_locked', field);
}
