export type AgyQuotaPool = 'gemini' | '3p';

/** Maps Flash/Pro and Opus/Sonnet/GPT-OSS to the pools reported by retrieveUserQuotaSummary. */
export function resolveAgyQuotaPoolForModel(modelId: string): AgyQuotaPool | null {
  const id = modelId.trim().toLowerCase();
  if (resolveAgyQuotaModelFamily(id)?.id.startsWith('gemini-')) return 'gemini';
  if (/^(claude-(opus|sonnet)(-|$)|gpt-oss-)/.test(id)) return '3p';
  return null;
}

/** Recognizes only provider-reported shared limit IDs, without guessing from percentages. */
export function resolveAgyQuotaPoolForLimit(providerLimitId: string | null | undefined): AgyQuotaPool | null {
  if (providerLimitId === 'gemini-weekly' || providerLimitId === 'gemini-5h') return 'gemini';
  if (providerLimitId === '3p-weekly' || providerLimitId === '3p-5h') return '3p';
  return null;
}

/** Groups aliases and thinking variants only when the provider's shared-window summary is unavailable. */
export function resolveAgyQuotaModelFamily(modelId: string): Readonly<{ id: string; label: string }> | null {
  const id = modelId.trim().toLowerCase();
  if (/^gemini-(?:\d+(?:\.\d+)?-|)flash(?:-|$)/.test(id)) return { id: 'gemini-flash', label: 'Gemini Flash' };
  if (id === 'gemini-pro-agent') return { id: 'gemini-pro-3.1', label: 'Gemini 3.1 Pro' };
  if (id === 'gemini-pro') return { id: 'gemini-pro', label: 'Gemini Pro' };
  const pro = /^gemini-(\d+(?:\.\d+)?)-pro(?:-|$)/.exec(id);
  if (pro) return { id: `gemini-pro-${pro[1]}`, label: `Gemini ${pro[1]} Pro` };
  if (/^claude-opus(?:-|$)/.test(id)) return { id: 'claude-opus', label: 'Claude Opus' };
  if (/^claude-sonnet(?:-|$)/.test(id)) return { id: 'claude-sonnet', label: 'Claude Sonnet' };
  if (/^gpt-oss-120b(?:-|$)/.test(id)) return { id: 'gpt-oss-120b', label: 'GPT-OSS 120B' };
  return null;
}

/** Excludes reserved chat and tab-completion entries from the coding quota display. */
export function isAgyInternalQuotaModel(modelId: string): boolean {
  return /^(chat_|tab_)/.test(modelId.trim().toLowerCase());
}
