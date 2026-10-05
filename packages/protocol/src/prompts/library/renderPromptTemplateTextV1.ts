export type RenderedPromptTemplateTextV1 = Readonly<{ text: string; argumentRange?: readonly [number, number] }>;

/** The shared prompt dialect, with UTF-16 selection coordinates in rendered text. */
export function renderPromptTemplateTextV1(args: Readonly<{ templateMarkdown: string; argsText: string }>): RenderedPromptTemplateTextV1 {
  const markdown = String(args.templateMarkdown ?? '');
  const trimmedArgs = String(args.argsText ?? '').trim();
  const firstArgument = markdown.indexOf('$ARGUMENTS');
  const positionalPattern = /\$([1-9]\d*)/g;
  const hasPositionalPlaceholders = positionalPattern.test(markdown);
  positionalPattern.lastIndex = 0;
  let argumentRange: readonly [number, number] | undefined;
  if (!trimmedArgs && firstArgument >= 0) {
    const offset = markdown.slice(0, firstArgument).replace(positionalPattern, '').length;
    argumentRange = [offset, offset];
  }
  // Preserve the incumbent substitution order, including its positional dialect.
  let text = firstArgument >= 0 ? markdown.replaceAll('$ARGUMENTS', trimmedArgs) : markdown;
  if (hasPositionalPlaceholders) {
    const tokens = trimmedArgs ? trimmedArgs.split(/\s+/) : [];
    text = text.replace(positionalPattern, (_match, rawIndex: string) => tokens[Number.parseInt(rawIndex, 10) - 1] ?? '');
  }
  if (firstArgument < 0 && !hasPositionalPlaceholders && trimmedArgs) text += `\n\n${trimmedArgs}`;
  return { text, ...(argumentRange ? { argumentRange } : {}) };
}
