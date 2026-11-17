import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { FIRST_PARTY_SKILLS_V1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readSkillLibraryItems } from './readSkillLibraryItems';
import { readSkillLibraryDigests, readSkillLibraryInventory } from './readSkillLibraryContent';

describe('skill library name inventory', () => {
  it('uses skill frontmatter identity instead of display titles and excludes generic bundles', async () => {
    const artifact = (artifactId: string, bundleSchemaId: string, markdown: string) => ({
      artifactId, ownerAccountId: 'account', access: 'owner' as const, headerVersion: 1,
      seq: 1, createdAt: 1, updatedAt: 1,
      header: { v: 1, kind: 'prompt_bundle.v2', title: 'A display title', bundleSchemaId },
      body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1,
        entries: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from(markdown).toString('base64') }] }),
    });
    // Persistence inventory is the external boundary; frontmatter parsing stays real.
    const store = { list: async () => ({ coverage: 'complete' as const, items: [
      artifact('skill-lint', 'skills.skill_md_v1', '---\nname: lint\ndescription: Checks changes\n---\nUse it.'),
      artifact('generic', 'bundle.generic_v1', '---\nname: ignored\n---\nGeneral bundle.'),
    ] }) };
    await expect(readSkillLibraryItems(store)).resolves.toEqual([{ id: 'skill-lint', name: 'lint' },
      ...FIRST_PARTY_SKILLS_V1.map(skill => ({ id: skill.skillId, name: skill.name }))]);
    await expect(readSkillLibraryItems({ list: async () => ({ coverage: 'partial', items: [] }) }))
      .rejects.toMatchObject({ code: 'catalog_unavailable' });
  });
  it('uses every transport page for both names and GC/delivery roots, and rejects an unreadable later page', async () => {
    const artifact = (artifactId: string) => ({ artifactId, ownerAccountId: 'account', access: 'owner' as const,
      headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      header: { v: 1, kind: 'prompt_bundle.v2', title: artifactId, bundleSchemaId: 'skills.skill_md_v1' },
      body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
        contentBase64: Buffer.from(`---\nname: ${artifactId}\n---\nBody`).toString('base64') }] }),
    });
    const store = { read: async () => null, list: async (options?: Readonly<{ cursor?: string; limit?: number }>) =>
      options?.cursor === 'next' ? { coverage: 'complete' as const, items: [artifact('second')] }
        : { coverage: 'complete' as const, items: [artifact('first')], nextCursor: 'next' } };
    await expect(readSkillLibraryItems(store)).resolves.toEqual([{ id: 'first', name: 'first' }, { id: 'second', name: 'second' },
      ...FIRST_PARTY_SKILLS_V1.map(skill => ({ id: skill.skillId, name: skill.name }))]);
    await expect(readSkillLibraryInventory(store)).resolves.toMatchObject([{ artifactId: 'first' }, { artifactId: 'second' }]);
    await expect(readSkillLibraryInventory({ ...store, list: async options => options?.cursor
      ? { coverage: 'partial', items: [] } : { coverage: 'complete', items: [artifact('first')], nextCursor: 'next' } }))
      .rejects.toMatchObject({ code: 'catalog_unavailable' });
  });
  it('marks GC from the complete body inventory when individual reads are unavailable, and withholds unreadable marks', async () => {
    const bundles = ['first', 'second'].map(name => ({ v: 1 as const, createdAtMs: 1, updatedAtMs: 1, entries: [
      { path: 'SKILL.md', contentKind: 'utf8' as const,
        contentBase64: Buffer.from(`---\nname: ${name}\n---\nRead references/file.bin.`).toString('base64') },
      { path: 'references/file.bin', contentKind: 'binary' as const, contentBase64: 'AAEC/w==', unixMode: 0o755 },
    ] }));
    let unreadable = false;
    // HTTP and persisted Account mode are genuine external boundaries; the
    // Artifact client, envelope decoder, inventory and bundle digest stay real.
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.setHeader('content-type', 'application/json');
      if (url.pathname === '/v1/artifacts') {
        const items = bundles.map((body, index) => ({
          id: `skill-${index}`, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
          // The default list order is newest-updated first, so the first bundle is the newest.
          seq: index + 1, createdAt: 1, updatedAt: bundles.length - index,
          header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: `Skill ${index}`,
            bundleSchemaId: 'skills.skill_md_v1' }),
          ...(url.searchParams.get('includeBody') === 'true' && !(unreadable && index === 1)
            ? { body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }) } : {}),
        }));
        // The current filtered HTTP list returns classification coverage alongside its rows.
        response.end(JSON.stringify(url.searchParams.has('kind') ? { items, hasUnclassified: false } : items));
      } else if (url.pathname === '/v1/plugins/availability/materializations/read') {
        response.end(JSON.stringify({ availabilityCursor: 0, inventoryComplete: true, snapshots: [], releases: [] }));
      } else if (url.pathname.startsWith('/v1/artifacts/')) {
        response.statusCode = 503; response.end(JSON.stringify({ error: 'individual_read_unavailable' }));
      } else response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test HTTP address unavailable');
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    try {
      const read = () => runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`,
        () => readSkillLibraryDigests({ token, encryption: null }));
      await expect(read()).resolves.toEqual([...bundles.map(computePromptBundleDigestV1), ...FIRST_PARTY_SKILLS_V1.map(skill =>
        computePromptBundleDigestV1({ v: 1, entries: [...skill.files], createdAtMs: 0, updatedAtMs: 0 }))]);
      unreadable = true;
      await expect(read()).resolves.toBeNull();
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
