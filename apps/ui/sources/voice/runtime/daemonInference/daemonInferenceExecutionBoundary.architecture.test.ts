import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

type SourceExpectation = Readonly<{
    filePath: string;
    requiredSnippets?: readonly string[];
    forbiddenSnippets: readonly string[];
}>;

const sourceExpectations: readonly SourceExpectation[] = [
    {
        filePath: 'sources/voice/runtime/daemonInference/DaemonVoiceInferenceClient.ts',
        requiredSnippets: [
            '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
            '@/voice/persistence/voiceConversationSession',
        ],
        forbiddenSnippets: [
            '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc',
            '@/voice/agent/',
            '@/voice/runtime/execution/',
            '@/voice/persistence/voiceAgentRunMetadata',
            'sessionRpcWithServerScope',
            'SESSION_RPC_METHODS.EXECUTION_RUN',
            'voiceAgentRunV1',
            'DaemonVoiceAgentClient',
            "intent: 'voice_agent'",
            "actionId: 'voice_agent.",
        ],
    },
    {
        filePath: 'sources/voice/runtime/daemonInference/DaemonTtsController.ts',
        forbiddenSnippets: [
            '@/voice/agent/',
            '@/voice/runtime/execution/',
            '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc',
            'sessionRpcWithServerScope',
            'voiceAgentRunV1',
            'DaemonVoiceAgentClient',
        ],
    },
    {
        filePath: 'sources/voice/runtime/daemonInference/DaemonSttController.ts',
        forbiddenSnippets: [
            '@/voice/agent/',
            '@/voice/runtime/execution/',
            '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc',
            'sessionRpcWithServerScope',
            'voiceAgentRunV1',
            'DaemonVoiceAgentClient',
        ],
    },
    {
        filePath: 'sources/voice/runtime/daemonInference/daemonVoiceInferencePolicy.ts',
        forbiddenSnippets: [
            '@/voice/agent/',
            '@/voice/runtime/execution/',
            '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc',
            'sessionRpcWithServerScope',
            'voiceAgentRunV1',
            'DaemonVoiceAgentClient',
        ],
    },
];

describe('daemon inference execution boundary', () => {
    for (const expectation of sourceExpectations) {
        it(`keeps ${expectation.filePath} free of voice-agent execution-run seams`, async () => {
            const source = await readFile(join(process.cwd(), expectation.filePath), 'utf8');

            for (const requiredSnippet of expectation.requiredSnippets ?? []) {
                expect(source).toContain(requiredSnippet);
            }

            for (const forbiddenSnippet of expectation.forbiddenSnippets) {
                expect(source).not.toContain(forbiddenSnippet);
            }
        });
    }
});
