/** Only characterized vendor policy reasons may cross into public diagnostics. */
export function readXaiPolicyReason(body: Uint8Array): 'BLOCKED_REASON_NO_LOGS' | undefined {
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(body));
    return payload !== null && typeof payload === 'object' && 'error' in payload
      && payload.error === 'BLOCKED_REASON_NO_LOGS' ? payload.error : undefined;
  } catch {
    return undefined;
  }
}
