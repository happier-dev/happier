import { onTestFinished } from 'vitest';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, MarketplaceIndexSourceSnapshotV1Schema } from '@happier-dev/protocol/marketplace';
import { deriveRegistrySourceIdV1, HAPPIER_PICKS_SOURCE_ID, type RegistrySourceV1 } from '@happier-dev/protocol/registries';
import { SharedSavedSecretListOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { standardCleanup } from '@/dev/testkit';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createPromptLibraryCatalogBoundary } from './promptLibraryCatalogBoundary';
import { createPlainArtifactHomeFixture } from './artifactStoreBoundary';
import { createPromptRegistrySkillFixture } from './promptMachineTransferBoundary';

/** Real registry Actions, Account CAS and adapters over the Home/GitHub HTTP boundaries. */
export async function createRegistrySourcesUiHome(suffix: string, options: Readonly<{
    picks?: boolean;
    token?: RegistrySourceV1['token'];
    savedSecretResourceIds?: readonly string[];
    source?: RegistrySourceV1;
    /** Extra Home HTTP behavior, including delayed persistence responses. */
    handleRequest?: (path: string, init?: RequestInit) => Promise<Response | null>;
    /** A registry link outside the fixture repository (checked before the defaults). */
    external?: (url: string, init?: RequestInit) => Promise<Response | null>;
}> = {}) {
    const sourceUrl = options.source?.url ?? 'https://github.com/fixture/skills';
    const sourceId = options.source?.id ?? deriveRegistrySourceIdV1(sourceUrl);
    const skill = createPromptRegistrySkillFixture({ sourceId, itemId: 'review', title: 'review', files: [
        { path: 'SKILL.md', content: '---\nname: review\ndescription: Review changes\n---\nRead the diff.' },
        { path: 'check.sh', content: '#!/bin/sh\nexit 0', unixMode: 0o755 },
    ] });
    if (skill.item.payload.kind !== 'skill') throw new Error('Expected skill fixture');
    const payload = skill.item.payload.skill;
    const source: RegistrySourceV1 = options.source ?? { id: sourceId, title: 'Review skills', format: 'git', kinds: ['skill'],
        url: sourceUrl, enabled: true, addedAt: 1, ...(options.token ? { token: options.token } : {}) };
    const externalRequests: string[] = [];
    const initial = PromptLibraryRecordV1Schema.parse({
        key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [source] },
    });
    const catalog = createPromptLibraryCatalogBoundary({ records: [initial], revision: 4,
        tombstones: PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== initial.key) });
    let failRulesWrites = false;
    let failContentAfter: number | null = null;
    let contentWrites = 0;
    let headCommit = payload.ref.commit;
    const homeFixture = await createPlainArtifactHomeFixture(`https://registry-ui-${suffix}.test`, {
        handleRequest: async (path, init) => {
            const response = await options.handleRequest?.(path, init);
            if (response) return response;
            if (path === '/v1/artifacts' && init?.method === 'POST') {
                if (failContentAfter !== null && contentWrites >= failContentAfter)
                    return Response.json({ error: 'quota_exceeded' }, { status: 400 });
                contentWrites++;
            }
            const resourceRequest = new URL(path, 'https://registry-fixture.test');
            if (resourceRequest.pathname === '/v1/account/saved-secrets/resources/materials'
                || resourceRequest.pathname === '/v1/account/saved-secrets/resources') {
                const materials = SavedSecretResourceMaterialsResponseV1Schema.parse({
                    resources: (options.savedSecretResourceIds ?? [])
                        .filter(resourceId => !resourceRequest.searchParams.has('resourceId') || resourceRequest.searchParams.get('resourceId') === resourceId)
                        .map(resourceId => ({ resourceId, encryptionMode: 'plain',
                        storedContent: { t: 'plain', v: { v: 1, name: resourceId, kind: 'token', value: 'fixture-token' } }, recipientEnvelope: null,
                        entry: { ref: formatSharedSavedSecretRefV1(resourceId), source: 'shared_resource', relationship: 'owner', ownerAccountId: 'artifact-account',
                            name: resourceId, kind: 'token', revision: 1, materialStatus: 'ready',
                            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                    })),
                });
                return Response.json(resourceRequest.pathname.endsWith('/materials') ? materials
                    : SharedSavedSecretListOutputV1Schema.parse({ resources: materials.resources.map(resource => resource.entry) }));
            }
            if (failRulesWrites && path.endsWith('/skill-rules') && init?.method === 'POST')
                return Response.json({ error: 'unavailable' }, { status: 503 });
            return catalog.handle(path, init);
        }, handleExternalRequest: async (url, init) => {
        externalRequests.push(url);
        const custom = await options.external?.(url, init);
        if (custom) return custom;
        if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return Response.json(MarketplaceIndexSourceSnapshotV1Schema.parse({
            source: { id: HAPPIER_PICKS_SOURCE_ID, title: 'Happier picks', kind: 'curated', sourceUrl: url },
            freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [],
            picks: options.picks ? [{ kind: 'skill', format: 'git', sourceUrl, itemId: 'review' }] : [],
        }));
        if (url.includes('/.claude-plugin/marketplace.json')) return new Response(null, { status: 404 });
        if (url === 'https://api.github.com/repos/fixture/skills') return Response.json({ name: 'skills', default_branch: 'main' });
        if (url.startsWith('https://api.github.com/repos/fixture/skills/commits/')) {
            const ref = url.slice(url.lastIndexOf('/') + 1);
            return Response.json({ sha: /^[0-9a-f]{40}$/.test(ref) ? ref : headCommit });
        }
        if (url.includes('/git/trees/')) return Response.json({ sha: payload.ref.treeSha, tree: [
            { path: 'review', type: 'tree', mode: '040000', sha: payload.ref.treeSha },
            ...payload.files.map(file => ({ path: `review/${file.path}`, type: 'blob', mode: file.unixMode === 0o755 ? '100755' : '100644', sha: file.blobSha, size: file.size })),
        ] });
        if (url.startsWith('https://raw.githubusercontent.com/fixture/skills/')) {
            const file = skill.files.find(candidate => url.endsWith(`/review/${candidate.path}`));
            if (file) return new Response(Buffer.from(file.contentBase64, 'base64').toString('utf8'));
        }
        return new Response(null, { status: 404 });
    } });
    const home = { ...homeFixture, read: () => ({ record: catalog.read('registry-sources'), revision: catalog.revision('registry-sources') }) };
    onTestFinished(async () => { await standardCleanup(); await home.dispose(); });
    return { home, source, sourceId, skill, externalRequests, catalog, setRulesUnavailable: (next: boolean) => { failRulesWrites = next; },
        setContentUnavailableAfter: (count: number | null) => { failContentAfter = count; },
        moveBranch: () => { headCommit = 'b'.repeat(40); } };
}
