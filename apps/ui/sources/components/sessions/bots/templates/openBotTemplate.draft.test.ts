import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotTemplateActionInputSchemasV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { requestBotTemplateDraft } from './openBotTemplate';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import type { AccountPetLibraryEntryV1 } from '@happier-dev/protocol/pets/accountLibrary';
import { buildAccountPetCreateRequestV1 } from '@happier-dev/protocol/pets/importActionV1';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(() => { standardCleanup(); resetRuntimeFetch(); vi.restoreAllMocks(); });

describe('Give a copy…', () => {
    it.each(['registry', 'package', 'asset-refused', 'transport-failed'] as const)('preserves an Account pet through the draft boundary (%s)', async kind => {
        const profile = await upsertAndActivateServer({ serverUrl: 'https://pet-author.example.test', scope: 'tab' });
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'pet-author' })).toString('base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const origin: AccountPetLibraryEntryV1['origin'] = kind === 'registry'
            ? { kind: 'registry', sourceId: 'petdex', itemId: 'moss' } : { kind: 'manualImport' };
        const pet: AccountPetLibraryEntryV1 = {
            accountPetId: 'my-moss', packageFormat: 'codex-compatible-atlas-v1',
            manifest: { id: 'moss', displayName: 'Moss', description: 'A moss pet', spritesheetPath: 'spritesheet.webp' },
            spritesheetAssetRef: { assetId: 'moss-asset', mediaType: 'image/webp', digest: 'sha256:asset', sizeBytes: 3 },
            digest: 'sha256:package', sizeBytes: 3, createdAt: 1, updatedAt: 1, origin,
        };
        const reads: string[] = [];
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            reads.push(path);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            if (kind === 'transport-failed') throw Object.assign(new Error('network_error'), { code: 'network_error' });
            if (path === '/v1/account/pets') return Response.json({ ok: true, pets: [pet] });
            if (path.endsWith('/spritesheet')) return kind === 'asset-refused'
                ? Response.json({ ok: false, errorCode: 'forbidden', error: 'forbidden' }, { status: 403 })
                : new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/webp' } });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            throw new Error(`Unexpected pet author read ${path}`);
        });
        const session = createSessionFixture({ id: 'moss-bot', metadata: { path: '/garden', host: 'home', name: 'Moss keeper',
            bot: { kind: 'bot' }, botFace: { seed: 'moss-seed', pet: { kind: 'accountPet', accountPetId: 'my-moss' } },
        } as never });
        let draftInput: unknown;
        const execute = vi.fn(async (actionId: string, input: unknown) => {
            if (actionId === 'template.draft') draftInput = input;
            return { ok: false as const, errorCode: 'test_draft_observed', error: 'test_draft_observed' };
        });
        const result = await requestBotTemplateDraft(execute as never, session, profile.id);
        if (kind === 'asset-refused' || kind === 'transport-failed') {
            expect(result).toMatchObject({ ok: false, errorCode: kind === 'asset-refused' ? 'forbidden' : 'network_error' });
            expect(draftInput).toBeUndefined();
            return;
        }
        const expectedSource = kind === 'registry' ? origin : { kind: 'package', package: buildAccountPetCreateRequestV1({
            manifest: pet.manifest, mediaType: 'image/webp', spritesheetBytes: new Uint8Array([1, 2, 3]), origin,
        }) };
        expect(draftInput).toMatchObject({ content: { pet: { name: 'Moss', source: expectedSource }, identity: { face: { seed: 'moss-seed' } } } });
        const parsed = BotTemplateActionInputSchemasV1['template.draft'].parse(draftInput);
        expect(parsed.content.pet).toEqual({ name: 'Moss', source: expectedSource });
        expect(parsed.content.identity.face).not.toHaveProperty('pet');
        expect(reads.filter(path => path.endsWith('/spritesheet'))).toHaveLength(kind === 'registry' ? 0 : 1);
    });

    // REAL-USER-PASS F7: it sent the person's own chat message naming `template.draft` and opened nothing.
    it('drafts the template from this Bot through template.draft and opens that draft, never as a chat message', async () => {
        const session = createSessionFixture({ id: 'garden-bot', serverId: 'home', metadata: { path: '/garden', host: 'home', name: 'Garden keeper', flavor: 'codex',
            bot: { kind: 'bot' }, botFace: { seed: 'garden-seed' },
            work: { promptStack: [{ id: 'session.instructions', ref: { kind: 'doc', artifactId: 'garden-instructions' },
                enabled: true, required: true, placement: 'system_append' }] } } as never });
        const calls: Array<Readonly<{ actionId: string; input: unknown }>> = [];
        // The mounted Action executor is the boundary: each call is a real Action request with its own result.
        const execute = vi.fn(async (actionId: string, input: unknown) => {
            calls.push({ actionId, input });
            if (actionId === 'prompt_doc.get') return { ok: true as const, result: { ok: true, artifactId: 'garden-instructions',
                title: 'Garden keeper instructions', markdown: '# Garden\n\nWater herbs.', revision: { bodyVersion: 1, headerVersion: 1 } } };
            if (actionId === 'template.draft') return { ok: true as const, result: { draftArtifactId: '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f', revision: { bodyVersion: 1, headerVersion: 1 },
                sourceSessionRef: { serverId: 'home', sessionId: 'garden-bot' }, summary: { identity: { name: 'Garden keeper', description: '' },
                    includes: { memoryRules: 0, skills: 0, software: 0, connectedAccounts: 0, mcpServers: 0 }, leftOut: { memoryRules: 0, skills: 0 } } } };
            return { ok: true as const, result: { opened: true } };
        });
        const result = await requestBotTemplateDraft(execute as never, session, 'home');
        expect(result).toMatchObject({ ok: true });
        expect(calls.map(call => call.actionId)).not.toContain('session.message.send');
        const draft = calls.find(call => call.actionId === 'template.draft');
        const input = BotTemplateActionInputSchemasV1['template.draft'].parse(draft?.input);
        expect(input.sourceSessionRef).toEqual({ serverId: 'home', sessionId: 'garden-bot' });
        expect(input.content.identity).toMatchObject({ name: 'Garden keeper', face: { seed: 'garden-seed' } });
        expect(input.content.instructions.markdown).toBe('# Garden\n\nWater herbs.');
        // REAL-USER-PASS-2 G7: the editor started at "Choose…" although the Bot runs Codex.
        expect(input.content.suggestedAgent).toEqual({ agentId: 'codex' });
        expect(calls.at(-1)).toEqual({ actionId: 'template.open', input: { draftArtifactId: '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f',
            sourceSessionRef: { serverId: 'home', sessionId: 'garden-bot' }, presentation: 'pane' } });
    });
});
