import type { ChangeConfidence, ChangeEvidenceSource, TurnChangeSet } from '@happier-dev/protocol';
import type { ToolHappierMetaV2, ToolNormalizationProtocol } from '@happier-dev/protocol';

const SOURCE_PRECEDENCE: Record<ChangeEvidenceSource, number> = {
    provider_native: 0,
    provider_tool: 1,
    canonical_diff_tool: 2,
    canonical_patch_tool: 3,
    scm_reconciled: 4,
    inferred: 5,
};

const CONFIDENCE_PRECEDENCE: Record<ChangeConfidence, number> = {
    exact: 0,
    strong: 1,
    best_effort: 2,
};

function summarizeTurnSources(turnChangeSet: TurnChangeSet): Readonly<{
    source: ChangeEvidenceSource;
    confidence: ChangeConfidence;
}> {
    let source: ChangeEvidenceSource = 'provider_native';
    let confidence: ChangeConfidence = 'exact';
    for (const file of turnChangeSet.files) {
        if (SOURCE_PRECEDENCE[file.source] > SOURCE_PRECEDENCE[source]) {
            source = file.source;
        }
        if (CONFIDENCE_PRECEDENCE[file.confidence] > CONFIDENCE_PRECEDENCE[confidence]) {
            confidence = file.confidence;
        }
    }
    return { source, confidence };
}

export function buildSessionChangeToolMetadata(params: Readonly<{
    turnChangeSet: TurnChangeSet;
    protocol: ToolNormalizationProtocol;
    rawToolName: string;
}>): ToolHappierMetaV2 & {
    workspaceMutationSignal: 'turn-change-set';
    sessionChangeScope: 'turn';
    turnId: string;
    sessionId: string;
    confidence: ChangeConfidence;
    source: ChangeEvidenceSource;
    turnStatus: TurnChangeSet['status'];
    seqRange: TurnChangeSet['seqRange'];
} {
    const summary = summarizeTurnSources(params.turnChangeSet);
    return {
        v: 2,
        protocol: params.protocol,
        provider: params.turnChangeSet.provider,
        rawToolName: params.rawToolName,
        canonicalToolName: 'Diff',
        workspaceMutationSignal: 'turn-change-set',
        sessionChangeScope: 'turn',
        turnId: params.turnChangeSet.turnId,
        sessionId: params.turnChangeSet.sessionId,
        confidence: summary.confidence,
        source: summary.source,
        turnStatus: params.turnChangeSet.status,
        seqRange: params.turnChangeSet.seqRange,
    };
}
