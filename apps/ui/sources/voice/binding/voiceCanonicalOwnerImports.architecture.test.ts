import { describe, expect, it } from 'vitest';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

type SourceExpectation = Readonly<{
    filePath: string;
    requiredImports?: ReadonlyArray<string>;
    forbiddenImports: ReadonlyArray<string>;
}>;

const sourceExpectations: ReadonlyArray<SourceExpectation> = [
    {
        filePath: 'sources/components/voice/surface/useVoiceSurfaceStoreState.ts',
        requiredImports: [],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceSessionBindingStore',
        ],
    },
    {
        filePath: 'sources/components/voice/qa/VoiceQaScreen.tsx',
        requiredImports: [
            '@/voice/binding/voiceConversationBindingStore',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceSessionBindingStore',
        ],
    },
    {
        filePath: 'sources/components/voice/surface/useVoiceSurfaceConversationState.ts',
        requiredImports: [
            '@/voice/binding/resolveVoiceBindingBySessionId',
        ],
        forbiddenImports: [
            '@/voice/binding/VoiceConversationBindingResolver',
            '@/voice/sessionBinding/voiceSessionBindingTypes',
        ],
    },
    {
        filePath: 'sources/components/voice/surface/createVoiceSurfaceActionHandlers.ts',
        requiredImports: [],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceSessionBindingTypes',
        ],
    },
    {
        filePath: 'sources/components/sessions/shell/SessionView.tsx',
        requiredImports: [
            '@/voice/binding/voiceSessionComposerRouting',
            '@/voice/binding/sendVoiceSessionComposerText',
            '@/voice/persistence/voiceConversationSystemSessionLookup',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceConversationSession',
            '@/voice/sessionBinding/voiceSessionComposerRouting',
            '@/voice/sessionBinding/sendVoiceSessionComposerText',
        ],
    },
    {
        filePath: 'sources/voice/binding/voiceSessionComposerRouting.ts',
        requiredImports: [
            './VoiceConversationBindingResolver',
            './voiceConversationBindingStore',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/resolveVoiceSessionBinding',
            '@/voice/sessionBinding/voiceSessionBindingStore',
        ],
    },
    {
        filePath: 'sources/voice/binding/sendVoiceSessionComposerText.ts',
        requiredImports: [
            './voiceConversationBindingStore',
            './voiceSessionComposerRouting',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceSessionComposerRouting',
            '@/voice/sessionBinding/voiceSessionBindingStore',
        ],
    },
    {
        filePath: 'sources/voice/local/sendVoiceTextTurn.ts',
        requiredImports: [
            '@/voice/binding/resolveVoiceBindingBySessionId',
        ],
        forbiddenImports: [
            '@/voice/binding/VoiceConversationBindingResolver',
        ],
    },
    {
        filePath: 'sources/voice/persistence/resetVoiceAgentPersistenceState.ts',
        requiredImports: [
            '@/voice/binding/VoiceConversationBindingResolver',
            '@/voice/persistence/voiceConversationSession',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceConversationSession',
        ],
    },
    {
        filePath: 'sources/voice/binding/voiceConversationBindingStore.ts',
        requiredImports: [
            './voiceConversationBindingMetadata',
            './voiceConversationBindingTypes',
            '@/sync/domains/session/listing/sessionListLookupState',
            '@/sync/domains/state/storageStateReaderBridge',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceConversationBindingMetadata',
            '@/voice/sessionBinding/voiceSessionBindingTypes',
            '@/voice/sessionBinding/voiceConversationSystemSessionLookup',
        ],
    },
    {
        filePath: 'sources/voice/binding/VoiceConversationBindingResolver.ts',
        requiredImports: [
            './voiceConversationBindingMetadata',
            './voiceConversationBindingTypes',
            '@/voice/shared/readVoiceSessionOwnerMetadata',
        ],
        forbiddenImports: [
            '@/sync/domains/session/listing/sessionListLookupState',
            '@/voice/sessionBinding/voiceConversationBindingMetadata',
            '@/voice/sessionBinding/voiceSessionBindingTypes',
            '@/voice/sessionBinding/voiceConversationSystemSessionLookup',
        ],
    },
    {
        filePath: 'sources/voice/binding/voiceConversationBindingRuntime.ts',
        requiredImports: [
            './appendVoiceTargetSessionSwitchNote',
            './resolveVoiceConversationBindingResolution',
            './voiceConversationBindingMetadata',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/resolveVoiceConversationSessionId',
            '@/voice/sessionBinding/voiceConversationBindingMetadata',
            '@/voice/sessionBinding/voiceSessionTargetAnnotations',
        ],
    },
    {
        filePath: 'sources/voice/binding/voiceConversationBindingManager.ts',
        requiredImports: [
            './voiceConversationBindingTypes',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceSessionBindingTypes',
        ],
    },
    {
        filePath: 'sources/voice/binding/voiceConversationBindingPersistence.ts',
        requiredImports: [
            './voiceConversationBindingTypes',
            '@/voice/persistence/voiceConversationSession',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceConversationSession',
            '@/voice/sessionBinding/voiceSessionBindingTypes',
        ],
    },
    {
        filePath: 'sources/voice/agent/useHasGlobalVoiceAgentConversation.ts',
        requiredImports: [
            '@/voice/binding/voiceConversationBindingStore',
            '@/voice/persistence/voiceConversationSystemSessionLookup',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceConversationSystemSessionLookup',
            '@/voice/sessionBinding/voiceSessionBindingStore',
        ],
    },
    {
        filePath: 'sources/voice/agent/initializeVoiceAgentHandle.ts',
        requiredImports: [
            '@/voice/persistence/voiceConversationSession',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceConversationSession',
        ],
    },
    {
        filePath: 'sources/voice/runtime/execution/voiceWelcomePolicy.ts',
        requiredImports: [
            '@/voice/binding/voiceConversationBindingPersistence',
        ],
        forbiddenImports: [
            'readPersistedVoiceConversationRuntimeHandoff',
        ],
    },
    {
        filePath: 'sources/voice/runtime/execution/voiceRunRecovery.ts',
        requiredImports: [
            '@/voice/binding/voiceConversationBindingPersistence',
        ],
        forbiddenImports: [
            'readPersistedVoiceConversationRuntimeHandoff',
        ],
    },
    {
        filePath: 'sources/voice/agent/voiceAgentRunState.ts',
        requiredImports: [
            '@/voice/binding/voiceConversationBindingPersistence',
        ],
        forbiddenImports: [
            'readPersistedVoiceConversationRuntimeHandoff',
        ],
    },
    {
        filePath: 'sources/voice/agent/recoverUnavailableGlobalVoiceAutoMachine.ts',
        requiredImports: [
            '@/voice/persistence/voiceAutoTargetMachineSettings',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceAutoTargetMachineSettings',
            'readPersistedVoiceConversationRuntimeHandoff',
        ],
    },
    {
        filePath: 'sources/voice/runtime/daemonInference/DaemonVoiceInferenceClient.ts',
        requiredImports: [
            '@/voice/persistence/voiceConversationSession',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceConversationSession',
        ],
    },
    {
        filePath: 'sources/voice/qa/voiceQaSessionResolution.ts',
        requiredImports: [
            '@/voice/binding/resolveVoiceOperationalSessionId',
            '@/voice/persistence/voiceConversationSystemSessionLookup',
            '@/voice/binding/voiceConversationBindingTypes',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/resolveVoiceOperationalSessionId',
            '@/voice/sessionBinding/voiceConversationSystemSessionLookup',
            '@/voice/sessionBinding/voiceSessionBindingTypes',
        ],
    },
    {
        filePath: 'sources/voice/qa/ensureDefaultLocalVoiceQaBinding.ts',
        requiredImports: [
            '@/voice/binding/voiceConversationBindingTypes',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceSessionBindingTypes',
        ],
    },
    {
        filePath: 'sources/voice/qa/voiceQaController.ts',
        requiredImports: [
            '@/voice/binding/voiceConversationBindingTypes',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/voiceSessionBindingTypes',
        ],
    },
    {
        filePath: 'sources/voice/qa/voiceQaRuntimeDeps.ts',
        requiredImports: [
            '@/voice/session/voiceAdapterRegistry',
        ],
        forbiddenImports: [
            '@/realtime/RealtimeSession',
            '@/voice/adapters/realtimeElevenLabs',
        ],
    },
    {
        filePath: 'sources/voice/context/getVoiceContextSinkForSession.ts',
        requiredImports: [
            '@/voice/session/voiceAdapterRegistry',
        ],
        forbiddenImports: [
            '@/realtime/RealtimeSession',
            '@/voice/adapters/realtimeElevenLabs',
        ],
    },
    {
        // The engine no longer consults the realtime transport directly: the
        // runtime machine is the single lifecycle source, so the engine derives
        // the realtime session snapshot from it (the transport's private
        // snapshot member was retired). The forbidden guard still keeps the
        // engine off the retired @/realtime/RealtimeSession legacy facade.
        filePath: 'sources/voice/local/localVoiceEngine.ts',
        requiredImports: [],
        forbiddenImports: [
            '@/realtime/RealtimeSession',
        ],
    },
    {
        filePath: 'sources/voice/context/resolveActiveLocalVoiceAgentBinding.ts',
        requiredImports: [
            '@/voice/binding/resolveVoiceOperationalSessionId',
            '@/voice/binding/voiceConversationBindingTypes',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/resolveVoiceOperationalSessionId',
            '@/voice/sessionBinding/voiceSessionBindingTypes',
        ],
    },
    {
        filePath: 'sources/voice/tools/actionImpl/sessionTargets.ts',
        requiredImports: [
            '@/voice/binding/applyVoiceSessionTargetSelection',
        ],
        forbiddenImports: [
            '@/voice/sessionBinding/applyVoiceSessionTargetSelection',
        ],
    },
];

const retiredLegacyOwnerArtifacts = [
    'sources/voice/sessionBinding/voiceCanonicalOwnerImports.architecture.test.ts',
    'sources/voice/sessionBinding/resolveVoiceConversationSessionId.test.ts',
    'sources/voice/sessionBinding/voiceAutoTargetMachineSettings.test.ts',
    'sources/voice/sessionBinding/voiceConversationBindingMetadata.spec.ts',
    'sources/voice/sessionBinding/voiceConversationScopeMetadata.spec.ts',
    'sources/voice/sessionBinding/voiceConversationSession.spec.ts',
    'sources/voice/sessionBinding/voiceConversationSystemSessionLookup.test.ts',
    'sources/voice/sessionBinding/voiceSessionBindingManager.test.ts',
    'sources/voice/sessionBinding/voiceSessionBindingStore.test.ts',
    'sources/voice/sessionBinding/voiceSessionBindingTestHelpers.ts',
    'sources/voice/sessionBinding/voiceSessionTargetAnnotations.test.ts',
] as const;

const retiredLegacyCompatibilityWrappers = [
    'sources/voice/sessionBinding/applyVoiceSessionTargetSelection.ts',
    'sources/voice/sessionBinding/resolveVoiceConversationSessionId.ts',
    'sources/voice/sessionBinding/resolveVoiceOperationalSessionId.ts',
    'sources/voice/sessionBinding/sendVoiceSessionComposerText.ts',
    'sources/voice/sessionBinding/voiceAutoTargetMachineSettings.ts',
    'sources/voice/sessionBinding/voiceConversationBindingMetadata.ts',
    'sources/voice/sessionBinding/voiceConversationScopeMetadata.ts',
    'sources/voice/sessionBinding/voiceConversationSystemSessionLookup.ts',
    'sources/voice/sessionBinding/voiceConversationTranscript.ts',
    'sources/voice/sessionBinding/voiceConversationSession.ts',
    'sources/voice/sessionBinding/resolveVoiceSessionBinding.ts',
    'sources/voice/sessionBinding/voiceSessionBindingManager.ts',
    'sources/voice/sessionBinding/voiceSessionBindingRuntime.ts',
    'sources/voice/sessionBinding/voiceSessionBindingStore.ts',
    'sources/voice/sessionBinding/voiceSessionBindingTypes.ts',
    'sources/voice/sessionBinding/voiceSessionComposerRouting.ts',
    'sources/voice/sessionBinding/voiceSessionTargetAnnotations.ts',
] as const;

const retiredCanonicalCompatibilityWrappers = [
    'sources/voice/binding/resolveVoiceSessionBinding.ts',
    'sources/realtime/RealtimeSession.ts',
] as const;

const uiActivePathLegacyAllowlist = new Set<string>();

const uiActivePathLegacyPatternChecks = [
    {
        label: 'legacy sessionBinding import path',
        pattern: /['"][^'"]*sessionBinding\/[^'"]*['"]/,
    },
    {
        label: 'compatibility runtime handoff helper',
        pattern: /\breadPersistedVoiceConversationRuntimeHandoff\s*\(/,
    },
    {
        label: 'legacy voice activity controller surface',
        pattern: /\bvoiceActivityController\b/,
    },
    {
        label: 'legacy voice activity store surface',
        pattern: /\bvoiceActivityStore\b/,
    },
    {
        label: 'direct local voice store writes',
        pattern: /\buseLocalVoiceStore\.setState\b/,
    },
    {
        label: 'legacy local voice patch helper',
        pattern: /\bpatchLocalVoiceState\b/,
    },
    {
        label: 'idle plus session heuristic',
        pattern: /\bidle\s*\+\s*sessionId\b/,
    },
    {
        label: 'legacy idle-state suppression helper',
        pattern: /\bsetIdleStateUnlessRecording\b/,
    },
    {
        label: 'realtime session compatibility facade import',
        pattern: /['"]@\/realtime\/RealtimeSession['"]/,
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

describe('voice canonical owner imports', () => {
    it('routes active surfaces and composer helpers through canonical voice/binding owners', async () => {
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

    it('retires legacy sessionBinding behavior-test ownership once canonical owners exist', async () => {
        for (const retiredPath of retiredLegacyOwnerArtifacts) {
            await expect(access(retiredPath)).rejects.toBeDefined();
        }
    });

    it('deletes unreferenced legacy sessionBinding compatibility wrappers', async () => {
        for (const retiredPath of retiredLegacyCompatibilityWrappers) {
            await expect(access(retiredPath)).rejects.toBeDefined();
        }
    });

    it('deletes canonical voice-binding compatibility wrappers once their owners are direct', async () => {
        for (const retiredPath of retiredCanonicalCompatibilityWrappers) {
            await expect(access(retiredPath)).rejects.toBeDefined();
        }
    });

    it('keeps active voice product paths off legacy compatibility seams', async () => {
        const sourceFiles = await collectNonTestSourceFiles('sources');
        const violations: string[] = [];

        for (const filePath of sourceFiles) {
            if (filePath.startsWith('sources/voice/sessionBinding/')) continue;
            if (uiActivePathLegacyAllowlist.has(filePath)) continue;

            const source = await readFile(filePath, 'utf8');
            for (const check of uiActivePathLegacyPatternChecks) {
                if (check.pattern.test(source)) {
                    violations.push(`${filePath}: ${check.label}`);
                }
            }
        }

        expect(violations).toEqual([]);
    });
});
