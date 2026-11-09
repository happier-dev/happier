import type { JsonValue, PluginContributionRef } from '../identity.js';

export type ScmRevisionRangeV1 = Readonly<{ kind: 'revisionRange'; baseOid: string; headOid: string }>;

/** Declaration-neutral source grammar; the portable Protocol parser is the sole validator. */
export type ScmComparisonSource =
    | { kind: 'turnCheckpoint'; sessionId?: string; turnId?: string; checkpointReceiptId?: string;
        evidenceMode?: 'checkpoint' | 'agent_reported' | 'reconciled' }
    | { kind: 'session'; sessionId: string }
    | { kind: 'workingTree' }
    | { kind: 'branch'; head: string; base: string }
    | { kind: 'commit'; commit: string; parent?: string }
    | ScmRevisionRangeV1
    | { kind: 'pullRequest'; locator: {
        providerId: string; repository: string; number: number; baseOid?: string; headOid?: string;
        sourceAction?: { action: PluginContributionRef; input?: JsonValue };
    } };
