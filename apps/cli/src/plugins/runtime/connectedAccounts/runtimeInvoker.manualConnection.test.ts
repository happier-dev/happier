import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { FeaturesResponseSchema, PluginConnectedAccountDescriptorContributionV2Schema, QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialPayloadV1Schema, openQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';
import type { ConnectedAccountReadContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as vercelVendor from '../../../../../../packages/plugins/machine-vercel/src/index';
import * as railwayVendor from '../../../../../../packages/plugins/machine-railway/src/index';
import * as digitalOceanVendor from '../../../../../../packages/plugins/machine-digitalocean/src/index';
import * as cloudflareDeployment from '../../../../../../packages/plugins/deploy-cloudflare/src/index';
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
import { createConnectedAccountDaemonRuntime } from '@/daemon/connectedServices/ConnectedAccountDaemonRuntime';
import { createQualifiedConnectedAccountDaemonPersistence } from '@/daemon/connectedServices/qualifiedConnectedAccountDaemonPersistence';
import { createPluginReloadController } from '../reload/controller';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';
import { createConnectedAccountHostRuntimeInvoker, type ConnectedAccountRuntimeEstablishedOperation } from './runtimeInvoker';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { resolveHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { createBoundMachineTargetResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createQualifiedConnectedAccountAttemptTransactionAdapters } from '@/daemon/connectedServices/qualifiedConnectedAccountAttemptTransactionAdapters';
import { createConnectedAccountAttemptTransactionApiBoundary } from '@/testkit/connectedAccountAttemptTransactionApi';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { StoredCredentials } from '@/persistence';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { SHARED_SAVED_SECRET_ACTION_PATHS_V1, SharedSavedSecretPromoteInputV1Schema, SharedSavedSecretPromoteOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { resolveQualifiedConnectedAccountCredentialValuesV1 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';

const cloudflareAccountId = 'a'.repeat(32);
const cloudflareTokenId = 'b'.repeat(32);

type ManualFixture = Readonly<{
    provider: 'telegram' | 'discord' | 'email' | 'vercel' | 'railway' | 'digitalocean' | 'cloudflare';
    manifest: typeof telegramManifest;
    runtime?: ConnectedAccountRuntime;
    entry?: typeof vercelVendor | typeof railwayVendor | typeof digitalOceanVendor | typeof cloudflareDeployment;
    modeId: string;
    fields: Readonly<Record<string, string>>;
    identity: unknown;
    rejection: unknown;
    configuration?: ConnectedAccountReadContext['configuration']['values'];
    expectedAccountId?: string;
    rejectionCode?: string;
    expectedOrigin?: string;
    localId?: string;
    oauth?: boolean;
    publicClient?: boolean;
    publicClientUnavailable?: boolean;
    accountMode?: 'plain' | 'e2ee';
    responsesByPath?: Readonly<Record<string, unknown>>;
    rejectionProbes?: readonly Readonly<{
        label: string;
        responsesByPath: Readonly<Record<string, unknown>>;
        statusesByPath?: Readonly<Record<string, number>>;
        code: string;
    }>[];
    expectedCredentialValues?: Readonly<Record<string, string>>;
}>;

describe('manual Connected Account production invocation', () => {
    const fixtures: readonly ManualFixture[] = [
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
        // Documentation-shape vectors, not captured tenant permission evidence.
        { provider: 'vercel', manifest: vercelVendor.manifest, entry: vercelVendor, localId: 'vercel-account',
            modeId: 'token', fields: { token: 'fixture-credential' },
            configuration: { teamId: 'team_fixture', projectId: 'prj_fixture' },
            identity: { id: 'prj_fixture', accountId: 'team_fixture', name: 'Fixture project' },
            rejection: { error: { code: 'invalid_token', message: 'fixture-credential' } },
            expectedAccountId: 'host-account', rejectionCode: 'vercel_invalid_token', expectedOrigin: 'https://api.vercel.com' },
        { provider: 'railway', manifest: railwayVendor.manifest, entry: railwayVendor, localId: 'railway-account',
            modeId: 'token', fields: { token: 'fixture-credential' },
            identity: { data: { me: { id: 'fixture-user', name: 'Fixture account', email: null } } }, rejection: {},
            expectedAccountId: 'host-account', rejectionCode: 'railway_invalid_token', expectedOrigin: 'https://backboard.railway.com' },
        { provider: 'digitalocean', manifest: digitalOceanVendor.manifest, entry: digitalOceanVendor, localId: 'digitalocean-account',
            modeId: 'token', fields: { token: 'fixture-credential' },
            identity: { account: { status: 'active' } }, rejection: {},
            expectedAccountId: 'host-account', rejectionCode: 'digitalocean_invalid_token', expectedOrigin: 'https://api.digitalocean.com' },
        { provider: 'cloudflare', manifest: cloudflareDeployment.manifest, entry: cloudflareDeployment,
            modeId: 'oauth', localId: 'cloudflare', oauth: true, fields: {},
            configuration: { clientId: 'registered-client',
                registeredScopes: 'account-settings.read workers-scripts.write workers-ci.write' },
            identity: {}, rejection: { error: 'invalid_grant', error_description: 'fixture-credential' },
            responsesByPath: {
                '/oauth2/token': { token_type: 'Bearer', access_token: 'fixture-credential', refresh_token: 'fixture-refresh', expires_in: 3600,
                    scope: 'openid offline_access account-settings.read workers-scripts.write workers-ci.write' },
                '/oauth2/userinfo': { sub: 'fixture-subject' },
                '/client/v4/oauth/scopes': { success: true, result: [
                    { id: 'account-settings.read', name: 'Account Settings Read', scopes: ['com.cloudflare.api.account'] },
                    { id: 'workers-scripts.write', name: 'Workers Scripts Write', scopes: ['com.cloudflare.api.account'] },
                    { id: 'workers-ci.write', name: 'Workers CI Write', scopes: ['com.cloudflare.api.account'] },
                ] },
                [`/client/v4/accounts/${cloudflareAccountId}`]: { success: true, result: { id: cloudflareAccountId, name: 'Fixture account' } },
                '/client/v4/accounts': { success: true, result: [{ id: cloudflareAccountId, name: 'Fixture account' }],
                    result_info: { page: 1, per_page: 20, total_count: 1 } },
            },
            rejectionProbes: [{ label: 'actual grant omits CI despite the full catalog', code: 'cloudflare_missing_permissions', responsesByPath: {
                '/oauth2/token': { token_type: 'Bearer', access_token: 'fixture-credential', refresh_token: 'fixture-refresh', expires_in: 3600,
                    scope: 'openid offline_access account-settings.read workers-scripts.write' },
            } }],
            expectedCredentialValues: { token: 'fixture-credential', refreshToken: 'fixture-refresh', accountId: cloudflareAccountId,
                subject: 'fixture-subject', scopes: JSON.stringify(['openid', 'offline_access', 'account-settings.read', 'workers-scripts.write', 'workers-ci.write']) },
            expectedAccountId: 'host-account', rejectionCode: 'cloudflare_oauth_reconnect_required', expectedOrigin: 'https://api.cloudflare.com' },
        { provider: 'cloudflare', manifest: cloudflareDeployment.manifest, entry: cloudflareDeployment,
            modeId: 'token', localId: 'cloudflare', fields: { token: 'fixture-credential' },
            configuration: { accountId: cloudflareAccountId, tokenOwner: 'user', features: ['Workers'] }, identity: {}, rejection: { success: false, errors: [{ code: 1000, message: 'fixture-credential' }] },
            responsesByPath: {
                [`/client/v4/accounts/${cloudflareAccountId}`]: { success: true, result: { id: cloudflareAccountId, name: 'Fixture account' } },
                '/client/v4/user/tokens/verify': { success: true, result: { id: cloudflareTokenId, status: 'active' } },
                // SIMPLIFY-PLUGINS-1104 A1: Connect checks selected-resource
                // readability; Cloudflare decides write access at the operation.
                [`/client/v4/accounts/${cloudflareAccountId}/workers/scripts`]: { success: true, result: [] },
            },
            rejectionProbes: [
                { label: 'selected Workers resource is denied', code: 'cloudflare_missing_permissions', responsesByPath: {
                    [`/client/v4/accounts/${cloudflareAccountId}/workers/scripts`]: { success: false, errors: [{ code: 10000, message: 'fixture-credential' }] },
                }, statusesByPath: { [`/client/v4/accounts/${cloudflareAccountId}/workers/scripts`]: 403 } },
                { label: 'mismatched account identity', code: 'cloudflare_account_mismatch', responsesByPath: {
                    [`/client/v4/accounts/${cloudflareAccountId}`]: { success: true, result: { id: 'f'.repeat(32), name: 'Other account' } },
                } },
            ],
            expectedCredentialValues: { token: 'fixture-credential', accountId: cloudflareAccountId, scopes: JSON.stringify(['Workers']) },
            expectedAccountId: 'host-account', rejectionCode: 'cloudflare_token_rejected', expectedOrigin: 'https://api.cloudflare.com' },
    ];
    it.each<ManualFixture>(fixtures.flatMap((fixture): ManualFixture[] => fixture.oauth ? [fixture,
      ...(['plain', 'e2ee'] as const).map(accountMode => ({
        ...fixture, publicClient: true, accountMode, configuration: {},
        expectedCredentialValues: { ...fixture.expectedCredentialValues, oauthClientId: 'registered-client',
            oauthRegisteredScopes: JSON.stringify(['account-settings.read', 'workers-scripts.write', 'workers-ci.write']) },
    })), { ...fixture, publicClientUnavailable: true, configuration: {} }]
      : [fixture]))('settles $provider/$modeId public=$publicClient/absent=$publicClientUnavailable/$accountMode with declared fixed-origin HTTP, including provider rejection', async fixture => {
        // Exercise a third-party installed contribution using the published
        // descriptor/runtime, not special handling of bundled plugin identities.
        const service = { pluginId: 'external.manual-accounts', localId: `${fixture.provider}-bot` };
        const manifest = normalizePluginManifestV2(fixture.manifest);
        const kit = fixture.entry ? await createPluginTestkit({ manifest: fixture.manifest, module: fixture.entry }) : null;
        const runtime = kit?.registration('connectedAccountDescriptors', fixture.localId ?? '') ?? fixture.runtime;
        expect(runtime, 'the published declaration must activate its Connected Account runtime').toBeDefined();
        if (!runtime) { await kit?.dispose(); throw new Error('Connected Account runtime was not registered'); }
        const expectedAccountId = fixture.expectedAccountId ?? 'bot:123456';
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
            readRegistrations: () => [{ pluginId: service.pluginId, occurrenceId, localId: service.localId, runtime }],
        });
        const requests: string[] = [];
        let rejectCredential = fixture.provider === 'email';
        let responseOverrides: Readonly<Record<string, unknown>> = {};
        let responseStatuses: Readonly<Record<string, number>> = {};
        let releasePendingRequest: (() => void) | undefined;
        let markPendingRequest: (() => void) | undefined;
        let now = 1_000;
        const profile = { id: 'laptop-profile', serverUrl: 'https://home.example.test', webappUrl: 'https://home.example.test' };
        const homeTarget = await resolveHomeTarget({ input: { kind: 'saved_profile', profileRef: profile.id }, readSavedProfile: async () => ({
            ...profile, homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_shared_home',
                canonicalServerUrl: profile.serverUrl, revision: 1, endpoints: [{ kind: 'https', url: profile.serverUrl }] },
        }) });
        let machineId = 'before-registration';
        const resolveExecutionMachine = createBoundMachineTargetResolver({
            resolveCurrentServerIdentityId: () => homeTarget.homeServerIdentityId,
            resolveCurrentMachineId: () => machineId,
        });
        // HTTP is the external boundary. Policy, registry,
        // invocation services, provider codecs and attempt settlement stay real.
        const http = createStablePluginHttpHost({ adapter: {
            async request(request) {
                const url = new URL(request.url);
                requests.push(url.origin);
                now = 2_000;
                machineId = 'auth-machine';
                if (markPendingRequest) {
                    const mark = markPendingRequest;
                    markPendingRequest = undefined;
                    await new Promise<void>(resolve => { releasePendingRequest = resolve; mark(); });
                }
                return { status: rejectCredential ? 401 : responseStatuses[url.pathname] ?? 200, finalUrl: request.url, headers: {},
                    body: new TextEncoder().encode(JSON.stringify(rejectCredential ? fixture.rejection
                        : responseOverrides[url.pathname] ?? fixture.responsesByPath?.[url.pathname] ?? fixture.identity)) };
            },
            async openWebSocket() { throw new Error('not used'); },
        } });
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, http });
        const invoker = createConnectedAccountHostRuntimeInvoker({
            resolveRuntime: ref => registry.resolve(ref),
            resolvePlugin: () => ({ version: '1.0.0', hostAccessRequests: manifest.hostAccess.required
                .map(request => ({ request, required: true })) }),
            resolveHostPolicy: owners.resolveInvocationHostPolicy,
            createServices: owners.createServices, registerRawForRedaction: owners.registerRawForRedaction,
        });
        const persisted: ReturnType<typeof QualifiedConnectedAccountCredentialMutationV4Schema.parse>[] = [];
        const encryption = fixture.accountMode === 'e2ee'
            ? { type: 'dataKey' as const, publicKey: new Uint8Array(32).fill(31), machineKey: new Uint8Array(32).fill(17) }
            : null;
        // The promotion owner consumes the authenticated Account identity, not
        // an opaque token invented below that trust boundary.
        const capturedCredentials: StoredCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'fixture-account' })).toString('base64url')}.signature`, encryption };
        const promotedResources: Pick<ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>, 'resourceId' | 'encryptionMode' | 'storedContent'>[] = [];
        const promotionHome = fixture.provider === 'vercel' ? Fastify() : null;
        let directCredentialWrites = 0;
        if (promotionHome) {
            promotionHome.get('/v1/features', async () => ({ features: { teams: { enabled: true } }, capabilities: {} }));
            promotionHome.get('/v1/account/saved-secrets/resources/materials', async () => ({ resources: [] }));
            promotionHome.post(SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote'], async request => {
                const promotion = SharedSavedSecretPromoteInputV1Schema.parse(request.body);
                const credential = QualifiedConnectedAccountCredentialMutationV4Schema.parse(promotion.connectedAccountCredentialMutation);
                persisted.push(credential);
                promotedResources.push(promotion, ...(promotion.additionalSavedSecretResources ?? []));
                return SharedSavedSecretPromoteOutputV1Schema.parse({ resourceId: promotion.resourceId, settingsVersion: 1,
                    connectedAccountCredential: { credentialRevision: 'csr_1234567890123456789012',
                        configurationRevision: 'initialConfiguration' in credential && credential.initialConfiguration ? 'configuration-1' : null } });
            });
        }
        const promotionBaseUrl = promotionHome ? await promotionHome.listen({ host: '127.0.0.1', port: 0 }) : null;
        const operationContext = promotionBaseUrl ? createInvocationSavedSecretOperationContextV1({
            credentials: capturedCredentials, serverHttpBaseUrl: promotionBaseUrl, isCurrent: async () => true,
            snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
                loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(capturedCredentials) },
        }) : undefined;
        const durableTransactions = createQualifiedConnectedAccountAttemptTransactionAdapters({ credentials: capturedCredentials,
            getAccountEncryptionMode: async () => fixture.accountMode ?? 'plain', getMachineId: () => machineId,
            now: () => now, api: createConnectedAccountAttemptTransactionApiBoundary() });
        const persistence = createQualifiedConnectedAccountDaemonPersistence({
            credentials: capturedCredentials, getAccountEncryptionMode: async () => fixture.accountMode ?? 'plain',
            attemptTransactions: durableTransactions, ...(operationContext ? { operationContext } : {}),
            // The already-delivered Home feature snapshot is the external input.
            // Configuration selection and runtime admission below remain real.
            ...(fixture.publicClient ? { resolveServerFeaturesSnapshot: () => ({ status: 'ready' as const, features: FeaturesResponseSchema.parse({
                features: {},
                // This Home serves its own web app, so its operator registered that relay.
                capabilities: { server: { webappUrl: 'http://happier-qa.localhost:19364' },
                    connectedServices: { qualifiedAccounts: { protocolVersion: 4 }, publicOAuthClients: [{ service,
                    clientId: 'registered-client', scopesByMode: { 'oauth': [
                        'account-settings.read', 'workers-scripts.write', 'workers-ci.write',
                    ] },
                }] } },
            }) }) } : {}),
            readCredential: async () => null, readConfiguration: async () => null,
            secrets: { admit: async () => {}, has: async () => false, read: async () => null },
            // Account HTTP is the persistence boundary; its strict request schema
            // consumes the actual daemon/attempt producer below.
            async mutateCredential(input) {
                directCredentialWrites += 1;
                const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(input.mutation);
                persisted.push(mutation);
                return { success: true, credentialRevision: 'csr_1234567890123456789012',
                    configurationRevision: 'initialConfiguration' in mutation && mutation.initialConfiguration ? 'configuration-1' : null };
            },
        });
        const configuration = createConnectedAccountConfigurationOwner({
            ...persistence.configuration,
            ...(!fixture.oauth ? { read: async () => fixture.provider === 'email' ? { revision: 'configuration-1', secretRefs: {}, values: {
                mailbox: 'wilson@example.test', imapHost: 'imap.example.test', imapPort: 993,
                smtpHost: 'smtp.example.test', smtpPort: 587,
            } } : fixture.configuration ? { revision: 'configuration-1', secretRefs: {}, values: fixture.configuration } : null,
            replace: async () => { throw new Error('not used'); }, destroyAttempt: async () => {} } : {}),
            isRuntimeCurrent: () => true,
        });
        // The external plugin loader supplies an admitted registry. Its contribution
        // registry, reload custody, invoker, attempt owner and settlement stay real.
        const runtimeRegistry = {
            contributes: { agents: [], providers: [], actions: [], resources: [], activationTargets: [] },
            pluginDiagnosticsByPluginId: {}, activatedPluginIds: new Set([service.pluginId]),
            connectedAccountContributions: registry, resolveConnectedAccountRuntime: registry.resolve,
            connectedAccountRuntimeInvoker: invoker, readPluginOccurrenceId: () => occurrenceId,
            readPluginSourceCustody: () => sourceCustody, fencePluginConsumers() {}, retirePluginConsumers: async () => {},
            dispose: async () => registry.dispose(),
        } as unknown as ResolvedExecutablePluginRuntimeRegistry;
        const reloadController = createPluginReloadController({ resolveRuntimeRegistry: async () => runtimeRegistry });
        let sequence = 0;
        const attempts = createConnectedAccountDaemonRuntime({
            createAttemptId: () => `manual-${++sequence}`, createAccountId: () => 'host-account', now: () => now,
            resolveExecutionMachine,
            reloadController, persistence, configurationOwner: configuration,
            configurationConsequences: { assertAvailable: async () => {}, apply: async () => {} },
            // Revocation is not part of this authentication journey.
            revocation: {} as never,
        });
        const begin = async () => {
            let result = await attempts.execute({ operation: 'beginConnect', service, modeId: mode.id });
            if (fixture.oauth && !fixture.publicClientUnavailable && result.status === 'configurationRequired') {
                const attemptId = result.attemptId;
                if (!attemptId) throw new Error('Own-client configuration has no attempt');
                // A person's own OAuth client enters through the real first-connect
                // configuration flow, rather than an invented service configuration.
                const saved = await configuration.replaceForControl({ target: { kind: 'attempt', attemptId, service, modeId: mode.id },
                    mode, expectedRevision: null, values: fixture.configuration ?? {}, secretValues: {}, occurrenceId, sourceCustody });
                if (saved.status !== 'committed' || !saved.snapshot.revision) throw new Error('Own-client configuration was not saved');
                result = await attempts.execute({ operation: 'continueConnect', attemptId,
                    expectedConfigurationRevision: saved.snapshot.revision });
            }
            if (!fixture.oauth || result.status !== 'starting') return result;
            const attemptId = result.attemptId;
            await expect.poll(async () => (await attempts.execute({ operation: 'read', attemptId })).status)
                .toBe(fixture.publicClientUnavailable ? 'configurationRequired' : 'awaitingOAuth');
            return attempts.execute({ operation: 'read', attemptId });
        };
        const submit = async (attemptId: string, fields = fixture.fields) => {
            if (!fixture.oauth) return attempts.execute({ operation: 'submitManual', attemptId, fields });
            const current = await attempts.execute({ operation: 'read', attemptId });
            if (current.status !== 'awaitingOAuth') throw new Error('OAuth attempt is not awaiting its callback');
            if (!current.authorizationUrl) throw new Error('OAuth attempt has no authorization URL');
            const state = new URL(current.authorizationUrl).searchParams.get('state')!;
            return attempts.execute({ operation: 'completeOAuth', attemptId, completion: { state, callbackUrl: current.callbackUrl,
                code: 'fixture-code', iss: 'https://dash.cloudflare.com' } });
        };
        try {
            if (fixture.publicClientUnavailable) {
                const unconfigured = await begin();
                expect(unconfigured).toMatchObject({ status: 'configurationRequired' });
                const control = await configuration.inspect({ target: { kind: 'attempt', attemptId: 'manual-1', service, modeId: mode.id },
                    mode, occurrenceId, sourceCustody });
                expect(control).toMatchObject({ mode: { configuration: { fields: [
                    { id: 'clientId', required: true }, { id: 'registeredScopes', required: true },
                ] } } });
                expect(await attempts.execute({ operation: 'read', attemptId: 'manual-1' }))
                    .toMatchObject({ status: 'configurationRequired' });
                expect(requests).toEqual([]);
                expect(persisted).toEqual([]);
                return;
            }
            const begun = await begin();
            expect(begun).toMatchObject({ status: fixture.oauth ? 'awaitingOAuth' : 'awaitingManual', attemptId: 'manual-1' });
            if (fixture.oauth && begun.status === 'awaitingOAuth') {
                // The Cloudflare mode declares no callback: the attempt uses the Home's relay.
                const relay = fixture.publicClient ? 'http://happier-qa.localhost:19364/oauth/connected-account/callback'
                    : 'https://cloud.happier.dev/oauth/connected-account/callback';
                expect(begun.callbackUrl).toBe(relay);
                expect(new URL(begun.authorizationUrl!).searchParams.get('redirect_uri')).toBe(relay);
            }
            if (fixture.provider === 'email') {
                // A real Microsoft 401 must reach the Email codec and settle as a
                // rejection, rather than unavailable before any provider HTTP.
                expect(await attempts.execute({ operation: 'submitManual', attemptId: 'manual-1', fields: fixture.fields })).toMatchObject({
                    status: 'rejected', code: 'email_mailbox_login_failed',
                });
                expect(await attempts.execute({ operation: 'read', attemptId: 'manual-1' })).toMatchObject({ status: 'awaitingManual' });
                expect(persisted).toEqual([]);
                expect(new Set(requests)).toEqual(new Set(['https://login.microsoftonline.com']));
                return;
            }
            const submitted = await submit('manual-1', { token: 'fixture-credential' });
            expect(submitted).toMatchObject({
                status: 'connected', account: { service, accountId: expectedAccountId },
            });
            expect(persisted).toHaveLength(1);
            expect(persisted[0]?.metadata.authenticationProvenance).toEqual({ authenticatedAt: 2_000,
                machine: { serverId: 'srv_shared_home', machineId: 'auth-machine' } });
            expect(persisted[0]!.content.t).toBe(encryption ? 'encrypted' : 'plain');
            const content = QualifiedConnectedAccountCredentialPayloadV1Schema.parse(openQualifiedConnectedAccountContentEnvelope(encryption
                ? { kind: 'credential', accountMode: 'e2ee', material: encryption, envelope: persisted[0]!.content }
                : { kind: 'credential', accountMode: 'plain', envelope: persisted[0]!.content }));
            if (fixture.provider === 'vercel') {
                expect(directCredentialWrites).toBe(0);
                expect(promotedResources).toHaveLength(1);
                expect(content.values).not.toHaveProperty('token');
                expect(content.secretRefs).toEqual({ token: formatSharedSavedSecretRefV1(promotedResources[0]!.resourceId) });
            }
            const resolved = await resolveQualifiedConnectedAccountCredentialValuesV1(content, async reference => {
                const resource = promotedResources.find(row => formatSharedSavedSecretRefV1(row.resourceId) === reference);
                if (resource?.encryptionMode !== 'plain') return null;
                const opened = openSavedSecretResourceStoredContentV1({
                    resourceId: resource.resourceId, mode: 'plain', storedContent: resource.storedContent });
                return opened?.v === 1 ? opened.value : null;
            });
            expect(resolved.values).toEqual(fixture.oauth ? { ...fixture.expectedCredentialValues, expiresAtMs: expect.any(String) }
                : fixture.expectedCredentialValues ?? { token: 'fixture-credential' });
            expect(await attempts.execute({ operation: 'read', attemptId: 'manual-1' })).toMatchObject({ status: 'connected' });
            const account = { service, accountId: expectedAccountId };
            const established = (operation: ConnectedAccountRuntimeEstablishedOperation = { kind: 'status' }) => invoker.invokeEstablished({
                target: { account, expectedCredentialRevision: 'credential-1', expectedRuntimeConfigurationRevision: 'configuration-1' },
                operation,
                context: { account, configuration: { target: { kind: 'account', account, modeId: mode.id },
                    revision: 'configuration-1', values: fixture.configuration ?? {}, getSecret: async () => null },
                    credentials: { get: async key => resolved.values[key] ?? null } },
                isConfigurationCurrent: () => true, isCredentialRevisionCurrent: () => true,
            });
            expect(await established()).toMatchObject({ status: 'connected' });
            if (fixture.oauth) {
                vi.useFakeTimers({ toFake: ['Date'] });
                vi.setSystemTime(Number(content.values.expiresAtMs) + 1);
                const beforeExpiry = requests.length;
                expect(await established()).toMatchObject({ status: 'expired' });
                expect(requests).toHaveLength(beforeExpiry);
                const refreshed = new Map<string, string>();
                const refresh = () => established({ kind: 'refresh', operationId: 'refresh-1', stagedCredentials: {
                    get: async key => refreshed.get(key) ?? null,
                    set: async (key, value) => { refreshed.set(key, value); }, delete: async key => { refreshed.delete(key); },
                } });
                expect(await refresh()).toMatchObject({ status: 'connected' });
                expect(refreshed.get('refreshToken')).toBe('fixture-refresh');
                expect(refreshed.get('token')).toBe('fixture-credential');
                refreshed.clear(); rejectCredential = true;
                expect(await refresh()).toMatchObject({ status: 'reconnectRequired', diagnostic: { code: 'cloudflare_oauth_reconnect_required' } });
                expect(refreshed.size).toBe(0); rejectCredential = false;
                expect(await established({ kind: 'revoke' })).toMatchObject({ status: 'remoteRevoked' });
                vi.useRealTimers();
            }
            rejectCredential = true;
            expect(await established()).toMatchObject({ status: 'reconnectRequired' });
            expect(await begin()).toMatchObject({ status: fixture.oauth ? 'awaitingOAuth' : 'awaitingManual', attemptId: 'manual-2' });
            expect(await submit('manual-2', { token: 'invalid-fixture-credential' })).toMatchObject({
                status: 'rejected', code: fixture.rejectionCode ?? `${fixture.provider}_bot_token_rejected`,
            });
            expect(await attempts.execute({ operation: 'read', attemptId: 'manual-2' }))
                .toMatchObject({ status: fixture.oauth ? 'rejected' : 'awaitingManual' });
            expect(persisted).toHaveLength(1);
            rejectCredential = false;
            for (const probe of fixture.rejectionProbes ?? []) {
                responseOverrides = probe.responsesByPath;
                responseStatuses = probe.statusesByPath ?? {};
                const attemptId = `manual-${sequence + 1}`;
                expect(await begin(), probe.label)
                    .toMatchObject({ status: fixture.oauth ? 'awaitingOAuth' : 'awaitingManual', attemptId });
                expect(await submit(attemptId), probe.label)
                    .toMatchObject({ status: 'rejected', code: probe.code });
                expect(await attempts.execute({ operation: 'read', attemptId }), probe.label)
                    .toMatchObject({ status: fixture.oauth ? 'rejected' : 'awaitingManual' });
                expect(persisted, probe.label).toHaveLength(1);
            }
            if (fixture.provider === 'cloudflare') {
                responseOverrides = {};
                responseStatuses = {};
                const attemptId = `manual-${sequence + 1}`;
                expect(await begin()).toMatchObject({ status: fixture.oauth ? 'awaitingOAuth' : 'awaitingManual', attemptId });
                const requestPending = new Promise<void>(resolve => { markPendingRequest = resolve; });
                const submission = submit(attemptId);
                await requestPending;
                try {
                    expect(await attempts.execute({ operation: 'cancel', attemptId })).toMatchObject({ status: 'cancelled' });
                } finally { releasePendingRequest?.(); }
                // Entered callbacks retain their invocation lifetime after local
                // cancellation, but cannot revive custody or commit credentials.
                expect(await submission).toMatchObject({ status: 'conflict', code: 'connected_account_attempt_cancelled' });
                expect(await attempts.execute({ operation: 'read', attemptId })).toMatchObject({
                    status: 'unavailable', code: 'connected_account_attempt_not_found',
                });
                expect(persisted).toHaveLength(1);
            }
            expect(new Set(requests)).toEqual(new Set([fixture.expectedOrigin ?? (fixture.provider === 'telegram' ? 'https://api.telegram.org' : 'https://discord.com'),
                ...(fixture.oauth ? ['https://dash.cloudflare.com'] : [])]));
        } finally { vi.useRealTimers(); attempts.dispose(); await reloadController.shutdown(); await kit?.dispose(); await promotionHome?.close(); }
    });
});
