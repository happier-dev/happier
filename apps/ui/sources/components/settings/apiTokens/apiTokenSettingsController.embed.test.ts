import { describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildEmbedParentGrantV1, type EmbedConfigV1 } from '@happier-dev/protocol/embed';

// Randomness is a genuine system boundary; the controller must send exactly this selector.
const uuid = vi.hoisted(() => ({ next: '33333333-3333-4333-8333-333333333333' }));
vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => uuid.next }));

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import { createApiTokenSettingsController, type ApiTokenSettingsExecute } from './apiTokenSettingsController';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');

const EMBED_CONFIG: EmbedConfigV1 = {
    v: 1,
    ui: { attachments: true },
    newChat: null,
    organization: { folderId: null, tagIds: ['tag-inbound'] },
    style: null,
};
const GRANT = buildEmbedParentGrantV1({
    send: true, approve: false, changeModel: false, models: null, permissionModes: null, sites: ['https://crm.acme.dev'], create: null,
}, EMBED_CONFIG);

const EMBED_TOKEN = {
    tokenId: uuid.next,
    label: 'Leads dashboard',
    displayPrefix: 'hap_v1_33333333',
    createdAt: '2026-09-30T12:00:00.000Z',
    lastUsedAt: null,
    expiresAt: '2026-12-29T12:00:00.000Z',
    hasEncryptionAccess: false,
    hasUnattendedTeamAccess: false,
    grant: GRANT,
    parentTokenId: null,
    activeChildCount: 2,
    embedConfig: EMBED_CONFIG,
};

function lifetime(): ActiveServerAccountScopeLifetime {
    return {
        scope: { serverId: 'server-a', accountId: 'account-a' },
        isCurrent: () => true,
        onRetire: () => ({ dispose() {} }),
    };
}

const ok = (result: unknown): ActionExecuteResult => ({ ok: true, result });

function harness(results: readonly ActionExecuteResult[]) {
    const queue = [...results];
    const execute = vi.fn<ApiTokenSettingsExecute>(async () => queue.shift() ?? ok({ tokens: [] }));
    const controller = createApiTokenSettingsController({
        execute,
        captureActiveAccountScopeLifetime: lifetime,
        now: () => NOW,
    });
    return { controller, execute };
}

describe('API token controller for embeds', () => {
    it('creates an embed-backed token with its grant and embed configuration, then reveals it once', async () => {
        const { controller, execute } = harness([
            ok({ token: `hap_v1_${EMBED_TOKEN.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, apiToken: EMBED_TOKEN }),
        ]);
        controller.setCreateDraft({ label: 'Leads dashboard', expiryPreset: '90d', access: 'limited', grant: GRANT, embedConfig: EMBED_CONFIG });

        await controller.createToken();

        expect(execute).toHaveBeenCalledWith(
            'account.apiTokens.create',
            expect.objectContaining({ tokenId: EMBED_TOKEN.tokenId, label: 'Leads dashboard', grant: GRANT, embedConfig: EMBED_CONFIG }),
            expect.anything(),
        );
        expect(controller.getState().reveal?.apiToken.embedConfig).toEqual(EMBED_CONFIG);
    });

    it('updates a token with exactly the requested change and adopts the stored row', async () => {
        const updated = { ...EMBED_TOKEN, embedConfig: { ...EMBED_CONFIG, ui: { attachments: false } } };
        const { controller, execute } = harness([ok({ tokens: [EMBED_TOKEN] }), ok({ apiToken: updated })]);
        await controller.refresh();

        const error = await controller.updateToken({ tokenId: EMBED_TOKEN.tokenId, embedConfig: updated.embedConfig });

        expect(error).toBeNull();
        expect(execute).toHaveBeenLastCalledWith(
            'account.apiTokens.update',
            { tokenId: EMBED_TOKEN.tokenId, embedConfig: updated.embedConfig },
            expect.anything(),
        );
        expect(controller.getState().tokens).toEqual([updated]);
    });

    it('reports a refused update and keeps the listed row', async () => {
        const { controller } = harness([ok({ tokens: [EMBED_TOKEN] }), { ok: false, errorCode: 'network_error', error: 'network_error' }]);
        await controller.refresh();

        const error = await controller.updateToken({ tokenId: EMBED_TOKEN.tokenId, label: 'Renamed' });

        expect(error).toBe('network_error');
        expect(controller.getState().tokens).toEqual([EMBED_TOKEN]);
    });
});
