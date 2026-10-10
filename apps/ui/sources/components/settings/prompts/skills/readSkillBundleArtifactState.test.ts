import { describe, expect, it } from 'vitest';
import type { PromptFoldersV1 } from '@happier-dev/protocol/prompts/library/promptFoldersV1';
import { readSkillBundleArtifactState } from './readSkillBundleArtifactState';

describe('Skill editor admitted organization', () => {
    it('retains owned content without projecting organization before the folder catalog is admitted', () => {
        const artifact = { id: 'owned', owned: true, revision: { headerVersion: 1, bodyVersion: 1 },
            header: { v: 1, title: 'Owned', kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1', folderId: 'legacy', tags: ['private'] },
            body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [] }),
        };
        expect(readSkillBundleArtifactState(artifact, null)).toMatchObject({ title: 'Owned',
            folderId: null, tags: [], organizationAvailable: false, body: { entries: [] } });
    });
    it.each([true, false])('projects only recipient placement while retaining skill content (override=%s)', override => {
        const artifact = { id: 'received', owned: false, revision: { headerVersion: 1, bodyVersion: 1 },
            header: { v: 1, title: 'Received', kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1', folderId: 'foreign', tags: ['owner-private'] },
            body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
                { path: 'SKILL.md', contentKind: 'utf8', contentBase64: 'c2tpbGw=' },
            ] }),
        };
        const folders: PromptFoldersV1 = { v: 1, folders: [{ id: 'mine', name: 'Personal' }],
            ...(override ? { artifactHeadersById: { received: { folderId: 'mine', tags: ['personal'] } } } : {}),
        };
        const state = readSkillBundleArtifactState(artifact, folders);
        expect(state).toMatchObject({ title: 'Received', folderId: override ? 'mine' : null,
            tags: override ? ['personal'] : [], body: { entries: [{ path: 'SKILL.md', contentBase64: 'c2tpbGw=' }] } });
    });
    it('keeps content available when malformed legacy organization cannot be admitted', () => {
        const artifact = { id: 'owned', owned: true, revision: { headerVersion: 1, bodyVersion: 1 },
            header: { v: 1, title: 'Owned', kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1', tags: 42 },
            body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [] }),
        };
        expect(readSkillBundleArtifactState(artifact, { v: 1, folders: [] })).toMatchObject({ title: 'Owned',
            organizationAvailable: false, body: { entries: [] } });
    });
});
