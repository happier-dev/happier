import { PluginError } from '@happier-dev/plugin-sdk';
import { SessionSystemRecordSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecord';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { getSessionSystemRecordPayloadSchema, getSessionSystemRecordStoredPayloadSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordCatalog';
import type { SessionSystemRecord, SessionSystemRecordAddress, SessionSystemRecordContent, SessionSystemRecordStored, SessionSystemRecordUpsertRequest } from '@happier-dev/protocol';

import {
  openSessionStoredContent,
  sealSessionStoredContent,
  SessionStoredContentError,
  type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionStoredContentCodec';

// These codes are the incumbent System Record wire/SDK contract for both address owners.
function pluginError(code: string, message: string): PluginError {
  return new PluginError({ code, message });
}

export function sealSessionSystemRecordContent(
  context: SessionStoredContentCryptoContext,
  content: SessionSystemRecordUpsertRequest['content'],
): SessionSystemRecordContent {
  return sealSessionStoredContent({ ...context, payload: content });
}

export function validateSessionSystemRecordOpenedContent(
  address: SessionSystemRecordAddress,
  content: unknown,
  invalidCode: 'plugin_session_record_invalid_request' | 'plugin_session_record_invalid_response',
): SessionSystemRecordUpsertRequest['content'] {
  const parsed = StrictJsonValueSchema.safeParse(content);
  if (!parsed.success) {
    throw pluginError(
      invalidCode,
      'Session system record content did not contain bounded JSON',
    );
  }
  if (address.owner === 'host') {
    const payloadSchema = invalidCode === 'plugin_session_record_invalid_response'
      ? getSessionSystemRecordStoredPayloadSchema(address.namespace, address.kind)
      : getSessionSystemRecordPayloadSchema(address.namespace, address.kind);
    const registered = payloadSchema?.safeParse(parsed.data);
    if (!registered?.success) {
      throw pluginError(
        invalidCode,
        'Session system record content did not match the registered host record schema',
      );
    }
    const normalized = StrictJsonValueSchema.safeParse(registered.data);
    if (!normalized.success) {
      throw pluginError(
        invalidCode,
        'Session system record content did not contain bounded JSON',
      );
    }
    return normalized.data;
  }
  return parsed.data;
}

function openRecordContent(
  context: SessionStoredContentCryptoContext,
  content: SessionSystemRecordContent,
): unknown {
  try {
    return openSessionStoredContent({ ...context, content });
  } catch (error) {
    if (error instanceof SessionStoredContentError && error.code === 'session_content_mode_mismatch') {
      throw pluginError(
        'plugin_session_record_encryption_mismatch',
        'Session system record content did not match the Session encryption mode',
      );
    }
    throw pluginError(
      'plugin_session_record_encryption_unavailable',
      'Session system record content could not be opened with the Session encryption material',
    );
  }
}

export function openSessionSystemRecord(
  context: SessionStoredContentCryptoContext,
  stored: SessionSystemRecordStored,
): SessionSystemRecord {
  const parsed = SessionSystemRecordSchema.safeParse({
    ...stored,
    content: validateSessionSystemRecordOpenedContent(
      stored.address,
      openRecordContent(context, stored.content),
      'plugin_session_record_invalid_response',
    ),
  });
  if (!parsed.success) {
    throw pluginError(
      'plugin_session_record_invalid_response',
      'Session system record response did not match the public record contract',
    );
  }
  return Object.freeze(parsed.data);
}
