import { listVoiceActionBlockSpecs, listVoiceToolActionSpecs } from '@happier-dev/protocol';

type VoiceToolDocSpec = Readonly<{
  id: string;
  title?: string;
  description?: string;
  bindings?: Readonly<{
    voiceClientToolName?: string;
  }>;
  examples?: Readonly<{
    voice?: Readonly<{
      argsExample?: string;
    }>;
  }>;
}>;

function normalizeDisabledActionIds(disabledActionIds?: readonly string[]): Set<string> {
  return new Set((disabledActionIds ?? []).map((value) => String(value ?? '').trim()).filter(Boolean));
}

function buildVoiceToolDocumentationLines(
  specs: readonly VoiceToolDocSpec[],
  params?: Readonly<{ disabledActionIds?: readonly string[] }>,
): string[] {
  const disabled = normalizeDisabledActionIds(params?.disabledActionIds);

  return specs.flatMap((spec) => {
    if (disabled.has(spec.id)) return [];
    const toolNameRaw = spec.bindings?.voiceClientToolName;
    const toolName = typeof toolNameRaw === 'string' ? toolNameRaw.trim() : '';
    if (!toolName) return [];
    const desc = (spec.description ?? spec.title ?? toolName).trim();
    const argsExample = spec.examples?.voice?.argsExample ?? '{}';
    return [`- ${toolName}: ${desc} Call with ${argsExample}.`];
  });
}

export function buildVoiceToolDocumentation(
  params?: Readonly<{ disabledActionIds?: readonly string[] }>,
): string[] {
  return buildVoiceToolDocumentationLines(listVoiceToolActionSpecs(), params);
}

export function buildVoiceActionBlockDocumentation(
  params?: Readonly<{ disabledActionIds?: readonly string[] }>,
): string[] {
  return buildVoiceToolDocumentationLines(listVoiceActionBlockSpecs(), params);
}
