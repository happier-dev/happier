import { describe, expect, it } from 'vitest';

describe('prompt library reference cleanup', () => {
    it('removes a deleted artifact from prompt invocations, stacks, and external links', async () => {
        const { removePromptLibraryArtifactReferences } = await import('./promptLibraryReferences');

        const next = removePromptLibraryArtifactReferences({
            artifactId: 'artifact-1',
            promptInvocationsV1: {
                v: 1,
                entries: [
                    {
                        id: 'template-1',
                        token: '/daily',
                        title: 'Daily',
                        target: { kind: 'doc', artifactId: 'artifact-1' },
                        behavior: 'insert',
                        allowArgs: false,
                        availableIn: 'global',
                    },
                    {
                        id: 'template-2',
                        token: '/other',
                        title: 'Other',
                        target: { kind: 'doc', artifactId: 'artifact-2' },
                        behavior: 'insert',
                        allowArgs: false,
                        availableIn: 'global',
                    },
                ],
            },
            promptStacksV1: {
                v: 1,
                surfaces: {
                    coding: [
                        { id: 'coding-1', ref: { kind: 'doc', artifactId: 'artifact-1' }, enabled: true, placement: 'system_append', editPolicy: 'user_only' },
                    ],
                    voice: [
                        { id: 'voice-1', ref: { kind: 'bundle', artifactId: 'artifact-1' }, enabled: true, placement: 'skill_instructions', editPolicy: 'user_only' },
                    ],
                    profilesById: {
                        'profile-1': [
                            { id: 'profile-1-entry', ref: { kind: 'doc', artifactId: 'artifact-2' }, enabled: true, placement: 'system_append', editPolicy: 'user_only' },
                        ],
                    },
                },
            },
            promptExternalLinksV1: {
                v: 1,
                links: [
                    {
                        id: 'link-1',
                        artifactId: 'artifact-1',
                        assetTypeId: 'claude.command',
                        machineId: 'machine-1',
                        scope: 'user',
                        workspacePath: null,
                        externalRef: { relativePath: 'daily.md' },
                        lastExternalDigest: 'digest-1',
                    },
                    {
                        id: 'link-2',
                        artifactId: 'artifact-2',
                        assetTypeId: 'agents.skill',
                        machineId: 'machine-1',
                        scope: 'project',
                        workspacePath: '/Users/test',
                        externalRef: { skillName: 'reviewer' },
                        lastExternalDigest: 'digest-2',
                    },
                ],
            },
        });

        expect(next.promptInvocationsV1.entries).toEqual([
            expect.objectContaining({ id: 'template-2' }),
        ]);
        expect(next.promptStacksV1).toEqual({
            v: 1,
            surfaces: {
                coding: [],
                voice: [],
                profilesById: {
                    'profile-1': [
                        expect.objectContaining({ id: 'profile-1-entry' }),
                    ],
                },
            },
        });
        expect(next.promptExternalLinksV1.links).toEqual([
            expect.objectContaining({ id: 'link-2' }),
        ]);
    });
});
