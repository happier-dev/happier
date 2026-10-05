import { describe, expect, it } from 'vitest';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

import {
    classifyArtifactBrowserKind,
    countArtifactBrowserKinds,
    projectArtifactBrowserRows,
    readArtifactPreview,
    readArtifactProvenance,
    resolveArtifactOpenRoute,
} from './artifactBrowserModel';

function artifact(id: string, header: Record<string, unknown> | null, extra: Partial<DecryptedArtifact> = {}): DecryptedArtifact {
    const title = typeof header?.title === 'string' ? header.title : null;
    return {
        id, title, header: header === null ? null : { title, ...header }, headerVersion: 1, seq: 1,
        createdAt: 1_000, updatedAt: 1_000, isDecrypted: true, ...extra,
    } as DecryptedArtifact;
}

describe('artifactBrowserModel', () => {
    it('keeps HTML documents and bundles static in the grid, using only the exact stored kind', () => {
        const document = artifact('html', { kind: 'html', title: 'Interactive report', excerpt: '<script>fetch("/api")</script>' }, {
            body: '<h1>Report</h1><script>window.executed = true</script>',
        });
        const bundle = artifact('bundle', { kind: 'html', title: 'Bundled report' }, {
            body: { blobId: '00000000-0000-4000-8000-000000000001', mime: 'text/html', sizeBytes: 42, sha256: 'a'.repeat(64) },
        });
        expect(readArtifactPreview(document)).toEqual({ kind: 'html', name: 'Interactive report' });
        expect(readArtifactPreview(bundle)).toEqual({ kind: 'html', name: 'Bundled report' });
        expect(classifyArtifactBrowserKind(document)).toBe('document');
        expect(resolveArtifactOpenRoute(document)).toBe('/artifacts/html');
        const displayOnly = { ...document, rawHeader: { kind: 'html ', title: 'Interactive report' } };
        expect(readArtifactPreview(displayOnly).kind).toBe('markdown');
        expect(readArtifactPreview(artifact('file', { title: 'page.html', mime: 'text/html' }, { body: bundle.body })))
            .toEqual({ kind: 'file', name: 'page.html', mime: 'text/html', sizeBytes: 42 });
    });
    it('treats a binary reference as a typed file, never a stale text excerpt', () => {
        const reference = { blobId: '00000000-0000-4000-8000-000000000001', mime: 'application/pdf', sizeBytes: 42, sha256: 'a'.repeat(64) };
        expect(readArtifactPreview(artifact('pdf', { title: 'Report.pdf', excerpt: 'stale text' }, { body: reference })))
            .toEqual({ kind: 'file', name: 'Report.pdf', mime: 'application/pdf', sizeBytes: 42 });
    });
    it('lists ordinary kinds, opens each in its own owner, and leaves approvals and drafts out', () => {
        const note = artifact('n1', { title: 'Root cause' });
        const prompt = artifact('p1', { kind: 'prompt_doc.v2', title: 'Code review' });
        const board = artifact('b1', { kind: 'work-board.v1', title: 'Q4 launch' });
        const workflow = artifact('w1', { kind: 'workflow-definition.v1', title: 'Morning triage' });
        const profile = artifact('lp1', { kind: 'launch-profile.v1', title: 'Fast', profileId: 'profile-7' });
        const approval = artifact('ap1', { kind: 'approval_request.v1', title: 'Approve deploy' });
        const draft = artifact('d1', { title: 'Draft' }, { draft: true });

        expect([note, prompt, board, workflow, profile, approval, draft].map(classifyArtifactBrowserKind))
            .toEqual(['document', 'prompt', 'board', 'workflow', 'launchProfile', null, null]);
        expect(resolveArtifactOpenRoute(note)).toBe('/artifacts/n1');
        expect(resolveArtifactOpenRoute(prompt)).toBe('/settings/prompts/docs/p1');
        expect(resolveArtifactOpenRoute(board)).toBe('/boards/b1');
        expect(resolveArtifactOpenRoute(workflow)).toBe('/workflows/w1');
        expect(resolveArtifactOpenRoute(profile)).toBe('/settings/profiles/profile-7');
        // A kind this host does not know is still an ordinary document, opened in the Artifacts view.
        expect(resolveArtifactOpenRoute(artifact('x1', { kind: 'published.v1', title: 'Report' }))).toBe('/artifacts/x1');
    });

    it('filters by kind and title and orders by the chosen sort', () => {
        const rows = [
            artifact('a', { title: 'Beta notes' }, { updatedAt: 30, createdAt: 1 }),
            artifact('b', { title: 'alpha plan' }, { updatedAt: 10, createdAt: 3 }),
            artifact('c', { kind: 'work-board.v1', title: 'Gamma board' }, { updatedAt: 20, createdAt: 2 }),
            artifact('d', { kind: 'approval_request.v1', title: 'Alpha approval' }, { updatedAt: 99, createdAt: 9 }),
        ];
        const keys = (filter: Parameters<typeof projectArtifactBrowserRows>[1]) => projectArtifactBrowserRows(rows, filter).map((row) => row.key);
        expect(keys({ query: '', kind: 'all', sort: 'updated_desc' })).toEqual(['a', 'c', 'b']);
        expect(keys({ query: '', kind: 'all', sort: 'created_desc' })).toEqual(['b', 'c', 'a']);
        expect(keys({ query: '', kind: 'all', sort: 'title_asc' })).toEqual(['b', 'a', 'c']);
        expect(keys({ query: 'ALPHA', kind: 'all', sort: 'updated_desc' })).toEqual(['b']);
        expect(keys({ query: '', kind: 'board', sort: 'updated_desc' })).toEqual(['c']);
        expect([...countArtifactBrowserKinds(rows)]).toEqual([['document', 2], ['board', 1]]);
    });

    it('uses raw storage kind rather than normalized display kind for the canonical open target', () => {
        const row = artifact('unknown', { kind: 'workflow-definition.v1', title: 'Unknown document' }, {
            rawHeader: { kind: 'workflow-definition.v1 ', title: 'Unknown document' },
        });
        expect(classifyArtifactBrowserKind(row)).toBe('document');
        expect(resolveArtifactOpenRoute(row)).toBe('/artifacts/unknown');
        // Display-only legacy rows retain their existing presentation until a full read refreshes them.
        expect(resolveArtifactOpenRoute(artifact('workflow', { kind: 'workflow-definition.v1', title: 'Workflow' })))
            .toBe('/workflows/workflow');
    });

    it('reads provenance only when the producer recorded a complete source', () => {
        const source = { sessionId: 's1', machineId: 'm1', path: 'src/relay.ts', runId: 'r1' };
        expect(readArtifactProvenance(artifact('a', { title: 'x', source }))).toEqual(source);
        expect(readArtifactProvenance(artifact('b', { title: 'x', source: { sessionId: 's1', path: 'p' } }))).toBeNull();
        expect(readArtifactProvenance(artifact('c', { title: 'x' }))).toBeNull();
    });

    it('previews the loaded body, as code when its source is code, else the header excerpt, else nothing', () => {
        const code = artifact('a', { title: 'relayHandshake.ts', source: { sessionId: 's', machineId: 'm', path: 'src/relayHandshake.ts' } }, { body: 'export const x = 1;' });
        expect(readArtifactPreview(code)).toEqual({ kind: 'code', text: 'export const x = 1;', language: 'TypeScript' });
        expect(readArtifactPreview(artifact('b', { title: 'Notes' }, { body: '# Notes' }))).toEqual({ kind: 'markdown', text: '# Notes' });
        expect(readArtifactPreview(artifact('c', { title: 'Notes', excerpt: 'First lines' }))).toEqual({ kind: 'markdown', text: 'First lines' });
        expect(readArtifactPreview(artifact('d', { title: 'hero.png', mime: 'image/png' }))).toEqual({ kind: 'image', name: 'hero.png' });
        expect(readArtifactPreview(artifact('e', { title: 'Empty' }))).toEqual({ kind: 'none' });
        // A bounded preview must not expose half of a UTF-16 surrogate pair.
        const atBoundary = `${'a'.repeat(599)}😀tail`;
        expect(readArtifactPreview(artifact('f', { title: 'Unicode' }, { body: atBoundary })))
            .toEqual({ kind: 'markdown', text: 'a'.repeat(599) });
        expect(readArtifactPreview(artifact('g', { title: 'Unicode', excerpt: atBoundary })))
            .toEqual({ kind: 'markdown', text: 'a'.repeat(599) });
    });
});
