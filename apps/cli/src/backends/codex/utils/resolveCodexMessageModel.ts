export function resolveCodexMessageModel(opts: Readonly<{
  currentModelId: string | null | undefined;
  messageMetaModel: unknown;
}>): string | undefined {
  if (opts.messageMetaModel === null) {
    return undefined;
  }

  if (typeof opts.messageMetaModel === 'string') {
    const normalized = opts.messageMetaModel.trim();
    if (normalized) return normalized;
  }

  if (typeof opts.currentModelId === 'string') {
    const normalized = opts.currentModelId.trim();
    if (normalized) return normalized;
  }

  return undefined;
}

