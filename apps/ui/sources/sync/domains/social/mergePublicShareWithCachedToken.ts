import type { PublicSessionShare } from "./sharingTypes";

export type PublicShareFetchOutcome =
  | Readonly<{ ok: true; publicShare: PublicSessionShare | null }>
  | Readonly<{ ok: false }>;

export function mergePublicShareWithCachedToken(params: Readonly<{
  previousPublicShare: PublicSessionShare | null;
  cachedToken: string | null;
  outcome: PublicShareFetchOutcome;
}>): { publicShare: PublicSessionShare | null; cachedToken: string | null } {
  if (!params.outcome.ok) {
    return { publicShare: params.previousPublicShare, cachedToken: params.cachedToken };
  }

  if (!params.outcome.publicShare) {
    return { publicShare: null, cachedToken: null };
  }

  const token = params.outcome.publicShare.token ?? params.previousPublicShare?.token ?? params.cachedToken ?? null;

  return { publicShare: { ...params.outcome.publicShare, token }, cachedToken: token };
}
