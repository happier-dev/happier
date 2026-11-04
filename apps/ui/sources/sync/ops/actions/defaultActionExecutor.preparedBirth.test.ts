import { afterEach, beforeEach, expect, it } from 'vitest';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, createTemplateRequesterExecutionHttpHeadersV1, encodeTemplateBirthExecutionAuthorizationV1, TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { SessionSpawnNewInputV2Schema, projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionPendingTemplateOnboardingRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { projectBotTemplateArtifactHeaderV1, type BotTemplateArtifactV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { McpServerCatalogRowMutationV1Schema, sealMcpServerCatalogContentV1, openMcpServerCatalogContentV1,
    MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import tweetnacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { readOriginalAccountActionAuthentication } = await import('@/sync/api/externalActionAccountTransport');
const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
const { resolveAccountScopedCryptoMaterialFromCredentials } = await import('@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials');
const { resetMcpServerCatalogSnapshotsForTests } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
const { resetMcpServerCatalogEngineForTests } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
beforeEach(async () => {
    resetMcpServerCatalogEngineForTests();
    resetMcpServerCatalogSnapshotsForTests();
    await homes.reset();
});
afterEach(() => {
    resetMcpServerCatalogEngineForTests();
    resetMcpServerCatalogSnapshotsForTests();
    standardCleanup();
});

it.each([
    { mode: 'plain', outcome: 'accepted' }, { mode: 'plain', outcome: 'lost_response' },
    { mode: 'plain', outcome: 'rejoined' }, { mode: 'plain', outcome: 'retired' },
    { mode: 'e2ee', outcome: 'accepted' }, { mode: 'e2ee', outcome: 'team' },
] as const)('commits an asleep browser Bot before content and host onboarding without Machine RPC ($mode/$outcome)', async ({ mode, outcome }) => {
    const serverId = await homes.addHome({ name: 'Birth Home', serverUrl: 'https://browser-birth.test',
        serverIdentityId: 'srv_birth', accountId: 'recipient', currentAccount: true, accountEncryptionMode: mode });
    const storedCredentials = await TokenStorage.getCredentialsForServerUrl('https://browser-birth.test', { serverId });
    if (!storedCredentials) throw new Error('Missing credentials');
    const credentials = mode === 'e2ee' ? { token: storedCredentials.token, secret: encodeBase64(new Uint8Array(32).fill(9), 'base64url') } : storedCredentials;
    if (mode === 'e2ee') await homes.switchAccount(serverId, 'recipient', credentials);
    let sessionDataEncryptionKey: string | null = null;
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'browser-bot-copy',
        executionTarget: { serverId, machineId: 'asleep-machine' }, directory: { kind: 'managed' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        identity: { bot: { kind: 'bot' }, createdAsBot: true }, memoryEnabled: false,
        organizationPlacement: { folderId: 'bot-section', tagIds: ['bot-tag'] },
        ...(outcome === 'team' ? { initialAccess: { grants: [{ subject: { kind: 'team', teamId: 'team' }, accessLevel: 'view', canApprovePermissions: false }] } } : {}) });
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'browser-birth',
        target: { kind: 'machine', machineId: 'asleep-machine' }, input: { creation: input } });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-root', binding: {
        accountId: 'recipient', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: mode,
        serverIdentityId: 'srv_birth', machineId: 'asleep-machine', custodianAccountId: 'recipient', installationId: 'asleep-installation',
        actionId: 'template.instantiate', requestId: envelope.requestId, target: envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), admittedMachineRole: 'manage' } });
    const events: string[] = [];
    const boundary = createSessionMetadataHttpBoundary(() => ({}));
    let audiencePrepared = false;
    const member = { content: tweetnacl.box.keyPair(), signing: tweetnacl.sign.keyPair() };
    homes.answer(serverId, 'GET /v2/sessions/browser-bot/data-key/envelopes', { select: () => ({ body: {
        status: 'required', summary: { prepared: audiencePrepared ? 1 : 0, pending: audiencePrepared ? 0 : 1, invalid: 0, recipientKeyUnavailable: 0 }, nextCursor: null,
        items: audiencePrepared ? [] : [{ recipientAccountId: 'team-member', envelopeState: 'missing', contentKey: { status: 'available',
            accountSigningPublicKey: [...member.signing.publicKey].map(value => value.toString(16).padStart(2, '0')).join(''),
            contentPublicKey: encodeBase64(member.content.publicKey, 'base64'),
            contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: member.signing.secretKey,
                contentPublicKey: member.content.publicKey }), 'base64') } }],
    } }) });
    homes.answer(serverId, 'PATCH /v2/sessions/browser-bot/data-key/envelopes', { select: async raw => {
        if (!raw || typeof raw !== 'object') throw new Error('Missing envelopes');
        const entries = Reflect.get(raw, 'entries');
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const key = sessionDataEncryptionKey ? await encryption.decryptEncryptionKey(sessionDataEncryptionKey) : null;
        expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(entries[0].encryptedDataKey, 'base64'),
            recipientSecretKeyOrSeed: member.content.secretKey })).toEqual(key);
        audiencePrepared = true;
        return { body: { appliedCount: 1 } };
    } });
    let bound = authorization;
    homes.answer(serverId, 'POST /v1/sessions', { select: async (raw, http) => {
        events.push('birth');
        expect(raw).toMatchObject({ templateRequesterAuthorization: { authorization, originalActionEnvelope: envelope },
            organizationPlacement: input.organizationPlacement, encryptionMode: mode });
        if (mode === 'plain') expect(raw).toMatchObject({ ownerMetadata: { t: 'plain', v: { system: { sessionCreationCorrespondenceV1: { recipe: {
                execution: { directory: { kind: 'managed' } }, agentTarget: input.agentTarget,
            } } } } } });
        if (!raw || typeof raw !== 'object') throw new Error('Missing birth');
        const body = { ...raw };
        Reflect.deleteProperty(body, 'templateRequesterAuthorization');
        sessionDataEncryptionKey = typeof Reflect.get(raw, 'dataEncryptionKey') === 'string' ? Reflect.get(raw, 'dataEncryptionKey') : null;
        bound = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, token: 'birth-root',
            binding: { ...authorization.binding, templateRequesterBirth: { sessionId: 'browser-bot', creationTag: Reflect.get(raw, 'tag') } } });
        const response = boundary.createSessionFromPost('browser-bot', { ...http.init, body: JSON.stringify(body) });
        response.headers.set(TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1, encodeTemplateBirthExecutionAuthorizationV1(bound));
        return { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) };
    } });
    homes.answer(serverId, '/v2/sessions/browser-bot/pending/template-onboarding', { select: async raw => {
        events.push('onboarding');
        if (outcome === 'team') expect(audiencePrepared).toBe(true);
        const body = SessionPendingTemplateOnboardingRequestV1Schema.parse(raw);
        expect(body.authorization).toEqual(bound);
        expect(body.request).toMatchObject({ targetMachineId: 'asleep-machine', requestedAction: { v: 1, kind: 'send_now' } });
        if (mode === 'plain') expect(body.request.content).toMatchObject({ t: 'plain', v: { meta: { happierProvenanceV1: { producer: 'hostOnboarding' } } } });
        else {
            expect(body.request.content.t).toBe('encrypted');
            expect(body.request.requestEqualityEvidenceV1).toMatchObject({ kind: 'e2eeTag' });
            const encryption = await createEncryptionFromAuthCredentials(credentials);
            const key = sessionDataEncryptionKey ? await encryption.decryptEncryptionKey(sessionDataEncryptionKey) : null;
            expect(key).not.toBeNull();
            const codec = await encryption.openEncryption(key);
            if (body.request.content.t !== 'encrypted') throw new Error('Expected sealed onboarding');
            const [record] = await codec.decrypt([decodeBase64(body.request.content.c, 'base64')]);
            expect(record).toMatchObject({ meta: { happierProvenanceV1: { producer: 'hostOnboarding' } } });
        }
        if (outcome === 'lost_response') return { dispatchThenFail: true };
        return { body: { v: 1, result: { status: events.filter(value => value === 'onboarding').length > 1 ? 'alreadyAccepted' : 'accepted', localId: body.request.localId } } };
    } });
    const executor = createDefaultActionExecutor();
    let expectedDisposition: 'created' | 'rejoined' = 'created';
    const run = () => invokeHostReviewedChildV1({ parent: { actionId: 'template.instantiate', input: { creation: projectNativeJsonValueForTransport(input) } },
        context: { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: 'recipient', actionCaller: { kind: 'host' },
            externalActionExecutionAuthorization: authorization, originalActionEnvelope: envelope, externalActionTarget: envelope.target },
        child: { action: 'session.spawn_new', role: 'create_bot', input: projectNativeJsonValueForTransport(projectSessionSpawnNewActionInputV2(input)) }, admittedReview: { action: 'session.spawn_new', role: 'create_bot', surface: 'ui' },
        invocationServices: { sessionCreation: { hostOnboarding: { templateName: 'Helper', templateVersion: '1.0.0' },
            beforeLaunch: async birth => { expect(birth).toMatchObject({ sessionId: 'browser-bot', disposition: expectedDisposition, metadataRevision: 0 }); events.push('content');
                if (outcome === 'retired') await homes.switchAccount(serverId, 'other-account'); } } },
        execute: (child, context, action) => executor.execute(action, child, context) });
    const result = await run();
    if (outcome === 'retired') {
        expect(events).toEqual(['birth', 'content']);
    } else {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'success', sessionId: 'browser-bot',
            initialInput: { status: outcome === 'lost_response' ? 'outcomeUnknown' : 'accepted' } } });
        expect(events).toEqual(['birth', 'content', 'onboarding']);
    }
    if (outcome === 'rejoined') {
        expectedDisposition = 'rejoined';
        const rejoined = await run();
        expect(rejoined, JSON.stringify(rejoined)).toMatchObject({ ok: true, result: { type: 'success', disposition: 'rejoined',
            sessionId: 'browser-bot', initialInput: { status: 'alreadyAccepted' } } });
        expect(events).toEqual(['birth', 'content', 'onboarding', 'birth', 'content', 'onboarding']);
    }
    expect(homes.requests.some(request => request.path.includes('/machines/'))).toBe(false);
});

it.each(['plain', 'e2ee'] as const)('instantiates released content and private instance through browser birth before Pending activation (%s)', async mode => {
    const serverId = await homes.addHome({ name: 'Template Home', serverUrl: 'https://browser-template.test',
        serverIdentityId: 'srv_template_birth', accountId: 'recipient', currentAccount: true, accountEncryptionMode: mode });
    const storedCredentials = await TokenStorage.getCredentialsForServerUrl('https://browser-template.test', { serverId });
    if (!storedCredentials) throw new Error('Missing credentials');
    const credentials = mode === 'e2ee' ? { token: storedCredentials.token, secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') } : storedCredentials;
    if (mode === 'e2ee') await homes.switchAccount(serverId, 'recipient', credentials);
    homes.answer(serverId, 'GET /v1/account/encryption/currentness', {
        body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials),
    });
    const readOwnerMetadata = (envelope: unknown) => {
        const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: mode, envelope,
            ...(mode === 'e2ee' ? { material: resolveAccountScopedCryptoMaterialFromCredentials(credentials) } : {}) });
        if (!opened.ok) throw new Error('Owner metadata unavailable');
        return opened.ownerMetadata;
    };
    const sourceId = '84a6bc9c-0418-44f6-a593-8a751bde13e0';
    const released = { v: 1, state: 'released', release: { v: 1, version: '1.0.0', changelog: '', releasedAtMs: 1,
        content: { v: 1, identity: { name: 'Helper', description: 'Reusable helper' }, instructions: { markdown: 'Help carefully.' },
            memoryRules: [], skills: [{ key: 'guide', title: 'Guide', bundleSchemaId: 'skills.skill_md_v1', entries: [
                { path: 'SKILL.md', contentBase64: 'LS0tCm5hbWU6IGd1aWRlCmRlc2NyaXB0aW9uOiBndWlkZQotLS0KSGVscC4=', contentKind: 'utf8' },
            ] }], needs: { software: [], connectedAccounts: [], mcpServers: [{ key: 'docs', requirement: 'required', name: 'Docs',
                purpose: 'Read documentation', skipConsequence: '', definition: { name: 'docs', transport: 'http', env: {},
                    remote: { url: { baseUrl: { kind: 'literal', value: 'https://example.com/mcp' }, query: [] },
                        headers: { 'X-Docs-Topic': { kind: 'input', key: 'topic' } } },
                    inputs: [{ key: 'topic', label: 'Topic', purpose: 'Select documentation', secret: false, required: true }] } }] },
            firstTask: 'Review my change' } } } satisfies BotTemplateArtifactV1;
    const seed = await captureLazyActionAccountContext(serverId);
    if (!seed) throw new Error('Missing Home');
    const source = await seed.homeHubArtifactTransport.create({ artifactId: sourceId,
        header: projectBotTemplateArtifactHeaderV1(released), body: JSON.stringify(released) });
    seed.dispose();
    const events: string[] = [];
    let originalAuthorization: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
    let birthAuthorization: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
    const expectAuthorization = (init: RequestInit | undefined, authorization: NonNullable<typeof originalAuthorization>) => {
        const expected = createTemplateRequesterExecutionHttpHeadersV1({ authorization, requesterToken: credentials.token,
            target: authorization.binding.target, effectActionId: 'template.instantiate' });
        if (!expected) throw new Error('Missing requester headers');
        for (const [key, value] of Object.entries(expected)) expect(new Headers(init?.headers).get(key)).toBe(value);
    };
    const boundary = createSessionMetadataHttpBoundary(() => ({}));
    const catalogMaterial = mode === 'e2ee' ? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : null;
    let catalogRevision = 0;
    let catalogContent = sealMcpServerCatalogContentV1({ mode, material: catalogMaterial,
        catalog: { v: 1, servers: [], bindings: [] } });
    homes.answer(serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { select: () => ({
        body: { status: 'present', revision: catalogRevision, content: catalogContent },
    }) });
    homes.answer(serverId, `POST ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { select: raw => {
        const mutation = McpServerCatalogRowMutationV1Schema.parse(raw);
        expect(mutation.expectedRevision).toBe(catalogRevision);
        if (!mutation.content) throw new Error('Expected MCP catalog content');
        catalogContent = mutation.content;
        catalogRevision += 1;
        return { body: { status: 'updated', revision: catalogRevision, cursor: catalogRevision } };
    } });
    homes.answer(serverId, '/v1/actions/template.instantiate/execution-authorization', { select: (raw, http) => {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(raw);
        const token = new Headers(http.init?.headers).get('Authorization')!.slice('Bearer '.length);
        originalAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'template-root', binding: { serverIdentityId: 'srv_template_birth', accountId: 'recipient',
            authentication: readOriginalAccountActionAuthentication(token), accountEncryptionMode: mode,
            ...(request.templateRequesterInitialAccessAdmission ? { templateRequesterInitialAccessAdmission: request.templateRequesterInitialAccessAdmission } : {}),
            machineId: 'offline-template-machine', installationId: 'asleep-installation', custodianAccountId: 'recipient',
            admittedMachineRole: 'manage', actionId: 'template.instantiate', requestId: request.envelope.requestId,
            target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) } });
        return { body: originalAuthorization };
    } });
    const readBatch = createSessionReadBatchFetchBoundary(async (url, init) => boundary.handle(url, init));
    homes.answer(serverId, 'POST /v2/sessions/read-batch', { select: async (_raw, http) => {
        if (!originalAuthorization) throw new Error('Missing root admission');
        expectAuthorization(http.init, originalAuthorization);
        const response = await readBatch(http.url, http.init);
        if (!response) throw new Error('Missing Session batch boundary');
        return { status: response.status, body: await response.json() };
    } });
    homes.answer(serverId, 'POST /v1/sessions', { select: async (raw, http) => {
        events.push('birth');
        if (!raw || typeof raw !== 'object') throw new Error('Missing birth');
        expect(readOwnerMetadata(Reflect.get(raw, 'ownerMetadata'))).toMatchObject({ work: { bot: { kind: 'bot' }, createdAsBot: true, memoryEnabled: false }, system: { sessionCreationCorrespondenceV1: { recipe: {
                identity: { bot: { kind: 'bot' }, createdAsBot: true }, memoryEnabled: false,
            } } } });
        const proof = Reflect.get(raw, 'templateRequesterAuthorization');
        const body = { ...raw };
        Reflect.deleteProperty(body, 'templateRequesterAuthorization');
        if (!proof || typeof proof !== 'object') throw new Error('Missing admitted proof');
        const root = ExternalActionExecutionAuthorizationV1Schema.parse(Reflect.get(proof, 'authorization'));
        const bound = ExternalActionExecutionAuthorizationV1Schema.parse({ ...root, token: 'template-birth-root', binding: {
            ...root.binding, templateRequesterBirth: { sessionId: 'browser-template-bot', creationTag: Reflect.get(raw, 'tag') } } });
        birthAuthorization = bound;
        const response = boundary.createSessionFromPost('browser-template-bot', { ...http.init, body: JSON.stringify(body) });
        return { body: await response.json(), headers: { [TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1]: encodeTemplateBirthExecutionAuthorizationV1(bound) } };
    } });
    for (const method of ['GET', 'PATCH']) homes.answer(serverId, `${method} /v2/sessions/browser-template-bot`, {
        select: async (_raw, http) => {
            if (mode === 'e2ee') {
                if (!originalAuthorization) throw new Error('Missing root admission');
                expectAuthorization(http.init, originalAuthorization);
            }
            const response = boundary.handle(http.url, http.init);
            if (!response) throw new Error('Missing Session transport');
            if (method === 'PATCH') events.push('content');
            return { status: response.status, body: await response.json() };
        },
    });
    homes.answer(serverId, 'GET /v2/sessions/browser-template-bot/data-key/envelopes', { select: (_raw, http) => {
        if (!birthAuthorization) throw new Error('Missing committed birth proof');
        expectAuthorization(http.init, birthAuthorization);
        events.push('audience');
        return { body: { status: 'required', items: [], nextCursor: null,
            summary: { prepared: 0, pending: 0, invalid: 0, recipientKeyUnavailable: 0 } } };
    } });
    homes.answer(serverId, '/v2/sessions/browser-template-bot/pending/template-onboarding', { select: async raw => {
        events.push('onboarding');
        const request = SessionPendingTemplateOnboardingRequestV1Schema.parse(raw);
        expect(request.authorization.token).toBe('template-birth-root');
        return { body: { v: 1, result: { status: 'accepted', localId: request.request.localId } } };
    } });
    const result = await createDefaultActionExecutor().execute('template.instantiate', {
        source: { kind: 'artifact', serverId, artifactId: sourceId }, expectedVersion: '1.0.0', expectedRevision: source.revision,
        setup: { software: [], accounts: [], mcpServers: [{ key: 'docs', selection: { action: 'bind',
            inputs: { topic: { t: 'literal', v: 'guide' } } } }] },
        creation: { creationKey: 'full-browser-template', executionTarget: { serverId, machineId: 'offline-template-machine' },
            directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, memoryEnabled: false,
            ...(mode === 'e2ee' ? { initialAccess: { grants: [{ subject: { kind: 'team', teamId: 'team' }, accessLevel: 'view', canApprovePermissions: false }] } } : {}) },
    }, { surface: 'ui', authority: 'present_user', serverId });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'success', sessionId: 'browser-template-bot', initialInput: { status: 'accepted' } } });
    const response = boundary.handle('https://browser-template.test/v2/sessions/browser-template-bot', {});
    const stored = await response!.json();
    const owner = readOwnerMetadata(stored.session.ownerMetadata);
    expect(owner.work?.templateInstance).toMatchObject({ v: 1,
        source: { kind: 'artifact', artifactId: sourceId }, acceptedVersion: '1.0.0' });
    expect(owner.work?.promptStack).toBeDefined();
    const selections = readSessionCapabilitySelectionFromMetadataV1(owner.runtime);
    expect(selections.skills.forceIncludeSkillIds).toHaveLength(1);
    const opened = openMcpServerCatalogContentV1({ mode, material: catalogMaterial, content: catalogContent });
    if (opened.status !== 'opened') throw new Error('MCP catalog unavailable');
    expect(opened.catalog.servers).toHaveLength(1);
    const server = opened.catalog.servers[0]!;
    expect(server.remote?.headers).toEqual({ 'X-Docs-Topic': { t: 'literal', v: 'guide' } });
    expect(selections.mcp.forceIncludeServerIds).toEqual([server.id]);
    expect(owner.work?.templateInstance).toMatchObject({ skillIds: { guide: selections.skills.forceIncludeSkillIds[0] },
        mcpServerIds: { docs: server.id } });
    expect(events[0]).toBe('birth');
    expect(events.at(-1)).toBe('onboarding');
    expect(events.filter(event => event === 'onboarding')).toHaveLength(1);
    if (mode === 'e2ee') expect(events).toContain('audience');
    expect(homes.requests.filter(request => request.path.includes('/machines/') && request.path !== '/v1/machines/read-batch')).toEqual([]);
});
