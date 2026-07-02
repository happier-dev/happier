import { asRecord, normalizeString } from './openCodeParsing.js';

export function normalizeOpenCodePromptConfigUpdate(update: Readonly<Record<string, unknown>>): Readonly<{
  variant: string | null;
  config: Readonly<Record<string, unknown>> | null;
  hasConfig: boolean;
}> {
  const configOptions = asRecord(update.configOptions) ?? asRecord(update.config);
  const variant = normalizeString(update.variant)
    || normalizeString(update.reasoning)
    || normalizeString(update.reasoningEffort)
    || normalizeString(configOptions?.variant);
  const configEntries = Object.entries(configOptions ?? {})
    .filter(([key]) => key !== 'variant');
  return Object.freeze({
    variant: variant || null,
    config: configEntries.length > 0 ? Object.freeze(Object.fromEntries(configEntries)) : null,
    hasConfig: configOptions !== null,
  });
}
