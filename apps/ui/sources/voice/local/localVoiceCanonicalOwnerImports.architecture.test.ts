import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

type SourceExpectation = Readonly<{
    filePath: string;
    requiredImports: ReadonlyArray<string>;
    forbiddenImports: ReadonlyArray<string>;
}>;

const sourceExpectations: ReadonlyArray<SourceExpectation> = [
    {
        filePath: 'sources/voice/local/localVoiceRuntimeController.ts',
        requiredImports: [
            "./createLocalVoiceRuntimeControllerImpl",
        ],
        forbiddenImports: [
            "./localVoiceEngine",
        ],
    },
    {
        // Both public local adapters are thin wrappers over the single internal
        // factory; the factory is the canonical local-runtime seam.
        filePath: 'sources/voice/adapters/local/createLocalVoiceAdapter.ts',
        requiredImports: [
            "@/voice/local/localVoiceRuntimeController",
        ],
        forbiddenImports: [
            "@/voice/local/localVoiceEngine",
            "@/voice/binding/voiceConversationBindingRuntime",
            "@/sync/domains/state/storage",
            "@/voice/agent/voiceAgentGlobalSessionId",
        ],
    },
    {
        filePath: 'sources/voice/adapters/localConversation/localConversationAdapter.ts',
        requiredImports: [
            "@/voice/adapters/local/createLocalVoiceAdapter",
        ],
        forbiddenImports: [
            "@/voice/local/localVoiceEngine",
            "@/voice/binding/voiceConversationBindingRuntime",
            "@/sync/domains/state/storage",
            "@/voice/agent/voiceAgentGlobalSessionId",
        ],
    },
    {
        filePath: 'sources/voice/adapters/localDirect/localDirectAdapter.ts',
        requiredImports: [
            "@/voice/adapters/local/createLocalVoiceAdapter",
        ],
        forbiddenImports: [
            "@/voice/local/localVoiceEngine",
        ],
    },
    {
        filePath: 'sources/voice/context/resolveActiveLocalVoiceAgentBinding.ts',
        requiredImports: [
            "@/voice/local/localVoiceRuntimeController",
        ],
        forbiddenImports: [
            "@/voice/local/localVoiceEngine",
        ],
    },
];

describe('local voice canonical owner imports', () => {
    it('routes local adapters and active binding helpers through the local runtime controller seam', async () => {
        for (const expectation of sourceExpectations) {
            const source = await readFile(expectation.filePath, 'utf8');

            for (const requiredImport of expectation.requiredImports) {
                expect(source).toContain(requiredImport);
            }

            for (const forbiddenImport of expectation.forbiddenImports) {
                expect(source).not.toContain(forbiddenImport);
            }
        }
    });

    it('retires the localVoiceState compatibility facade once canonical runtime-machine readers own state projection', async () => {
        const source = await readFile('sources/voice/local/localVoiceEngine.ts', 'utf8');

        expect(source).not.toContain('./localVoiceState');
        await expect(access('sources/voice/local/localVoiceState.ts')).rejects.toBeDefined();
    });
});
