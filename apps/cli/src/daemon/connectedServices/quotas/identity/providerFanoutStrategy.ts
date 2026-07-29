export type ConnectedServiceSameAccountFanoutStrategy =
  | 'provider_account_id'
  | 'shared_group_auth_surface'
  | 'none';

export function normalizeConnectedServiceSameAccountFanoutStrategy(
  value: unknown,
): ConnectedServiceSameAccountFanoutStrategy {
  return value === 'provider_account_id'
    || value === 'shared_group_auth_surface'
    || value === 'none'
    ? value
    : 'none';
}
