import { z } from 'zod';

import { defineProtocolJsonValue } from '../plugins/actions/jsonSchemaValidation.js';
import type { PluginJsonValueV2 } from '../plugins/contributions/publicTypes.js';

export const MAX_AUTOMATION_EVENT_PAYLOAD_UTF8_BYTES = 64 * 1024;
export const MAX_AUTOMATION_SOURCE_CONFIG_UTF8_BYTES = 64 * 1024;
export const MAX_AUTOMATION_SOURCE_DISPLAY_LABEL_CODE_POINTS = 256;
export const MAX_AUTOMATION_SOURCE_OR_OCCURRENCE_ID_UTF8_BYTES = 512;
export const MAX_AUTOMATION_REPLY_CONTEXT_UTF8_BYTES = 64 * 1024;

const UTF8_ENCODER = new TextEncoder();

export const AutomationEventSourceOrOccurrenceIdV1Schema = z.string().min(1).superRefine((value, context) => {
  if (value !== value.normalize('NFC')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Value must be NFC-normalized' });
  }
  if (UTF8_ENCODER.encode(value).byteLength > MAX_AUTOMATION_SOURCE_OR_OCCURRENCE_ID_UTF8_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Value exceeds the 512-byte limit' });
  }
});

/**
 * Canonical bounded source-instance scalar. Run recipes reuse this exact
 * source identity contract rather than carrying a second local string bound.
 */
export const AutomationEventSourceInstanceIdV1Schema = AutomationEventSourceOrOccurrenceIdV1Schema;

export const AutomationEventSourceDisplayLabelV1Schema = z.string().min(1).superRefine((value, context) => {
  if (value !== value.normalize('NFC')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Display labels must be NFC-normalized' });
  }
  if (Array.from(value).length > MAX_AUTOMATION_SOURCE_DISPLAY_LABEL_CODE_POINTS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Display labels exceed the code-point limit' });
  }
});

export function boundedAutomationEventJsonValueV1(maxSerializedUtf8Bytes: number) {
  return defineProtocolJsonValue<PluginJsonValueV2>({ maxSerializedUtf8Bytes });
}

/**
 * Canonical bounded Event payload contract. Frozen execution recipes preserve
 * the same payload limits as Event admission.
 */
export const AutomationEventPayloadV1Schema = boundedAutomationEventJsonValueV1(
  MAX_AUTOMATION_EVENT_PAYLOAD_UTF8_BYTES,
);
export type AutomationEventPayloadV1 = ReturnType<typeof AutomationEventPayloadV1Schema.parse>;

export const AutomationEventSourceConfigV1Schema = boundedAutomationEventJsonValueV1(
  MAX_AUTOMATION_SOURCE_CONFIG_UTF8_BYTES,
);

export const AutomationEventReplyContextV1Schema = boundedAutomationEventJsonValueV1(
  MAX_AUTOMATION_REPLY_CONTEXT_UTF8_BYTES,
);
export type AutomationEventReplyContextV1 = ReturnType<typeof AutomationEventReplyContextV1Schema.parse>;
