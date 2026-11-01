import { describe, expect, it } from 'vitest';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { telegramConnectedAccountRuntime } from '../../../../../../packages/plugins/channel-telegram/src/auth/connectedAccountRuntime';
import { PLUGIN_MANIFEST as telegramManifest } from '../../../../../../packages/plugins/channel-telegram/src/plugin';
import { discordConnectedAccountRuntime } from '../../../../../../packages/plugins/channel-discord/src/auth/connectedAccountRuntime';
import { PLUGIN_MANIFEST as discordManifest } from '../../../../../../packages/plugins/channel-discord/src/plugin';
import { imapSmtpConnectedAccountRuntime } from '../../../../../../packages/plugins/channel-email/src/transports/imapSmtp/connectedAccount';
import { PLUGIN_MANIFEST as emailManifest } from '../../../../../../packages/plugins/channel-email/src/plugin';
import { createStablePluginHttpHost } from '../fetch/service';
import { createProductionPluginInvocationServiceOwners } from '../invocation/services/production';
import { createPluginRuntimeOccurrenceId } from '../runtimeSlots';
import { createConnectedAccountContributionRegistry } from './contributionRegistry';
import { createConnectedAccountConfigurationOwner } from '@happier-dev/cli-common/connectedAccounts';
import { createConnectedAccountAuthenticationAttemptOwner, type ConnectedAccountAttemptSettlementRequest } from '@happier-dev/cli-common/connectedAccounts';
import { createConnectedAccountHostRuntimeInvoker } from './runtimeInvoker';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';

type ManualFixture = Readonly<{
    provider: 'telegram' | 'discord' | 'email';
    manifest: typeof telegramManifest;
    runtime: ConnectedAccountRuntime;
    modeId: string;
    fields: Readonly<Record<string, string>>;
    identity: unknown;
    rejection: unknown;
}>;

describe('manual Connected Account production invocation', () => {
    it.each<ManualFixture>([
        { provider: 'telegram', manifest: telegramManifest, runtime: telegramConnectedAccountRuntime,
            modeId: 'bot-token', fields: { token: 'fixture-credential' },
            identity: { ok: true, result: { id: 123456, is_bot: true, username: 'fixture_bot', first_name: 'Fixture bot' } },
            rejection: { ok: false, error_code: 401, description: 'Unauthorized' } },
        { provider: 'discord', manifest: discordManifest, runtime: discordConnectedAccountRuntime,
            modeId: 'bot-token', fields: { token: 'fixture-credential' },
            identity: { id: '123456', bot: true, username: 'fixture_bot' }, rejection: { message: '401: Unauthorized', code: 0 } },
        { provider: 'email', manifest: emailManifest, runtime: imapSmtpConnectedAccountRuntime,
            modeId: 'microsoft-app-only', fields: { tenantId: 'tenant.example', clientId: 'fixture-client', clientSecret: 'invalid-fixture-secret' },
            identity: {}, rejection: { error: 'invalid_client' } },
    ])('settles $provider with declared fixed-origin HTTP, including provider rejection', async fixture => {
        // Exercise a third-party installed contribution using the published
        // descriptor/runtime, not special handling of bundled plugin identities.
        const service = { pluginId: 'external.manual-accounts', localId: `${fixture.provider}-bot` };
        const manifest = normalizePluginManifestV2(fixture.manifest);
        const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
            ...manifest.contributes.connectedAccountDescriptors[0], id: service.localId,
        });
        const mode = descriptor.authentication.modes.find(mode => mode.id === fixture.modeId)!;
        const occurrenceId = createPluginRuntimeOccurrenceId(service.pluginId);
        const sourceCustody = { kind: 'managed', immutableGenerationId: 'external-generation', installSource: 'archive' } as const;
        const registry = createConnectedAccountContributionRegistry({
            descriptors: [{ provenance: 'external', source: { kind: 'path' }, pluginId: service.pluginId, definition: descriptor }],
            readPluginOccurrenceId: () => occurrenceId, readPluginSourceCustody: () => sourceCustody,
            isPluginOccurrenceCurrent: (_pluginId, observed) => observed === occurrenceId,
            activateOnDemand: async () => {},
            readRegistrations: () => [{ pluginId: service.pluginId, occurrenceId, localId: service.localId, runtime: fixture.runtime }],
        });
        const requests: string[] = [];
        let rejectCredential = fixture.provider === 'email';
        // HTTP and DNS are genuine external boundaries. Policy, registry,
        // invocation services, provider codecs and attempt settlement stay real.
        const http = createStablePluginHttpHost({  adapter: {
            async request(request) {
                requests.push(new URL(request.url).origin);
                return { status: rejectCredential ? 401 : 200, finalUrl: request.url, headers: {},
                    body: new TextEncoder().encode(JSON.stringify(rejectCredential ? fixture.rejection : fixture.identity)) };
            },
            async openWebSocket() { throw new Error('not used'); },
        } });
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, http });
        const configuration = createConnectedAccountConfigurationOwner({
            read: async () => fixture.provider === 'email' ? { revision: 'configuration-1', secretRefs: {}, values: {
                mailbox: 'wilson@example.test', imapHost: 'imap.example.test', imapPort: 993,
                smtpHost: 'smtp.example.test', smtpPort: 587,
            } } : null, replace: async () => { throw new Error('not used'); }, destroyAttempt: async () => {},
            secrets: { admit: async () => {}, has: async () => false, read: async () => null },
            isRuntimeCurrent: () => true,
        });
        const invoker = createConnectedAccountHostRuntimeInvoker({
            resolveRuntime: ref => registry.resolve(ref),
            resolvePlugin: () => ({ version: '1.0.0', hostAccessRequests: manifest.hostAccess.required
                .map(request => ({ request, required: true })) }),
            resolveHostPolicy: owners.resolveInvocationHostPolicy,
            createServices: owners.createServices, registerRawForRedaction: owners.registerRawForRedaction,
        });
        const persisted: ConnectedAccountAttemptSettlementRequest[] = [];
        let sequence = 0;
        const attempts = createConnectedAccountAuthenticationAttemptOwner({
            createAttemptId: () => `manual-${++sequence}`, createAccountId: () => 'host-account', now: () => 1000,
            accounts: { readExact: async () => null }, configuration,
            runtime: {
                async admit() {
                    const lease = await registry.resolve(service);
                    if (!lease) throw new Error('missing runtime');
                    return { service, descriptor: mode, modeId: mode.id, occurrenceId, sourceCustody,
                        runtimeCustody: { lease, invoke: input => invoker.invokeAuthentication({ ...input, isConfigurationCurrent: configuration.isCurrent }), release: async () => {} } };
                },
                isCurrent: () => true,
                invoke: input => invoker.invokeAuthentication({ ...input, isConfigurationCurrent: configuration.isCurrent }),
            },
            oauth: { create: async () => { throw new Error('not used'); } },
            // The persistence boundary records the real prepared credential.
            settlement: { async settle(request) { persisted.push(request); return { status: 'connected', account: { service, accountId: request.accountId } }; } },
        });
        try {
            expect(await attempts.beginConnect({ service, modeId: mode.id })).toMatchObject({ status: 'awaitingManual', attemptId: 'manual-1' });
            if (fixture.provider === 'email') {
                // A real Microsoft 401 must reach the Email codec and settle as a
                // rejection, rather than unavailable before any provider HTTP.
                expect(await attempts.submitManual({ attemptId: 'manual-1', fields: fixture.fields })).toMatchObject({
                    status: 'rejected', code: 'email_mailbox_login_failed',
                });
                expect(await attempts.read({ attemptId: 'manual-1' })).toMatchObject({ status: 'rejected' });
                expect(persisted).toEqual([]);
                expect(new Set(requests)).toEqual(new Set(['https://login.microsoftonline.com']));
                return;
            }
            expect(await attempts.submitManual({ attemptId: 'manual-1', fields: { token: 'fixture-credential' } })).toMatchObject({
                status: 'connected', account: { service, accountId: 'bot:123456' },
            });
            expect(persisted).toHaveLength(1);
            expect(persisted[0]?.stagedCredentials).toEqual({ token: 'fixture-credential' });
            expect(await attempts.read({ attemptId: 'manual-1' })).toMatchObject({ status: 'connected' });
            const account = { service, accountId: 'bot:123456' };
            const established = () => invoker.invokeEstablished({
                target: { account, expectedCredentialRevision: 'credential-1', expectedRuntimeConfigurationRevision: 'configuration-1' },
                operation: { kind: 'status' },
                context: { account, configuration: { target: { kind: 'account', account, modeId: mode.id },
                    revision: 'configuration-1', values: {}, getSecret: async () => null },
                    credentials: { get: async key => persisted[0]?.stagedCredentials[key] ?? null } },
                isConfigurationCurrent: () => true, isCredentialRevisionCurrent: () => true,
            });
            expect(await established()).toMatchObject({ status: 'connected' });
            rejectCredential = true;
            expect(await established()).toMatchObject({ status: 'reconnectRequired' });
            expect(await attempts.beginConnect({ service, modeId: mode.id })).toMatchObject({ status: 'awaitingManual', attemptId: 'manual-2' });
            expect(await attempts.submitManual({ attemptId: 'manual-2', fields: { token: 'invalid-fixture-credential' } })).toMatchObject({
                status: 'rejected', code: `${fixture.provider}_bot_token_rejected`,
            });
            expect(await attempts.read({ attemptId: 'manual-2' })).toMatchObject({ status: 'rejected' });
            expect(persisted).toHaveLength(1);
            expect(new Set(requests)).toEqual(new Set([fixture.provider === 'telegram' ? 'https://api.telegram.org' : 'https://discord.com']));
        } finally { attempts.dispose(); registry.dispose(); }
    });
});
