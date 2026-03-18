export const FIRST_PARTY_RUNTIME_KINDS = ['binary', 'node-runtime-payload'] as const;

export type FirstPartyRuntimeKind = (typeof FIRST_PARTY_RUNTIME_KINDS)[number];

export function isFirstPartyRuntimeKind(value: string): value is FirstPartyRuntimeKind {
  return FIRST_PARTY_RUNTIME_KINDS.includes(value as FirstPartyRuntimeKind);
}
