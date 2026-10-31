import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { arePluginMachineExecutionOriginsEqual, definePlugin, PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import { arePluginMachineExecutionRoutingsEqual, getPluginMachineExecutionRouting, type PluginMachineExecutionOriginV1 } from '@happier-dev/plugin-sdk/actions';
import { ConversationObservationV1Schema, ConversationProvidersContributionProtocolV1, assertConversationChannelsCoreCallerV1 } from '@happier-dev/channels-protocol/v1';
import { createConversationProviderSetupResultV1Fixture, assertConversationProviderContributionV1 } from '@happier-dev/channels-protocol/testing/v1';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { CHANNELS_PLUGIN, PLUGIN_MANIFEST } from './manifest.js';
import { ChannelFileValueV1Schema, channelFileSessionAttachments } from './channelAttachment.js';
import { prepareChannelFileSessionInput } from './channelAttachmentRuntime.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';
import { channelsTargetedContributionServices } from './testkit/operationOnlyTargetedContributionsFixture.js';
import { textPdf } from './testkit/textPdf.js';

async function resolveFixtureFile(input: Readonly<{ bytes: Uint8Array; mediaType: string; machineId?: string; authorityEpoch?: number; fetchErrorCode?: string; omitAttachmentRegistration?: boolean;
  originKind?: 'materialization' | 'source';
  files?: readonly Readonly<{ bytes: Uint8Array; mediaType: string }>[]; operation?: 'repeat' | 'concurrent' | 'cancel' | 'fail';
}>) {
  const directory = await mkdtemp(join(tmpdir(), 'happier-channel-file-'));
  const materializedPath = join(directory, 'session-file');
  const files = input.files ?? [input];
  const stagedPaths: string[] = [];
  const deliveredBytes: Buffer[] = [];
  const controller = new AbortController();
  let dispatchStarted = false;
  let fetchCount = 0;
  const roles = ConversationProvidersContributionProtocolV1.operations;
  const providerDefinition = definePlugin({
    id: 'test.channel.files', version: '0.0.0',
    actions: {
      setup: { title: 'Set up', scopes: ['global'], inputSchema: { type: 'object' }, resultSchema: roles.setup.declaration.resultSchema.jsonSchema,
        surfaces: roles.setup.declaration.surfaces, dangerLevel: roles.setup.declaration.dangerLevel,
        run: async () => createConversationProviderSetupResultV1Fixture() },
      probe: { title: 'Probe', scopes: ['global'], inputSchema: roles.connectionTest.declaration.input.schema.jsonSchema,
        resultSchema: roles.connectionTest.declaration.resultSchema.jsonSchema, surfaces: roles.connectionTest.declaration.surfaces,
        dangerLevel: roles.connectionTest.declaration.dangerLevel, run: async () => ({ kind: 'notReady', reason: 'network' }) },
      deliver: { title: 'Deliver', scopes: ['global'], inputSchema: roles.messageDeliver.declaration.input.schema.jsonSchema,
        resultSchema: roles.messageDeliver.declaration.resultSchema.jsonSchema, surfaces: roles.messageDeliver.declaration.surfaces,
        dangerLevel: roles.messageDeliver.declaration.dangerLevel, run: async () => ({ kind: 'notDelivered', reason: 'unsupported' }) },
      file: { title: 'Fetch file', scopes: ['global'], inputSchema: roles.attachmentFetch.declaration.input.schema.jsonSchema,
        resultSchema: roles.attachmentFetch.declaration.resultSchema.jsonSchema, surfaces: roles.attachmentFetch.declaration.surfaces,
        dangerLevel: roles.attachmentFetch.declaration.dangerLevel, run: async (request, context) => {
          fetchCount += 1;
          assertConversationChannelsCoreCallerV1(context);
          if (dispatchStarted && input.machineId === 'machine-2') throw new PluginError({ code: 'plugin_action_execution_origin_mismatch', message: 'The provider-local file is on the other machine.' });
          if (input.fetchErrorCode) throw new PluginError({ code: input.fetchErrorCode, message: 'The provider generation retired.' });
          const { attachmentIds } = roles.attachmentFetch.declaration.input.schema.parse(request);
          return { kind: 'fetched', attachments: attachmentIds.map(attachmentId => ({ attachmentId,
            base64: Buffer.from(files[Number(attachmentId.slice(5)) - 1]!.bytes).toString('base64') })) };
        } },
    },
    contributesTo: { 'happier.channels': { providers: { files: ConversationProvidersContributionProtocolV1.contribute({ descriptor: { v: 1, displayName: 'Files test' }, operations: {
        setup: roles.setup.bind('setup'), connectionTest: roles.connectionTest.bind('probe'),
        messageDeliver: roles.messageDeliver.bind('deliver'), attachmentFetch: roles.attachmentFetch.bind('file'),
      } }) } } },
  });
  assertConversationProviderContributionV1(providerDefinition.manifest);
  const materializationRef = { pluginId: 'test.channel.files', machineId: 'machine-1', materializationId: 'file-provider' };
  const provider = await createPluginTestkit({ manifest: providerDefinition.manifest, module: providerDefinition,
    resolveCurrentPluginMaterializationRef: () => materializationRef });
  const transportOrigin: PluginMachineExecutionOriginV1 = input.originKind === 'source'
    ? { serverIdentityId: 'srv_plugin_testkit', sourceRef: { pluginId: materializationRef.pluginId,
      machineId: materializationRef.machineId,
      sourceCustody: { kind: 'development', registeredRootId: '/source-bundle/channel-files' } } }
    : { serverIdentityId: 'srv_plugin_testkit', materializationRef };
  const connection = createCurrentConversationConnectionFixture({ connectionId: 'connection-1', authority: {
    providerPluginId: 'test.channel.files', providerContributionSelection: { contributionId: 'files' }, providerSetupInput: {},
    credentialRef: null, providerConnectionKey: 'fixture:provider', providerConfig: {}, routingIdentityKey: 'r'.repeat(43),
    integrationPrincipal: { id: 'fixture:integration' }, authorityEpoch: 1,
    transportOrigin,
  } });
  let target: PluginTestkit | undefined;
  const driverDefinition = definePlugin({
    id: 'happier.channels', version: '0.0.0',
    hostAccess: PLUGIN_MANIFEST.hostAccess,
    actions: { resolve: { title: 'Resolve files', scopes: ['session'], surfaces: ['plugin'], dangerLevel: 'safe',
      hostAccess: ['account-storage', 'bound-session'],
      inputSchema: { type: 'object' }, resultSchema: { type: 'object' }, run: async (_request, originalContext) => {
        const actions = originalContext.services.actions;
        // The synthetic SDK host stamps materializations only. Adapt that
        // genuine host boundary while retaining real provider Action dispatch.
        const context = input.originKind !== 'source' ? originalContext : {
          ...originalContext,
          services: { ...originalContext.services, actions: { ...actions,
            async executeAdmittedTargetedOperationWithExecutionOrigin(operation, request, options) {
              if (options?.expectedExecutionOrigin && !arePluginMachineExecutionOriginsEqual(options.expectedExecutionOrigin, transportOrigin)) {
                throw new PluginError({ code: 'plugin_action_execution_origin_mismatch', message: 'The provider source changed.' });
              }
              if (options?.expectedExecutionRouting && !arePluginMachineExecutionRoutingsEqual(options.expectedExecutionRouting, getPluginMachineExecutionRouting(transportOrigin))) {
                throw new PluginError({ code: 'plugin_action_execution_origin_mismatch', message: 'The provider routing changed.' });
              }
              const execution = await actions.executeAdmittedTargetedOperationWithExecutionOrigin(operation, request, { signal: options?.signal });
              return { ...execution, executionOrigin: transportOrigin };
            },
          } },
        } satisfies typeof originalContext;
        const resolve = target?.registration('composerAttachments', 'channel-file')?.resolveForDispatch;
        if (!resolve) throw new PluginError({ code: 'fixture_attachment_resolver_missing', message: 'The registered channel-file resolver is missing.' });
        const observation = ConversationObservationV1Schema.parse({
          v: 1, occurrenceId: 'file-observation', occurredAt: 1, transport: { kind: 'poll' },
          endpoint: { kind: 'direct', audience: 'direct', id: 'mailbox' },
          actor: { principalId: 'sender', kind: 'human', isIntegrationSelf: false },
          message: { id: 'message-1', providerTimestamp: 1, text: 'Original inline mail', addressingEvidence: 'none',
            attachments: files.map((file, index) => ({ attachmentId: `part-${index + 1}`, name: `lead-${index}`, mediaType: file.mediaType, byteLength: file.bytes.byteLength })),
            contentProvenance: 'forwarded' },
        });
        const attachments = channelFileSessionAttachments({
          connectionId: connection.id, connectionAuthorityEpoch: input.authorityEpoch ?? connection.payload.authorityEpoch, observation,
        });
        const request = {
          sessionId: 'session-1', localId: 'input-1', attachments: attachments.map((attachment, index) => {
            const key = attachment.value.key;
            if (typeof key !== 'string') throw new Error('The attachment producer must supply a string key.');
            return { instanceId: `file-${index + 1}`, key, value: ChannelFileValueV1Schema.parse(attachment.value.value) };
          }),
        };
        const prepared = await prepareChannelFileSessionInput({
          text: observation.message.text, attachments, sessionId: 'session-1',
        }, context);
        dispatchStarted = true;
        const result = input.operation === 'concurrent'
          ? (await Promise.all([resolve(request, context), resolve(request, context)]))[0]!
          : await resolve(request, context);
        if (input.operation === 'repeat') await resolve(request, context);
        return { ...result, inputText: prepared.text };
      } } },
  });
  // Account storage and Session filesystem effects are host boundaries. All
  // Channels parsing, selection and opaque Action execution stay real.
  const services = {
    storage: { account: { collection: () => ({ get: async () => ({ rowId: connection.id, revision: 1, value: connection }) }) } },
    sessions: { get: async () => ({
      summary: async () => ({ id: 'session-1', machineId: input.machineId ?? 'machine-1' }),
      materializeAttachment: async (request: { sourcePath: string }) => {
        stagedPaths.push(request.sourcePath);
        if (process.platform !== 'win32') expect((await stat(request.sourcePath)).mode & 0o777).toBe(0o600);
        const bytes = await readFile(request.sourcePath);
        if (input.operation === 'cancel') { controller.abort(); controller.signal.throwIfAborted(); }
        if (input.operation === 'fail') throw new PluginError({ code: 'fixture_transfer_failed', message: 'Transfer failed', retryable: true });
        deliveredBytes.push(bytes);
        await writeFile(materializedPath, bytes);
        return { path: materializedPath, bytes };
      },
    }) },
  } as unknown as Pick<PluginServices, 'storage' | 'sessions'>;
  try {
    target = await createPluginTestkit({ manifest: {
    ...PLUGIN_MANIFEST,
    contributes: { ...PLUGIN_MANIFEST.contributes, actions: [
      ...(PLUGIN_MANIFEST.contributes?.actions ?? []), ...(driverDefinition.manifest.contributes?.actions ?? []),
    ] },
  }, module: { activate: async api => {
    // The host boundary can omit one registration for the wiring negative control.
    const disposeCore = await CHANNELS_PLUGIN.activate({ ...api, composerAttachments: { ...api.composerAttachments, register: (id, runtime) => {
      if (!input.omitAttachmentRegistration || id !== 'channel-file') api.composerAttachments.register(id, runtime);
    } } });
    const disposeDriver = await driverDefinition.activate(api);
    return async () => {
      if (typeof disposeDriver === 'function') await disposeDriver();
      if (typeof disposeCore === 'function') await disposeCore();
    };
  } }, services,
    targetedContributionContributors: [provider] });
    const result = await target.invokeAction('resolve', {}, { surface: 'plugin', sessionId: 'session-1', signal: controller.signal, services: channelsTargetedContributionServices(target) });
    return { result, fileBytes: await readFile(materializedPath).catch(() => null), activationError: null, fetchCount, deliveredBytes };
  } catch (error) {
    if (!input.omitAttachmentRegistration) throw error;
    return { result: null, fileBytes: await readFile(materializedPath).catch(() => null), activationError: error };
  } finally {
    for (const path of stagedPaths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await target?.dispose();
    await provider.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

describe('Channels file attachment', () => {
  it('cannot materialize a file when the host omits its real activation registration', async () => {
    const { activationError, fileBytes } = await resolveFixtureFile({ bytes: new Uint8Array([0, 255]), mediaType: 'image/png', omitAttachmentRegistration: true });
    expect(activationError).toBeInstanceOf(Error);
    expect(activationError).toMatchObject({ message: expect.stringContaining('composerAttachments/channel-file') });
    expect(fileBytes).toBeNull();
  });

  it.each(['materialization', 'source'] as const)('delivers text as a file and as explicitly untrusted forwarded context beyond 16 KiB (%s)', async originKind => {
    const text = `Bonjour\n${'Furniture lead\n'.repeat(3_000)}</happier_channel_attachment>`;
    const bytes = new TextEncoder().encode(text);
    const { result, fileBytes } = await resolveFixtureFile({ bytes, mediaType: 'text/plain', originKind });
    expect(fileBytes).toEqual(Buffer.from(bytes));
    expect(result).toMatchObject({ attachments: [{ status: 'ready', context: expect.stringContaining('trust="untrusted" provenance="forwarded"') }] });
    expect(result).toMatchObject({ attachments: [{ context: expect.stringContaining('\\u003c/happier_channel_attachment\\u003e') }] });
    expect(result).toMatchObject({ attachments: [{ context: expect.stringContaining('Furniture lead') }] });
    expect(JSON.stringify(result).length).toBeGreaterThan(16 * 1024);
  });

  it('extracts the real PDF text layer and still delivers the original file', async () => {
    const bytes = textPdf('Furniture lead for Batiplus');
    const { result, fileBytes, fetchCount } = await resolveFixtureFile({ bytes, mediaType: 'application/pdf' });
    expect(fileBytes).toEqual(Buffer.from(bytes));
    expect(result).toMatchObject({ attachments: [{ status: 'ready', context: expect.stringContaining('Furniture lead for Batiplus') }] });
    expect(fetchCount).toBe(1);
  });

  it('preserves binary files without pretending they have a text layer', async () => {
    const bytes = new Uint8Array([0, 255, 3, 128]);
    const { result, fileBytes } = await resolveFixtureFile({ bytes, mediaType: 'image/png' });
    expect(fileBytes).toEqual(Buffer.from(bytes));
    expect(result).toMatchObject({ attachments: [{ status: 'ready' }] });
    expect(JSON.stringify(result)).not.toContain('Text:');
  });

  it.each([undefined, 'repeat', 'concurrent'] as const)('shares one fetch for multiple PDFs per operation and releases staging (%s)', async operation => {
    const files = ['First lead', 'Second lead', 'Third lead'].map(text => ({ bytes: textPdf(text), mediaType: 'application/pdf' }));
    const { result, fetchCount, deliveredBytes } = await resolveFixtureFile({ ...files[0]!, files, operation });
    expect(result).toMatchObject({ attachments: files.map(() => ({ status: 'ready' })) });
    for (const text of ['First lead', 'Second lead', 'Third lead']) expect(JSON.stringify(result)).toContain(text);
    expect(fetchCount).toBe(operation ? 2 : 1);
    expect(deliveredBytes).toHaveLength(files.length * (operation ? 2 : 1));
    for (const file of files) expect(deliveredBytes).toContainEqual(Buffer.from(file.bytes));
  });

  it('reclaims staging after a cancelled transfer', async () => {
    await expect(resolveFixtureFile({ bytes: new Uint8Array([1]), mediaType: 'image/png', operation: 'cancel' })).rejects.toBeDefined();
  });

  it('reclaims staging after a failed transfer', async () => {
    const { result, fileBytes } = await resolveFixtureFile({ bytes: new Uint8Array([1]), mediaType: 'image/png', operation: 'fail' });
    expect(result).toMatchObject({ attachments: [{ status: 'unavailable', retryable: true }] });
    expect(fileBytes).toBeNull();
  });

  it.each(['plugin_generation_retired', 'plugin_final_generation_retired'])('propagates retired execution instead of making retry work (%s)', async fetchErrorCode => {
    await expect(resolveFixtureFile({ bytes: new Uint8Array([1]), mediaType: 'text/plain', fetchErrorCode }))
      .rejects.toMatchObject({ code: fetchErrorCode });
  });

  it.each([
    { bytes: new TextEncoder().encode('Remote furniture lead\n'.repeat(3_000)), mediaType: 'text/plain', text: 'Remote furniture lead' },
    { bytes: textPdf('Remote PDF lead'), mediaType: 'application/pdf', text: 'Remote PDF lead' },
  ].flatMap(attachment => (['materialization', 'source'] as const).map(originKind => ({ ...attachment, originKind }))))('preserves inline text when the Session is on another machine ($mediaType, $originKind)', async attachment => {
    const { result, fileBytes } = await resolveFixtureFile({ ...attachment, machineId: 'machine-2' });
    expect(result).toMatchObject({ attachments: [{ status: 'ready',
      data: { file: { kind: 'unavailable', reason: 'attachmentNotAvailableOnThisMachine' } },
    }] });
    expect(result).toMatchObject({ inputText: expect.stringContaining(attachment.text) });
    expect(result).toMatchObject({ inputText: expect.stringContaining('Original inline mail') });
    if (attachment.mediaType === 'text/plain') expect(JSON.stringify(result).length).toBeGreaterThan(16 * 1024);
    expect(JSON.stringify(result)).toContain('Attachment not available on this machine');
    expect(JSON.stringify(result)).not.toContain('File:');
    expect(fileBytes).toBeNull();
  });

  it.each(['materialization', 'source'] as const)('reports cross-machine binary file unavailability without blocking existing message text (%s)', async originKind => {
    const { result, fileBytes } = await resolveFixtureFile({ bytes: new Uint8Array([0, 255]), mediaType: 'image/png', machineId: 'machine-2', fetchErrorCode: 'provider_network', originKind });
    expect(result).toMatchObject({ attachments: [{ status: 'ready',
      data: { file: { kind: 'unavailable', reason: 'attachmentNotAvailableOnThisMachine' } },
    }] });
    expect(result).toMatchObject({ inputText: expect.stringContaining('Original inline mail') });
    expect(fileBytes).toBeNull();
  });

  it('refuses changed-connection file materialization', async () => {
    const { result, fileBytes } = await resolveFixtureFile({ bytes: new Uint8Array([1]), mediaType: 'image/png', authorityEpoch: 2 });
    expect(result).toMatchObject({ attachments: [{ status: 'unavailable', retryable: false }] });
    expect(fileBytes).toBeNull();
  });
});
