

export type VoiceDiagnosticsConsentCopy = Readonly<{
  consentTitle: string;
  consentBody: string;
  consentAction: string;
}>;



export function defineVoiceDiagnosticsConsentTranslation(diagnostics: VoiceDiagnosticsConsentCopy) {
  return { diagnostics };
}