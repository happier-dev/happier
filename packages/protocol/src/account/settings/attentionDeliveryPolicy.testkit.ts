import {
  accountSettingsParse,
  resolveAttentionDeliveryPolicyDecision,
  type AttentionDeliveryDecision,
} from './accountSettings.js';

export function parseAccountSettings(raw: unknown = {}) {
  return accountSettingsParse(raw);
}

export function resolveAttentionDecision(params: unknown): AttentionDeliveryDecision {
  return resolveAttentionDeliveryPolicyDecision(
    params as Parameters<typeof resolveAttentionDeliveryPolicyDecision>[0],
  );
}
