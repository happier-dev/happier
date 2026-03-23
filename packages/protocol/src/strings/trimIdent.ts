export function trimIdent(text: string): string {
  const lines = text.split('\n');

  while (lines.length > 0 && lines[0]?.trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
    lines.pop();
  }

  const minSpaces = lines.reduce((min, line) => {
    if (line.trim() === '') return min;
    const leadingSpaces = line.match(/^\s*/)?.[0]?.length ?? 0;
    return Math.min(min, leadingSpaces);
  }, Infinity);

  return lines.map((line) => line.slice(minSpaces)).join('\n');
}

