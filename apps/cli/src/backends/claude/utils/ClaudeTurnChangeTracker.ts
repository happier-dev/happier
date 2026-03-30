import { NormalizedToolTurnChangeTracker } from '@/agent/tools/diff/normalizedToolTurnChangeTracker';

import { normalizeClaudeToolUseResultToToolChangeResult } from './normalizeClaudeToolUseResultToToolChangeResult';

export class ClaudeTurnChangeTracker extends NormalizedToolTurnChangeTracker {
    constructor() {
        super({
            provider: 'claude',
            turnIdPrefix: 'claude-turn',
        });
    }

    observeToolResult(params: Readonly<{
        callId: string;
        isError: boolean;
        toolUseResult?: unknown;
    }>): void {
        super.observeToolResult({
            callId: params.callId,
            isError: params.isError,
            result: normalizeClaudeToolUseResultToToolChangeResult(params.toolUseResult),
        });
    }
}
