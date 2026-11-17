import type { DatabaseFindingBaselineV1, DatabaseFindingV1, DatabaseTaskEvidenceV1 } from '@happier-dev/database-protocol';
import { DATABASE_CAPTURE_STATUS_ACTION_ID_V1, DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
    DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1, DATABASE_STATS_READ_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import type { SessionInputDeliveryPlanV1, SessionInputForgeEvidenceV1 } from '@happier-dev/plugin-sdk/sessions';

/** The shared Session delivery host consumes the same plan as Triage. */
export function planDatabaseFindingSessionInputV1(finding: DatabaseFindingV1 | DatabaseTaskEvidenceV1, baseline?: DatabaseFindingBaselineV1): SessionInputDeliveryPlanV1 {
    const brief = buildDatabaseFindingBriefV1(finding, baseline);
    return { kind: 'input', text: brief.text, attachments: [], forgeEvidence: brief.evidence };
}

/** One immutable brief survives leaving the pane. Evidence remains descriptive;
 * the Session host owns framing, admission and delivery. */
export function buildDatabaseFindingBriefV1(finding: DatabaseFindingV1 | DatabaseTaskEvidenceV1, baseline?: DatabaseFindingBaselineV1): Readonly<{ text: string; evidence: SessionInputForgeEvidenceV1 }> {
    if (!('evidenceIdentity' in finding)) {
        const genericRequest = {
            setup: 'Review the required database statistics setup and its restart impact before making a change.',
            connection: 'Diagnose this database connection using its existing target and credential owner.',
            migration: 'Review the requested database migration and its data impact before making a change.',
        };
        const instructions = finding.kind === 'add_telemetry' ? [
            'Add OpenTelemetry to this project.',
            'Use the worktree and observed application stack in the evidence. Inspect the current project declarations before selecting packages; where stack observation is absent or incomplete, establish it through the Project inspection owner first.',
            'Use the stack’s OpenTelemetry SDK and supported automatic instrumentation. Initialize instrumentation before application modules load, preserve the existing launch commands, and include database spans where that instrumentation supports them. Explain any stack-specific manual instrumentation that is still needed.',
            'Use Happier’s configured collector settings through the existing capture and service-launch owners: select the actual OTLP protocol, endpoint and authentication header references. Keep an existing project collector when configured. Do not guess an endpoint, embed a credential in source, or copy ingest tokens into the Session.',
            `Verify with ${DATABASE_CAPTURE_STATUS_ACTION_ID_V1}, generate an application request with a database operation, and inspect the resulting trace and endpoint through ${DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1} and ${DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1} using the same worktree scope. Report missing capture capability or coverage explicitly.`,
            'Prepare the change for review, describe the restart needed to load instrumentation, and verify after the agreed change. This brief does not configure a collector or restart a service.',
        ] : finding.kind === 'enable_pg_stat_statements' ? [
            'Review and enable pg_stat_statements for the selected PostgreSQL database.',
            'Use the exact structural target and typed statistics diagnosis in the evidence. Determine whether the installed extension, shared_preload_libraries, or an engine restart is required; distinguish database-local extension setup from server configuration and explain its impact before proposing SQL or configuration.',
            'Resolve the existing target and administrative credential references through their canonical owners. Prepare an editable plan and obtain the required review before applying setup. Use the existing setup executor when supported; otherwise provide explicit local or vendor instructions. Do not acquire elevated credentials or restart the server as a fallback.',
            `Verify by repeating ${DATABASE_STATS_READ_ACTION_ID_V1} with the evidence target and statistics request. Report the resulting typed capability and coverage; never reset statistics as part of setup or verification.`,
        ] : [genericRequest[finding.kind],
            'Use the structural target and typed diagnosis in the evidence. Resolve credentials through the existing target owner.',
            'Prepare an editable plan with the proposed configuration or SQL and ask for the required review. Use the existing setup executor when supported; otherwise give the person explicit local or vendor instructions.',
            'Do not restart a server, acquire administrative credentials, or reset statistics as a fallback. Verify through the ordinary database read Actions and report any remaining unavailable capability.',
        ];
        return {
            text: instructions.join('\n\n'),
            evidence: { v: 1, items: [{ source: { kind: 'databaseFinding', label: `Database ${finding.kind} task` },
                author: { kind: 'process' }, text: JSON.stringify({ task: finding }) }] },
        };
    }
    const before: DatabaseFindingBaselineV1 = baseline ?? {
        v: finding.v,
        evidenceIdentity: finding.evidenceIdentity,
        sourceRef: finding.sourceRef,
        sourceScope: finding.sourceScope,
        kind: finding.kind,
        observedWindow: finding.observedWindow,
        coverage: finding.coverage,
        summary: finding.summary,
        basis: finding.verification.basis,
    };
    const detail = {
        evidenceIdentity: finding.evidenceIdentity,
        sourceRef: finding.sourceRef,
        sourceScope: finding.sourceScope,
        target: finding.target,
        kind: finding.kind,
        observedWindow: finding.observedWindow,
        coverage: finding.coverage,
        summary: finding.summary,
        ...(finding.object === undefined ? {} : { object: finding.object }),
        ...(finding.activity === undefined ? {} : { activity: finding.activity }),
        ...(finding.normalizedShape === undefined ? {} : { normalizedShape: finding.normalizedShape }),
        ...(finding.omittedTextReason === undefined ? {} : { omittedTextReason: finding.omittedTextReason }),
        verification: finding.verification,
    };
    const text = [
        `Investigate this database ${finding.kind} finding and propose the smallest justified improvement.`,
        `Before: ${JSON.stringify(before.summary)}.`,
        `Before observation window: ${before.observedWindow.fromMs}–${before.observedWindow.toMs} ms. Coverage: ${JSON.stringify(before.coverage)}.`,
        'The evidence preserves these before numbers separately from the selected finding detail. A later detail read describes current evidence and does not reconstruct the earlier observation.',
        ...(finding.omittedTextReason === undefined ? [] : ['Statement text is unavailable; its omission reason is included in the evidence.']),
        'Verify against the same database and interval basis using the exact verification Action operands included in the evidence.',
        'Done means explaining the cause, applying the agreed change, repeating this verification read, and comparing the before and after numbers while reporting any coverage or counter-reset limits.',
    ].join('\n\n');
    return { text, evidence: { v: 1, items: [{
        source: { kind: 'databaseFinding', label: `Database ${finding.kind} finding` },
        author: { kind: 'process' }, text: JSON.stringify({ baseline: before, currentDetail: detail }),
    }] } };
}
