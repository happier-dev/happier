import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentSessionInputFilesService, AgentSessionSendRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { HappierStructuredInputV1Schema, readStructuredInputMentionSourcesV1 } from '@happier-dev/plugin-sdk/sessions';
import type { MuseMsp } from './msp.js';
import { readMuseRecord } from './events.js';

export type MuseNativeSkill = Readonly<{
  selector: string;
  source: string;
  displayName?: string;
  description?: string;
  argumentHint?: string;
}>;

/** Native skill selectors and sources are facts from the selected Session. */
export function readMuseNativeSkills(value: JsonValue): readonly MuseNativeSkill[] {
  const result = readMuseRecord(value);
  if (!Array.isArray(result.skills)) throw new PluginError({ code: 'PLUGIN_EXEC_PROTOCOL_ERROR' });
  return result.skills.map(value => {
    const skill = readMuseRecord(value);
    if (typeof skill.selector !== 'string' || typeof skill.source !== 'string') {
      throw new PluginError({ code: 'PLUGIN_EXEC_PROTOCOL_ERROR' });
    }
    return { selector: skill.selector, source: skill.source,
      ...(typeof skill.displayName === 'string' ? { displayName: skill.displayName } : {}),
      ...(typeof skill.description === 'string' ? { description: skill.description } : {}),
      ...(typeof skill.argumentHint === 'string' ? { argumentHint: skill.argumentHint } : {}),
    };
  });
}

/** Translate selected inputs only; the host remains the image/file authority. */
export async function resolveMuseTurnInput(input: AgentSessionSendRequest['input'], context: Readonly<{
  msp: Pick<MuseMsp, 'client'>;
  nativeSessionId: string;
  inputFiles?: AgentSessionInputFilesService;
  signal?: AbortSignal;
}>): Promise<Readonly<Record<string, JsonValue>>[] | null> {
  const parts: Readonly<Record<string, JsonValue>>[] = [{ type: 'text', text: input.text }];
  if (!input.structuredInput) return parts;
  const parsed = HappierStructuredInputV1Schema.safeParse(input.structuredInput);
  if (!parsed.success) return null;
  const { v: _version, imageInputs, skillMentions: _skills, vendorPluginMentions: _plugins,
    mentions: _mentions, ...unsupported } = parsed.data;
  if (Object.keys(unsupported).length) return null;
  const selections = readStructuredInputMentionSourcesV1(parsed.data);
  if (selections.mentions.length || selections.vendorPluginMentions.length) return null;
  // Native skill arguments replace the text part. Multiple selected skills have
  // no characterized composition, so they remain explicitly unsupported.
  if (selections.skillMentions.length > 1) return null;
  const selectedSkill = selections.skillMentions[0];
  if (selectedSkill) {
    if ((selectedSkill.agentId && selectedSkill.agentId !== 'muse')
      || (selectedSkill.backendId && selectedSkill.backendId !== 'muse')) return null;
    const skills = readMuseNativeSkills(await context.msp.client.request('skill/list',
      { sessionId: context.nativeSessionId }, { signal: context.signal }));
    const matches = skills.filter(skill => skill.selector === selectedSkill.name);
    if (matches.length !== 1) return null;
    const skill = matches[0]!;
    parts.splice(0, 1, { type: 'skill', selector: skill.selector, source: skill.source, arguments: input.text });
  }
  for (const image of imageInputs ?? []) {
    const verified = await context.inputFiles?.readVerifiedImage(image, { signal: context.signal });
    if (!verified) return null;
    const prefix = `data:${verified.mimeType};base64,`;
    if (!verified.url.startsWith(prefix)) return null;
    parts.push({ type: 'image', mediaType: verified.mimeType, base64Data: verified.url.slice(prefix.length) });
  }
  return parts;
}
