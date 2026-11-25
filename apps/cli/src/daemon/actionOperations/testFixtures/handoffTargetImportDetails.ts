const validDiagnostic = { code: 'transcript_content_mismatch', details: { pathKind: 'transcript_file' } };
const privatePath = '/private/target/session.jsonl';
export const validHandoffTargetImportDetails = { diagnostics: [validDiagnostic] };

export const handoffTargetImportDetailsCases = [
    { label: 'native content mismatch', details: validHandoffTargetImportDetails, public: true },
    { label: 'native identity changed', details: { diagnostics: [{ ...validDiagnostic, code: 'transcript_identity_changed' }] }, public: true },
    { label: 'top-level path', details: { diagnostics: [validDiagnostic], path: privatePath }, public: false },
    { label: 'nested object in the second diagnostic', details: { diagnostics: [validDiagnostic, {
        ...validDiagnostic, details: { ...validDiagnostic.details, metadata: { path: privatePath } },
    }] }, public: false },
    { label: 'path as code', details: { diagnostics: [{ ...validDiagnostic, code: privatePath }] }, public: false },
    { label: 'path as path kind', details: { diagnostics: [{ ...validDiagnostic, details: { pathKind: privatePath } }] }, public: false },
    { label: 'wrong diagnostics type', details: { diagnostics: validDiagnostic }, public: false },
    { label: 'wrong code type', details: { diagnostics: [{ ...validDiagnostic, code: 123 }] }, public: false },
    { label: 'wrong path kind type', details: { diagnostics: [{ ...validDiagnostic, details: { pathKind: ['transcript_file'] } }] }, public: false },
    { label: 'message rider', details: { diagnostics: [{ ...validDiagnostic, message: 'private native error' }] }, public: false },
    { label: 'Account ID rider', details: { diagnostics: [validDiagnostic], accountId: 'other-account' }, public: false },
    { label: 'Session ID rider', details: { diagnostics: [{ ...validDiagnostic, details: { ...validDiagnostic.details, sessionId: 'other-session' } }] }, public: false },
    { label: 'path in recovery marker', details: {
        diagnostics: [validDiagnostic], handoffRecovery: { kind: 'session_handoff_source_stopped', path: privatePath },
    }, public: false },
];
