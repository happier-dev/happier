export function buildAutomationTemplateEnvelope(params?: { existingSessionId?: string }): string {
  return JSON.stringify({
    kind: 'happier_automation_template_encrypted_v1',
    payloadCiphertext: 'e2e-ciphertext-base64',
    ...(params?.existingSessionId ? { existingSessionId: params.existingSessionId } : {}),
  });
}

