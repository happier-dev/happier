import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type SourceExpectation = Readonly<{
    filePath: string;
    requiredImports?: ReadonlyArray<string>;
    forbiddenImports: ReadonlyArray<string>;
}>;

const sourceExpectations: ReadonlyArray<SourceExpectation> = [
    {
        filePath: 'sources/components/voice/qa/VoiceQaScreen.tsx',
        requiredImports: [
            '@/voice/transcript/voiceTranscriptSelectors',
        ],
        forbiddenImports: [
            '@/sync/domains/messages/readStoredSessionMessages',
            '@/voice/transcript/VoiceTranscriptProjector',
        ],
    },
    {
        filePath: 'sources/components/voice/surface/useVoiceSurfaceConversationState.ts',
        requiredImports: [
            '@/voice/transcript/voiceTranscriptSelectors',
        ],
        forbiddenImports: [
            '@/sync/domains/messages/readStoredSessionMessages',
            '@/voice/transcript/VoiceTranscriptProjector',
        ],
    },
    {
        filePath: 'sources/voice/registry/bundledConversationRuntimeHost.ts',
        requiredImports: [
            '@/voice/transcript/voiceConversationTranscript',
        ],
        forbiddenImports: [
            '@/voice/transcript/VoiceTranscriptProjector',
        ],
    },
    {
        filePath: 'sources/voice/runtime/controller/VoiceConversationController.ts',
        requiredImports: [],
        forbiddenImports: [
            // Realtime transport owns lifecycle and delegates transcript projection to provider + transcript owners.
            '@/voice/transcript/VoiceTranscriptProjector',
        ],
    },
];

const retiredRealtimeTranscriptBridgePaths = [
    'sources/realtime/realtimeVoiceTranscriptBridge.ts',
] as const;

const activePathLegacyPatternChecks = [
    {
        label: 'deleted realtime transcript bridge symbol/path',
        pattern: /\brealtimeVoiceTranscriptBridge\b/,
    },
] as const;

async function collectNonTestSourceFiles(rootDir: string): Promise<string[]> {
    const entries = await readdir(rootDir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const entryPath = join(rootDir, entry.name);
        if (entry.isDirectory()) {
            return await collectNonTestSourceFiles(entryPath);
        }

        if (!entry.isFile()) return [];
        if (!entryPath.endsWith('.ts') && !entryPath.endsWith('.tsx')) return [];
        if (/\.(test|spec)\.tsx?$/.test(entryPath)) return [];
        return [entryPath];
    }));

    return files.flat();
}

describe('voice transcript canonical owner imports', () => {
    it('routes UI surfaces through transcript selectors and keeps projector usage behind transcript owners', async () => {
        for (const expectation of sourceExpectations) {
            const source = await readFile(expectation.filePath, 'utf8');

            for (const requiredImport of expectation.requiredImports ?? []) {
                expect(source).toContain(requiredImport);
            }

            for (const forbiddenImport of expectation.forbiddenImports) {
                expect(source).not.toContain(forbiddenImport);
            }
        }
    });

    it('retires the realtime transcript bridge helper after projector cutover', async () => {
        for (const retiredPath of retiredRealtimeTranscriptBridgePaths) {
            await expect(access(retiredPath)).rejects.toBeDefined();
        }
    });

    it('keeps active UI paths off deleted realtime transcript-bridge patterns', async () => {
        const sourceFiles = await collectNonTestSourceFiles('sources');
        const violations: string[] = [];

        for (const filePath of sourceFiles) {
            const source = await readFile(filePath, 'utf8');
            for (const check of activePathLegacyPatternChecks) {
                if (check.pattern.test(source)) {
                    violations.push(`${filePath}: ${check.label}`);
                }
            }
        }

        expect(violations).toEqual([]);
    });
});
