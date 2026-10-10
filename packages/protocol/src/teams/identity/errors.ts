import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const TeamIdentityErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'home_forbidden',
  'team_not_found',
  'team_forbidden',
  'team_authentication_required',
  'team_authentication_policy_unavailable',
  'team_authentication_unavailable',
  'team_identity_not_allowed',
  'identity_connection_not_found',
  'identity_connection_invalid',
  'identity_connection_conflict',
  'identity_connection_policy_in_use',
  'identity_connection_test_invalid',
  'identity_provider_unavailable',
  'identity_provider_in_use',
  'workos_platform_unavailable',
  'workos_organization_mismatch',
  'workos_connection_mismatch',
]));
export type TeamIdentityErrorCodeV1 = z.infer<typeof TeamIdentityErrorCodeV1Schema>;

export const TeamIdentityErrorV1Schema = lazyZodSchema(() => z.object({ error: TeamIdentityErrorCodeV1Schema }).strict());

export function teamIdentityErrorHttpStatusV1(
  error: TeamIdentityErrorCodeV1,
): 400 | 403 | 404 | 409 | 503 {
  switch (error) {
    case 'identity_connection_invalid':
      return 400;
    case 'team_forbidden':
    case 'home_forbidden':
    case 'team_authentication_required':
    case 'team_identity_not_allowed':
      return 403;
    case 'team_not_found':
    case 'identity_connection_not_found':
      return 404;
    case 'workos_platform_unavailable':
    case 'identity_provider_unavailable':
    case 'team_authentication_unavailable':
      return 503;
    default:
      return 409;
  }
}
