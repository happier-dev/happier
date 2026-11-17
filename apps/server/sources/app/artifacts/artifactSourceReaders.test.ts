import { describe, expect, it } from 'vitest';
import { PROJECT_SETUP_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol/projects/projectSetupV1';
import { projectArtifactSourceReadersFromFacts } from './artifactSourceReaders';

describe('protected Source setup readers', () => {
    const readers = [{ accountId: 'source-reader' }];
    const reference = { projectSourceId: 'selected-source', contentArtifactId: 'setup-document',
        expectedStoredKind: PROJECT_SETUP_ARTIFACT_STORED_KIND_V1 };
    const artifact = { id: reference.contentArtifactId, kind: reference.expectedStoredKind, accountId: 'publisher', grants: [] };
    const admittedSource = { source: { id: reference.projectSourceId }, owner: { kind: 'account' as const, accountId: artifact.accountId } };

    it('derives read access from the selected attachment and its owning custody', () => {
        expect(projectArtifactSourceReadersFromFacts({ artifact, reference, admittedSource, readers })).toEqual(readers);
        expect(projectArtifactSourceReadersFromFacts({ artifact, reference,
            admittedSource: { ...admittedSource, source: { id: 'unrelated-source' } }, readers })).toEqual([]);
        expect(projectArtifactSourceReadersFromFacts({ artifact: { ...artifact, id: 'unrelated-document' },
            reference, admittedSource, readers })).toEqual([]);
    });

    it('uses the admitted setup parent without requiring independent Artifact grants', () => {
        const ownedElsewhere = { ...admittedSource, owner: { kind: 'account' as const, accountId: 'source-owner' } };
        expect(projectArtifactSourceReadersFromFacts({ artifact, reference, admittedSource: ownedElsewhere, readers })).toEqual(readers);
        expect(projectArtifactSourceReadersFromFacts({ artifact: { ...artifact, grants: [{ principalKind: 'account',
            accountId: 'source-owner', teamId: null, teamGroupId: null, accessLevel: 'admin' }] },
            reference, admittedSource: ownedElsewhere, readers })).toEqual(readers);
        const teamSource = { ...admittedSource, owner: { kind: 'team' as const, teamId: 'source-team' } };
        for (const accessLevel of ['view', 'edit', 'admin'] as const) {
            const result = projectArtifactSourceReadersFromFacts({ artifact: { ...artifact, grants: [{ principalKind: 'team',
                accountId: null, teamId: 'source-team', teamGroupId: null, accessLevel, team: { archivedAt: null } }] },
                reference, admittedSource: teamSource, readers });
            expect(result).toEqual(readers);
        }
    });
});
