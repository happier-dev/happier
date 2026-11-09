import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createPlainArtifactHomeFixture, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { sealPublicShareDataKeyV1 } from '@happier-dev/protocol/crypto/publicShareEncryptedDataKeyEnvelopeV0';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { BotTemplateReleaseV1Schema, projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { resolveNativeAppLinkHref } from '@/utils/url/nativeAppLink';
import { ArtifactSignedInLinkScreen } from './ArtifactSignedInLinkScreen';
import { t } from '@/text';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { await home?.dispose(); home = undefined; });

describe('authenticated template link opening', () => {
    it('joins through the original link again after a later release and refuses an unavailable link without showing stale content', async () => {
        const secret = 'e'.repeat(43);
        let version = '1.0.0';
        let refusal: 'artifact_not_found' | 'artifact_access_forbidden' | null = null;
        const commits: unknown[] = [];
        const releasedArtifact = () => ({ v: 1 as const, state: 'released' as const,
            release: BotTemplateReleaseV1Schema.parse({ v: 1, version, releasedAtMs: 1, changelog: '',
                content: { v: 1, identity: { name: 'Garden', description: 'Garden advice' },
                    instructions: { markdown: `Grow herbs ${version}` }, skills: [], memoryRules: [],
                    needs: { software: [], connectedAccounts: [], mcpServers: [] } } }) });
        home = await createPlainArtifactHomeFixture('https://signed-template-reread.test', { currentAccount: true,
            handleRequest: async (path, init) => {
                if (path !== '/v1/artifact-signed-in-links/reread/join') return null;
                if (refusal) return Response.json({ error: refusal }, { status: refusal === 'artifact_not_found' ? 404 : 403 });
                if (init?.method === 'POST') {
                    commits.push(JSON.parse(String(init.body)));
                    home!.boundary.seedAccountGrant('released-template', 'artifact-account', 'view');
                    return Response.json({ artifactId: 'released-template', ownerAccountId: 'author', access: 'view' });
                }
                const artifact = releasedArtifact();
                return Response.json({ artifactId: 'released-template', authorAccountId: 'author', recipientAccountId: 'artifact-account',
                    recipientContentKey: { status: 'unavailable', reason: 'plain_account' },
                    subject: { kind: 'artifact', id: 'released-template' }, encryptionMode: 'plain', encryptedDataKey: null,
                    keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff: false,
                    content: { kind: 'artifact', header: encodePlainArtifactStoredContent(projectBotTemplateArtifactHeaderV1(artifact)),
                        body: encodePlainArtifactStoredContent({ body: JSON.stringify(artifact) }),
                        headerVersion: version === '1.0.0' ? 1 : 2, bodyVersion: version === '1.0.0' ? 1 : 2 } });
            } });
        for (const nextVersion of ['1.0.0', '1.1.0']) {
            version = nextVersion;
            const artifact = releasedArtifact();
            home.boundary.replaceStoredRow(createPlainArtifactHttpFixture({ id: 'released-template', isDecrypted: true,
                title: 'Garden', header: projectBotTemplateArtifactHeaderV1(artifact), body: JSON.stringify(artifact),
                access: 'owner', publicAudience: 'retained', headerVersion: version === '1.0.0' ? 1 : 2,
                bodyVersion: version === '1.0.0' ? 1 : 2, seq: 1, createdAt: 1, updatedAt: 1 }, 'author'));
            resolveNativeAppLinkHref(`happier://share/artifact/reread#k=${secret}`);
            const screen = await renderScreen(<ArtifactSignedInLinkScreen lookupId="reread" serverId={home.home.id} />,
                { wrapper: React.StrictMode });
            await screen.pressByTestIdAsync('artifact-signed-in-link-open');
            await vi.waitFor(() => expect(screen.findByTestId('bot-template-instructions-disclosure')).not.toBeNull());
            await screen.pressByTestIdAsync('bot-template-instructions-disclosure');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(`Grow herbs ${version}`));
            expect(screen.findByTestId('bot-template-make-own')).not.toBeNull();
            await screen.unmount();
        }
        expect(commits).toEqual([{}, {}]);
        for (const [code, message] of [['artifact_not_found', 'shareSheet.documents.errors.notFound'],
            ['artifact_access_forbidden', 'shareSheet.documents.errors.noAccess']] as const) {
            refusal = code;
            resolveNativeAppLinkHref(`happier://share/artifact/reread#k=${secret}`);
            const denied = await renderScreen(<ArtifactSignedInLinkScreen lookupId="reread" serverId={home.home.id} />,
                { wrapper: React.StrictMode });
            await denied.pressByTestIdAsync('artifact-signed-in-link-open');
            await vi.waitFor(() => expect(denied.getTextContent()).toContain(t(message)));
            expect(denied.getTextContent()).not.toContain('Grow herbs');
            expect(denied.findByTestId('bot-template-make-own')).toBeNull();
            await denied.unmount();
        }
        expect(commits).toHaveLength(2);
        expect(home.requests.filter(request => request.path.includes('/artifact-signed-in-links/')).map(request => request.method))
            .toEqual(['GET', 'POST', 'GET', 'POST', 'GET', 'GET']);
        expect(JSON.stringify(home.requests)).not.toContain(secret);
        expect(home.boundary.list().map(row => ({ id: row.id, owner: row.ownerAccountId })))
            .toEqual([{ id: 'released-template', owner: 'author' }]);
    });

    it.each([false, true])('shows the encrypted-Account reason to a Plain opener without offering a copy (effect replay: %s)', async replay => {
        const joinBodies: unknown[] = [];
        const release = BotTemplateReleaseV1Schema.parse({ v: 1, version: '1.0.0', releasedAtMs: 1, changelog: '',
            content: { v: 1, identity: { name: 'Garden', description: 'Garden advice' }, instructions: { markdown: 'Grow herbs' },
                skills: [], memoryRules: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } });
        const artifact = { v: 1 as const, state: 'released' as const, release };
        const secret = 'c'.repeat(43);
        const dataKey = new Uint8Array(32).fill(9);
        const encryption = new ArtifactEncryption(dataKey);
        const header = await encryption.encryptHeader(projectBotTemplateArtifactHeaderV1(artifact));
        const body = await encryption.encryptBody({ body: JSON.stringify(artifact) });
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        const destination = await upsertServerProfileOnly({ serverUrl: 'https://signed-template-recipient.test' });
        resolveNativeAppLinkHref(`happier://share/artifact/invite#k=${secret}`);
        const screen = await renderScreen(<ArtifactSignedInLinkScreen lookupId="invite" serverId={destination.id} />,
            replay ? { wrapper: React.StrictMode } : undefined);
        expect(screen.findByTestId('artifact-signed-in-link-open')?.props.disabled).toBe(true);
        home = await createPlainArtifactHomeFixture('https://signed-template-recipient.test', { currentAccount: true,
            handleRequest: async (path, init) => {
                if (path !== '/v1/artifact-signed-in-links/invite/join') return null;
                joinBodies.push(init?.body);
                return init?.method === 'POST' ? Response.json({ artifactId: 'released-template', ownerAccountId: 'author', access: 'view' })
                    : Response.json({ artifactId: 'released-template', authorAccountId: 'author', recipientAccountId: 'artifact-account',
                        recipientContentKey: { status: 'unavailable', reason: 'plain_account' },
                        subject: { kind: 'artifact', id: 'released-template' }, encryptionMode: 'e2ee',
                        encryptedDataKey: sealPublicShareDataKeyV1({ dataKey, secret, randomBytes: length => new Uint8Array(length).fill(2) }),
                        keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff: false,
                        content: { kind: 'artifact', header, body, headerVersion: 1, bodyVersion: 1 } });
            } });
        const joins = () => home!.requests.filter(request => request.path.includes('/artifact-signed-in-links/'));
        expect(joins()).toEqual([]);
        await vi.waitFor(() => expect(screen.findByTestId('artifact-signed-in-link-open')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('artifact-signed-in-link-open');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('botTemplates.encryptedAccountRequired')));
        expect(joins().map(request => request.method)).toEqual(['GET']);
        expect(JSON.stringify(home.requests)).not.toContain(secret);
        expect(joinBodies).toEqual([undefined]);
        expect(screen.findByTestId('bot-template-make-own')).toBeNull();
        expect(screen.getTextContent()).not.toContain('Grow herbs');
        expect(screen.findByTestId('artifact-signed-in-link-open')).toBeNull();
        expect(home.boundary.list()).toEqual([]);
        await screen.unmount();
    });
});
