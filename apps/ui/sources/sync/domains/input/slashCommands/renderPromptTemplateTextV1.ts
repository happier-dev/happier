export function renderPromptTemplateTextV1(args: Readonly<{ templateMarkdown: string; argsText: string }>): string {
  const templateMarkdown = String(args.templateMarkdown ?? '');
  const argsText = String(args.argsText ?? '');
  const trimmedArgs = argsText.trim();

  const hasArgumentsPlaceholder = templateMarkdown.includes('$ARGUMENTS');
  const positionalPattern = /\$([1-9]\d*)/g;
  const hasPositionalPlaceholders = positionalPattern.test(templateMarkdown);
  positionalPattern.lastIndex = 0;

  let out = templateMarkdown;

  if (hasArgumentsPlaceholder) {
    out = out.replaceAll('$ARGUMENTS', trimmedArgs);
  }

  if (hasPositionalPlaceholders) {
    const tokens = trimmedArgs.length > 0 ? trimmedArgs.split(/\s+/) : [];
    out = out.replace(positionalPattern, (_match, indexRaw: string) => {
      const index = Number.parseInt(indexRaw, 10);
      if (!Number.isFinite(index) || index < 1) return '';
      return tokens[index - 1] ?? '';
    });
  }

  if (!hasArgumentsPlaceholder && !hasPositionalPlaceholders && trimmedArgs.length > 0) {
    return `${out}\n\n${trimmedArgs}`;
  }

  return out;
}

