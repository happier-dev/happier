import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEmbedParentGrantV1, type EmbedConfigV1 } from '@happier-dev/protocol/embed';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

// Randomness is a genuine system boundary; the controller must send exactly this selector.
const uuid = vi.hoisted(() => ({ next: '33333333-3333-4333-8333-333333333333' }));
vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => uuid.next }));

import {
    apiTokenReadWireFixture,
    createApiTokenSettingsControllerHarness,
    disposeApiTokenSettingsControllerHarnesses,
    type ApiTokenSettingsControllerHarnessOptions,
} from './apiTokenSettingsControllerTestHarness';

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

async function harness(options: ApiTokenSettingsControllerHarnessOptions = {}) {
    return createApiTokenSettingsControllerHarness({ mode: 'plain', ...options });
}

describe('API token controller for embeds', () => {
    afterEach(async () => {
        await disposeApiTokenSettingsControllerHarnesses();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('creates an embed-backed token with its grant and embed configuration, then reveals it once', async () => {
        const { controller, requests } = await harness();
        controller.setCreateDraft({ label: 'Leads dashboard', expiryPreset: '90d', access: 'limited', grant: GRANT, embedConfig: EMBED_CONFIG });

        await controller.createToken();

        expect(requests.find((request) => request.path === '/v1/auth/api-tokens/create')?.body).toMatchObject({
            tokenId: EMBED_TOKEN.tokenId,
            label: { content: { t: 'plain', v: 'Leads dashboard' }, recipients: [] },
            grant: GRANT,
            embedConfig: EMBED_CONFIG,
        });
        expect(controller.getState().reveal?.apiToken.embedConfig).toEqual(EMBED_CONFIG);
        controller.retire();
    });

    it('updates a token with exactly the requested change and adopts the stored row', async () => {
        const updated = { ...EMBED_TOKEN, embedConfig: { ...EMBED_CONFIG, ui: { attachments: false } } };
        const { controller, requests } = await harness({ rows: [apiTokenReadWireFixture(EMBED_TOKEN)] });
        await controller.refresh();

        const error = await controller.updateToken({ tokenId: EMBED_TOKEN.tokenId, embedConfig: updated.embedConfig });

        expect(error).toBeNull();
        expect(requests.find((request) => request.path === '/v1/auth/api-tokens/update')?.body).toEqual({
            tokenId: EMBED_TOKEN.tokenId, embedConfig: updated.embedConfig,
        });
        expect(controller.getState().tokens).toEqual([updated]);
        controller.retire();
    });

    it('reports a refused update and keeps the listed row', async () => {
        const { controller } = await harness({ rows: [apiTokenReadWireFixture(EMBED_TOKEN)], updateFailure: 'network' });
        await controller.refresh();

        const error = await controller.updateToken({ tokenId: EMBED_TOKEN.tokenId, label: 'Renamed' });

        expect(error).toBe('outcome_unknown');
        expect(controller.getState().tokens).toEqual([EMBED_TOKEN]);
        controller.retire();
    });
});
