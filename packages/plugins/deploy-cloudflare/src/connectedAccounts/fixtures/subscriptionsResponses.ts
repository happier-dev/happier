/**
 * `GET /client/v4/accounts/{account_id}/subscriptions` response envelopes, shaped after Cloudflare's API reference
 * (developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get) and its standard
 * `{ success, errors, messages, result }` envelope. These are NOT live captures: no QA tenant with Billing Read was
 * available (AUTO-FIX-W1, 2026-11-18). Replacing them with a sanitized capture is the named release check
 * "Vercel and Cloudflare account plan lines"; until then the Workers id mapping stays unconfirmed and maps exactly.
 */
export function subscriptionsResponse(
  result: readonly Readonly<Record<string, unknown>>[],
) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: result.map((subscription, index) => ({
      id: `subscription-${index}`,
      state: 'Paid',
      frequency: 'monthly',
      currency: 'USD',
      ...subscription,
    })),
  };
}

/** A token without Billing Read: Cloudflare answers 403 with an authentication error code. */
export const billingDeniedResponse = {
  success: false,
  errors: [{ code: 10000, message: 'Authentication error' }],
  messages: [],
  result: null,
};
