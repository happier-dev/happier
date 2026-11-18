/**
 * Vercel REST bodies for the account plan read, shaped after the API reference: `GET /v2/teams/{teamId}`
 * (vercel.com/docs/rest-api/reference/endpoints/teams/get-a-team, `billing.plan` ∈ hobby | pro | enterprise) and
 * `GET /v2/user` (`user.defaultTeamId`). These are NOT live captures: no QA token was used for them
 * (AUTO-FIX-W1, 2026-11-18). A sanitized capture replaces them at the release check "Vercel and Cloudflare account
 * plan lines"; the personal-account `defaultTeamId` path stays unconfirmed until then (PLAN Accepted imperfections).
 */
export const teamId = 'team_example';

export function teamResponse(plan: string) {
  return { id: teamId, slug: 'example', name: 'Example', billing: { plan } };
}

export const personalUserResponse = { user: { id: 'user_example', username: 'example', defaultTeamId: teamId } };

export const forbiddenResponse = { error: { code: 'forbidden', message: 'Not authorized' } };
