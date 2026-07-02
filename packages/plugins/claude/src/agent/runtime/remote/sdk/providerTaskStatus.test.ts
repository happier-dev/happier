import { describe, expect, it } from 'vitest';

import * as remoteSdk from './index.js';

type ProviderTaskStatusExports = Readonly<{
    normalizeClaudeAgentSdkProviderTaskId?: (taskId: unknown) => string | null;
    normalizeClaudeAgentSdkProviderTaskStatus?: (status: unknown) => string | null;
    readClaudeAgentSdkProviderTaskStatus?: (message: unknown) => string | null;
    isTerminalClaudeAgentSdkProviderTaskStatus?: (status: unknown) => boolean;
}>;

const providerTaskStatus = remoteSdk as typeof remoteSdk & ProviderTaskStatusExports;

describe('Claude remote SDK provider task status helpers', () => {
    it('exports provider task id normalization from the plugin remote SDK surface', () => {
        expect(providerTaskStatus.normalizeClaudeAgentSdkProviderTaskId).toBeTypeOf('function');

        expect(providerTaskStatus.normalizeClaudeAgentSdkProviderTaskId?.(' task-1 ')).toBe('task-1');
        expect(providerTaskStatus.normalizeClaudeAgentSdkProviderTaskId?.('   ')).toBeNull();
        expect(providerTaskStatus.normalizeClaudeAgentSdkProviderTaskId?.(42)).toBeNull();
    });

    it('reads direct and patch provider task statuses with terminal classification', () => {
        expect(providerTaskStatus.normalizeClaudeAgentSdkProviderTaskStatus).toBeTypeOf('function');
        expect(providerTaskStatus.readClaudeAgentSdkProviderTaskStatus).toBeTypeOf('function');
        expect(providerTaskStatus.isTerminalClaudeAgentSdkProviderTaskStatus).toBeTypeOf('function');

        expect(providerTaskStatus.normalizeClaudeAgentSdkProviderTaskStatus?.(' Completed ')).toBe('completed');
        expect(providerTaskStatus.readClaudeAgentSdkProviderTaskStatus?.({ patch: { status: 'Running' } })).toBe('running');
        expect(providerTaskStatus.readClaudeAgentSdkProviderTaskStatus?.({ status: ' Failed ' })).toBe('failed');
        expect(providerTaskStatus.isTerminalClaudeAgentSdkProviderTaskStatus?.('failed')).toBe(true);
        expect(providerTaskStatus.isTerminalClaudeAgentSdkProviderTaskStatus?.('running')).toBe(false);
    });
});
