import { join } from 'node:path';
import { PluginError, isPluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createSecureTempDirectorySync, writeAtomicFile } from '@happier-dev/plugin-sdk/fs';
import type { ComposerAttachmentRuntime, ComposerAttachmentResolveRequestV1, ComposerAttachmentResolveResultV1 } from '@happier-dev/plugin-sdk';
import type { SessionHandle, SessionSendAttachment } from '@happier-dev/plugin-sdk/sessions';
import {
  ConversationAttachmentFetchInputV1Schema,
  ConversationAttachmentFetchResultV1Schema,
  rethrowConversationProviderLifecycleFailureV1,
} from '@happier-dev/channels-protocol/v1';

import { CHANNEL_STATE_COLLECTION } from './collections.js';
import { isChannelStateJsonRecord, readConversationConnectionUpdateRow } from './accountLocalBindingPolicy.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import { readCurrentProviderContributionForPersistedSelection } from './providerContributions.js';
import { ChannelFileValueV1Schema, type ChannelFileValueV1 } from './channelAttachment.js';
import { getConversationConnectionExecutionRouting } from './connectionLifecycle.js';

async function readAttachmentConnection(value: ChannelFileValueV1, context: PluginInvocationContext) {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const row = await collection.get(value.connectionId, { signal: context.signal });
  if (!row || !isChannelStateJsonRecord(row.value)) throw new PluginError({
    code: 'channels_attachment_connection_unavailable', message: 'The attachment connection is unavailable', retryable: true,
  });
  const connection = readConversationConnectionUpdateRow({ row: { ...row, value: row.value }, connectionId: value.connectionId });
  if (connection.lifecycle.authorityEpoch !== value.connectionAuthorityEpoch) throw new PluginError({
    code: 'channels_attachment_connection_changed', message: 'The attachment connection authority changed', retryable: false,
  });
  return connection;
}

/** JSON quoting keeps attachment content from spelling the host's section delimiters. */
function quoted(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function attachmentMime(mediaType: string): string {
  return mediaType.split(';', 1)[0]!.trim().toLowerCase();
}

async function inlineText(bytes: Uint8Array, mediaType: string): Promise<string | undefined> {
  const mime = attachmentMime(mediaType);
  if (mime.startsWith('text/')) {
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(mediaType)?.[1] ?? 'utf-8';
    return new TextDecoder(charset).decode(bytes);
  }
  if (mime === 'application/pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    // PDF.js can transfer its input buffer; preserve the bytes the transfer
    // owner returned. No page, byte, or text ceiling is imposed here.
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    try {
      return (await extractText(pdf, { mergePages: true })).text;
    } finally {
      await pdf.loadingTask.destroy();
    }
  }
  return undefined;
}

function attachmentContext(value: ChannelFileValueV1, input: Readonly<{ text?: string; filePath?: string; fileUnavailable?: boolean }>): string {
  return `<happier_channel_attachment trust="untrusted" provenance="${value.contentProvenance}">\nName: ${quoted(value.descriptor.name)}\nMedia type: ${quoted(value.descriptor.mediaType)}${input.filePath === undefined ? '' : `\nFile: ${quoted(input.filePath)}`}${input.fileUnavailable ? '\nFile availability: Attachment not available on this machine' : ''}${input.text === undefined ? '' : `\nText: ${quoted(input.text)}`}\n</happier_channel_attachment>`;
}

async function fetchChannelFiles(values: readonly ChannelFileValueV1[], connection: Awaited<ReturnType<typeof readAttachmentConnection>>, context: PluginInvocationContext): Promise<ReadonlyMap<string, Uint8Array>> {
  const value = values[0]!;
  const provider = await readCurrentProviderContributionForPersistedSelection({
    context: { targetedContributions: context.services.targetedContributions, signal: context.signal },
    providerPluginId: connection.providerPluginId,
    providerContributionSelection: connection.providerContributionSelection,
  });
  const operation = provider.operations.attachmentFetch;
  if (!operation) throw new PluginError({ code: 'channels_attachment_fetch_unsupported', message: 'The channel provider does not fetch attachments' });
  const fetchInput = ConversationAttachmentFetchInputV1Schema.parse({
    v: 1, connectionId: value.connectionId,
    providerConnectionKey: connection.payload.providerConnectionKey,
    providerConfigVersion: connection.payload.providerConfigVersion,
    providerConfig: connection.payload.providerConfig,
    credentialRef: connection.payload.credentialRef,
    messageId: value.messageId, attachmentIds: [...new Set(values.map(file => file.descriptor.attachmentId))],
  });
  const fetched = ConversationAttachmentFetchResultV1Schema.parse((await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    operation, fetchInput, { signal: context.signal, expectedExecutionRouting: getConversationConnectionExecutionRouting(connection.transportOrigin, connection.providerPluginId) },
  )).result);
  if (fetched.kind !== 'fetched') throw new PluginError({
    code: 'channels_attachment_fetch_unavailable', message: 'The channel attachment is unavailable',
    retryable: fetched.reason === 'network' || fetched.reason === 'rateLimited',
  });
  await readAttachmentConnection(value, context);
  const files = new Map(fetched.attachments.map(file => [file.attachmentId, Buffer.from(file.base64, 'base64')]));
  if (values.some(file => !files.has(file.descriptor.attachmentId))) throw new PluginError({
    code: 'channels_attachment_fetch_unavailable', message: 'The provider did not return the requested attachment batch',
  });
  return files;
}

/** Sharing lasts only for this consuming operation, never across queued/replayed inputs. */
function operationFiles(values: readonly ChannelFileValueV1[], context: PluginInvocationContext) {
  const key = (value: ChannelFileValueV1) => JSON.stringify([value.connectionId, value.connectionAuthorityEpoch, value.messageId]);
  const pending = new Map<string, ReturnType<typeof fetchChannelFiles>>();
  return async (value: ChannelFileValueV1, connection: Awaited<ReturnType<typeof readAttachmentConnection>>) => {
    const identity = key(value);
    let fetched = pending.get(identity);
    if (!fetched) {
      fetched = fetchChannelFiles(values.filter(file => key(file) === identity), connection, context);
      pending.set(identity, fetched);
    }
    return (await fetched).get(value.descriptor.attachmentId)!;
  };
}

/** Other native input writers consume the same provider file owner as Sessions. */
export async function readChannelFileInputs(
  attachments: readonly SessionSendAttachment[], context: PluginInvocationContext,
): Promise<readonly Readonly<{ key: string; descriptor: ChannelFileValueV1['descriptor']; bytes: Uint8Array }>[]> {
  const values = attachments.map(attachment => ChannelFileValueV1Schema.parse(attachment.value.value));
  const fetch = operationFiles(values, context);
  const files = [];
  for (const [index, value] of values.entries()) {
    context.signal.throwIfAborted();
    const connection = await readAttachmentConnection(value, context);
    files.push({ key: attachments[index]!.value.key, descriptor: value.descriptor, bytes: await fetch(value, connection) });
  }
  return files;
}

/** Remote Sessions keep inline text at admission; local dispatch consumes bytes and text together. */
export async function prepareChannelFileSessionInput(input: Readonly<{
  text: string;
  attachments: readonly SessionSendAttachment[];
  sessionId: string;
}>, context: PluginInvocationContext): Promise<Readonly<{ text: string }>> {
  const sections = [input.text];
  const values = input.attachments.map(attachment => ChannelFileValueV1Schema.parse(attachment.value.value))
    .filter(value => attachmentMime(value.descriptor.mediaType).startsWith('text/') || attachmentMime(value.descriptor.mediaType) === 'application/pdf');
  const fetch = operationFiles(values, context);
  const session = await context.services.sessions.get(input.sessionId, { signal: context.signal });
  const summary = await session?.summary({ signal: context.signal });
  for (const value of values) {
    context.signal.throwIfAborted();
    const mime = attachmentMime(value.descriptor.mediaType);
    if (!mime.startsWith('text/') && mime !== 'application/pdf') continue;
    const connection = await readAttachmentConnection(value, context);
    if (summary?.machineId === connection.transportOrigin.machineId) continue;
    const text = await inlineText(await fetch(value, connection), value.descriptor.mediaType);
    await readAttachmentConnection(value, context);
    context.signal.throwIfAborted();
    if (text !== undefined) sections.push(attachmentContext(value, { text }));
  }
  return { text: sections.join('\n\n') };
}

async function resolveChannelFiles(
  request: ComposerAttachmentResolveRequestV1<ChannelFileValueV1>,
  context: PluginInvocationContext,
): Promise<ComposerAttachmentResolveResultV1> {
  if (context.session?.id !== request.sessionId) throw new PluginError({
    code: 'channels_attachment_session_required', message: 'Attachment dispatch requires its host-stamped Session',
  });
  const results: ComposerAttachmentResolveResultV1['attachments'][number][] = [];
  const fetch = operationFiles(request.attachments.map(attachment => ChannelFileValueV1Schema.parse(attachment.value)), context);
  for (const attachment of request.attachments) {
    try {
      context.signal.throwIfAborted();
      const value = ChannelFileValueV1Schema.parse(attachment.value);
      const connection = await readAttachmentConnection(value, context);
      const session = await context.services.sessions.get(request.sessionId, { signal: context.signal });
      if (!session) throw new PluginError({ code: 'channels_attachment_session_unavailable', message: 'The Session is unavailable', retryable: true });
      const summary = await session.summary({ signal: context.signal });
      const sameMachine = summary.machineId === connection.transportOrigin.machineId;
      let file: Awaited<ReturnType<SessionHandle['materializeAttachment']>> | undefined;
      let text: string | undefined;
      if (sameMachine) {
        const bytes = await fetch(value, connection);
        text = await inlineText(bytes, value.descriptor.mediaType);
        await readAttachmentConnection(value, context);
        context.signal.throwIfAborted();
        const directory = createSecureTempDirectorySync({ prefix: 'channel-attachments' });
        try {
          const path = join(directory.path, 'attachment');
          await writeAtomicFile({ path, contents: bytes, mode: 0o600 });
          context.signal.throwIfAborted();
          file = await session.materializeAttachment({
            sourcePath: path, name: value.descriptor.name, messageLocalId: request.localId,
          }, { signal: context.signal });
        } finally {
          directory.cleanup();
        }
      }
      context.signal.throwIfAborted();
      results.push({
        instanceId: attachment.instanceId, status: 'ready',
        ...(!file ? { data: { file: { kind: 'unavailable', reason: 'attachmentNotAvailableOnThisMachine' } } } : {}),
        context: attachmentContext(value, { text, filePath: file?.path, fileUnavailable: !file }),
      });
    } catch (error) {
      rethrowConversationProviderLifecycleFailureV1(error, context.signal);
      if (context.signal.aborted || (isPluginError(error) && error.code === 'plugin_generation_retired')) throw error;
      results.push({ instanceId: attachment.instanceId, status: 'unavailable', retryable: isPluginError(error) && error.retryable === true,
        message: isPluginError(error) ? error.code : 'channels_attachment_resolution_failed' });
    }
  }
  return { attachments: results };
}

export const CHANNEL_FILE_ATTACHMENT_RUNTIME = {
  resolveForDispatch: resolveChannelFiles,
} satisfies ComposerAttachmentRuntime<ChannelFileValueV1>;
