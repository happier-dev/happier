import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectContextUpdateInputV1Schema } from '@happier-dev/protocol/projects/projectContextV1';
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { PromptStackEntryV1Schema } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { storage } from '@/sync/domains/state/storage';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createUiProjectContextAction } from './projectContextAction';

// Third-party Markdown rendering is outside this row/Artifact transport journey.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => { throw new Error('Unexpected rendering'); } }));

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let foreignHomeId: string | undefined;
afterEach(async () => { if (foreignHomeId) await removeServerProfile(foreignHomeId); foreignHomeId = undefined; fixture?.dispose(); fixture = undefined; resetRuntimeFetch(); vi.restoreAllMocks(); });

describe('UI private Project context Action transport', () => {
  it('uses current Artifact reads and exact row CAS, preserves neighbors, and acknowledges repeat attaches without another write', async () => {
    const home = await createPlainArtifactHomeFixture('https://project-context.test');
    fixture = home;
    const foreignHome = await upsertServerProfile({ serverUrl: 'https://foreign-project-context.test', name: 'Foreign Context Home' });
    foreignHomeId = foreignHome.id;
    await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
      id: 'doc', header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Instructions' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'Current instructions', createdAtMs: 0, updatedAtMs: 0 }) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }) });
    const key = { kind: 'project-organization' as const, serverId: home.home.id, projectKey: 'anchor' };
    const retained = PromptStackEntryV1Schema.parse({ id: 'retained', ref: { kind: 'doc', artifactId: 'other' }, placement: 'provider_asset' });
    let row: ProjectAccountRowV1 = { key, revision: 4, content: { t: 'plain', v: { key, value: { hidden: true, pinned: true, promptStack: [retained] } } } };
    let writes = 0;
    const foreignRequests: string[] = [];
    // Only HTTP/persisted rows are represented here; real Account opening, Artifact codecs,
    // context admission, CAS semantics and projection all execute below this boundary.
    setRuntimeFetch(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== new URL('https://project-context.test').origin) { foreignRequests.push(String(url)); throw new Error('Wrong Home'); }
      if (url.pathname === '/health' || url.pathname === '/v1/features' || url.pathname === '/v1/auth/ping') return new Response('{}');
      if (url.pathname === '/v1/account/encryption') return new Response(JSON.stringify({ mode: 'plain', updatedAt: 0 }));
      if (url.pathname.endsWith('/project-rows/list')) return new Response(JSON.stringify({ status: 'listed', coverage: 'complete', rows: [row] }));
      if (url.pathname.endsWith('/project-rows/mutate')) {
        const request = ProjectAccountRowMutationRequestV1Schema.parse(JSON.parse(String(init?.body)));
        const mutation = request.mutations[0]!;
        if (mutation.expectedRevision !== row.revision) return new Response(JSON.stringify({ status: 'conflict', key, revision: row.revision }));
        writes++;
        row = { key, revision: row.revision + 1, content: mutation.content };
        return new Response(JSON.stringify({ status: 'updated', rows: [row], cursor: writes }));
      }
      return await home.boundary.handle(`${url.pathname}${url.search}`, init) ?? new Response('{}', { status: 404 });
    });
    storage.getState().activateProjectAccountRowsScope({ serverId: home.home.id, accountId: 'artifact-account' });
    const account = await captureLazyActionAccountContext(home.home.id);
    try {
      const action = createUiProjectContextAction(account);
      const input = ProjectContextUpdateInputV1Schema.parse({ target: { serverId: home.home.id, projectKey: 'anchor' }, expectedRevision: 4,
        intent: { kind: 'attach', entry: { id: 'new', ref: { kind: 'doc', artifactId: 'doc', serverId: home.home.id }, required: true } } });
      const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: home.home.id, runtimeAccountId: account.accountId };
      const foreignInput = { ...input, intent: { kind: 'attach' as const, entry: { id: 'new', enabled: true, placement: 'system_append' as const,
        ref: { kind: 'doc' as const, artifactId: 'doc', serverId: foreignHome.id } } } };
      expect(await action(foreignInput, { ...context, externalActionCredential: { accountId: account.accountId, principalId: 'principal',
        credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 } })).toEqual({ ok: false, errorCode: 'artifact_unavailable' });
      expect(await action(foreignInput, { ...context, externalActionExecutionAuthorization: { v: 1, token: 'signed-request', binding: {
        accountId: account.accountId, custodianAccountId: account.accountId, principalId: 'principal', credentialId: 'credential',
        grant: API_TOKEN_FULL_GRANT_V1, serverIdentityId: 'home-identity', machineId: 'machine', installationId: 'installation',
        actionId: 'projects.context.update', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
      } } })).toEqual({ ok: false, errorCode: 'artifact_unavailable' });
      expect(await action(input, context)).toMatchObject({ ok: true, revision: 5, row: { hidden: true, pinned: true, promptStack: [retained, { id: 'new', required: true }] } });
      expect(await action({ ...input, expectedRevision: 5 }, context)).toMatchObject({ ok: true, revision: 5 });
      expect(await action(input, context)).toEqual({ ok: false, errorCode: 'project_context_conflict', currentRevision: 5 });
      home.boundary.clear();
      expect(await action({ ...input, expectedRevision: 5 }, context)).toEqual({ ok: false, errorCode: 'artifact_unavailable' });
      expect(await action({ ...input, target: { ...input.target, serverId: 'foreign' } }, context)).toEqual({ ok: false, errorCode: 'project_context_access_denied' });
      expect(await action(input, { ...context, runtimeAccountId: 'other' })).toEqual({ ok: false, errorCode: 'project_context_access_denied' });
      expect(await action(input, { ...context, serverId: 'foreign' })).toEqual({ ok: false, errorCode: 'project_context_access_denied' });
      expect(writes).toBe(1);
      expect(foreignRequests).toEqual([]);
      expect(storage.getState().projectAccountRows?.organizations[0]?.value).toMatchObject({ hidden: true, pinned: true, promptStack: [retained, { id: 'new' }] });
    } finally { account.dispose(); }
  });
});
