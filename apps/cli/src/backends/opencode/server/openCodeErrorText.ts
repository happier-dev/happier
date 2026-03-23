export function extractOpenCodeErrorText(error: unknown): string | null {
  if (typeof error === 'string') {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const rec = error as Record<string, unknown>;
    const message = typeof rec.message === 'string' ? rec.message.trim() : '';
    if (message) return message;
    const data = rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data) ? (rec.data as Record<string, unknown>) : null;
    const dataMessage = typeof data?.message === 'string' ? String(data.message).trim() : '';
    if (dataMessage) return dataMessage;
    const detail = typeof rec.detail === 'string' ? rec.detail.trim() : '';
    if (detail) return detail;
    const errorText = typeof rec.error === 'string' ? rec.error.trim() : '';
    if (errorText) return errorText;
  }
  return null;
}

