export const ANTIGRAVITY_SUPPORTED_CONNECTED_SERVICE_IDS = Object.freeze([
  'gemini',
] as const);

export type AntigravityConnectedServiceId = typeof ANTIGRAVITY_SUPPORTED_CONNECTED_SERVICE_IDS[number];

export function isAntigravityConnectedServiceId(value: unknown): value is AntigravityConnectedServiceId {
  return value === 'gemini';
}
