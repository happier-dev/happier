import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { BotTemplateDraftRefV1Schema, BotTemplateInstanceV1Schema, readBotTemplateInstanceV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { z } from 'zod/mini';
import {
  readSessionMemoryEnabledV1,
  writeSessionContextIntentV1ToMetadata,
  migrateRetainedSessionWorkContextV1,
  SessionPromptStackV1StoredSchema,
  SessionDisabledInheritedEntryIdsV1Schema,
} from '@happier-dev/protocol/sessions/context/sessionContextV1';
import type { SessionStateBinding } from './_types.js';
import { readSessionVoicePreferenceV1, writeSessionVoicePreferenceV1ToMetadata } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';

export const sessionVoicePreferenceBinding: SessionStateBinding<'intent.voicePreference'> = {
  readMutationBasis: (metadata) => sessionVoicePreferenceBinding.read(metadata).value,
  read: (metadata) => {
    const work = metadata.work;
    return { value: readSessionVoicePreferenceV1(work && typeof work === 'object' && 'voicePreference' in work
      ? work.voicePreference : undefined), updatedAt: null };
  },
  write: (metadata, update) => writeSessionVoicePreferenceV1ToMetadata(metadata, update.value),
};

export const sessionTemplateDraftRefBinding: SessionStateBinding<'intent.templateDraftRef'> = {
  readMutationBasis: metadata => sessionTemplateDraftRefBinding.read(metadata).value,
  read: metadata => {
    const work = metadata.work;
    const parsed = BotTemplateDraftRefV1Schema.safeParse(work && typeof work === 'object' && 'templateDraftRef' in work ? work.templateDraftRef : undefined);
    return { value: parsed.success ? parsed.data : null, updatedAt: null };
  },
  write: (metadata, update) => {
    const ref = z.nullable(BotTemplateDraftRefV1Schema).parse(update.value);
    const work: Readonly<Record<string, unknown>> = { ...(metadata.work && typeof metadata.work === 'object' ? metadata.work : {}) };
    if (sameStrictJsonValue('templateDraftRef' in work ? work.templateDraftRef : null, ref)) return metadata;
    const { templateDraftRef: _previous, ...rest } = work;
    return { ...metadata, work: ref === null ? rest : { ...rest, templateDraftRef: ref } };
  },
};

export const sessionTemplateInstanceBinding: SessionStateBinding<'intent.templateInstance'> = {
  readMutationBasis: metadata => sessionTemplateInstanceBinding.read(metadata).value,
  read: metadata => {
    const work = metadata.work;
    return { value: readBotTemplateInstanceV1(work && typeof work === 'object' && 'templateInstance' in work
      ? work.templateInstance : undefined), updatedAt: null };
  },
  write: (metadata, update) => {
    const instance = z.nullable(BotTemplateInstanceV1Schema).parse(update.value);
    const work: Readonly<Record<string, unknown>> = { ...(metadata.work && typeof metadata.work === 'object' ? metadata.work : {}) };
    if (sameStrictJsonValue(work.templateInstance ?? null, instance)) return metadata;
    const { templateInstance: _previous, ...rest } = work;
    return { ...metadata, work: instance === null ? rest : { ...rest, templateInstance: instance } };
  },
};

export const sessionMemoryEnabledBinding: SessionStateBinding<'intent.memoryEnabled'> = {
  readMutationBasis: readSessionMemoryEnabledV1,
  read: (metadata) => ({ value: readSessionMemoryEnabledV1(metadata), updatedAt: null }),
  write: (metadata, update) => {
    const work = metadata.work && typeof metadata.work === 'object' ? metadata.work : {};
    return { ...metadata, work: { ...work, memoryEnabled: z.boolean().parse(update.value) } };
  },
};
export const sessionContextBinding: SessionStateBinding<'intent.context'> = {
  readMutationBasis: (metadata) => {
    const work = migrateRetainedSessionWorkContextV1(metadata.work);
    return { promptStack: SessionPromptStackV1StoredSchema.parse(work.promptStack ?? []),
      disabledInheritedEntryIds: SessionDisabledInheritedEntryIdsV1Schema.parse(work.disabledInheritedEntryIds ?? []).sort() };
  },
  // Context is an entry intent, never a second whole-stack representation.
  read: () => ({ value: null, updatedAt: null }),
  write: (metadata, update) => writeSessionContextIntentV1ToMetadata(metadata, update.value),
};
