import { describe, expect, it } from 'vitest';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { promptStackDocumentChoices } from './promptStackDocumentChoices';

describe('qualified Context document choices', () => {
    it('excludes only attached references from the admitted Home, not an equal-id foreign document', () => {
        const artifact: DecryptedArtifact = { id: 'doc', title: 'Document', header: { kind: 'prompt_doc.v2', title: 'Document' },
            isDecrypted: true, body: null, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const input = { artifacts: [artifact], serverId: 'home', untitled: 'Untitled',
            attachedRefs: [{ kind: 'doc' as const, artifactId: 'doc', serverId: 'foreign' }] };
        expect(promptStackDocumentChoices(input).map(choice => choice.id)).toEqual(['doc']);
        expect(promptStackDocumentChoices({ ...input, attachedRefs: [{ kind: 'doc', artifactId: 'doc', serverId: 'home' }] })).toEqual([]);
        expect(promptStackDocumentChoices({ ...input, attachedRefs: [{ kind: 'doc', artifactId: 'doc' }] })).toEqual([]);
    });
    it('does not offer an unsupported bundle as a skill', () => {
        const artifact: DecryptedArtifact = { id: 'dashboard', title: 'Dashboard',
            header: { v: 1, kind: 'prompt_bundle.v2', title: 'Dashboard', bundleSchemaId: 'dashboard.v1' },
            isDecrypted: true, body: null, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        expect(promptStackDocumentChoices({ artifacts: [artifact], serverId: 'home', attachedRefs: [], untitled: 'Untitled' })).toEqual([]);
    });
    it('admits all Context document kinds but only PromptDocs for Instructions', () => {
        const artifacts: DecryptedArtifact[] = [
            ['doc', 'prompt_doc.v2'], ['skill', 'prompt_bundle.v2'], ['memory', 'memory_doc.v1'], ['other', 'workflow-definition.v1'],
        ].map(([id, kind]) => ({ id: id!, title: id!, header: { kind, title: id, ...(kind === 'prompt_bundle.v2' ? { bundleSchemaId: 'skills.skill_md_v1' } : {}) }, isDecrypted: true,
            body: null, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }));
        const input = { artifacts, serverId: 'captured-home', attachedRefs: [], untitled: 'Untitled' };
        expect(promptStackDocumentChoices(input).map(choice => [choice.kind, choice.value])).toEqual([
            ['doc', { kind: 'doc', artifactId: 'doc', serverId: 'captured-home' }],
            ['skill', { kind: 'bundle', artifactId: 'skill', serverId: 'captured-home' }],
            ['memory', { kind: 'doc', artifactId: 'memory', serverId: 'captured-home' }],
        ]);
        expect(promptStackDocumentChoices({ ...input, purpose: 'instructions' }).map(choice => choice.id)).toEqual(['doc']);
        expect(promptStackDocumentChoices({ ...input, attachedRefs: [{ kind: 'doc', artifactId: 'doc' }] }).map(choice => choice.id)).toEqual(['skill', 'memory']);
        expect(promptStackDocumentChoices({ ...input, artifacts: artifacts.map(artifact => ({ ...artifact, isDecrypted: false })) })).toEqual([]);
    });
});
