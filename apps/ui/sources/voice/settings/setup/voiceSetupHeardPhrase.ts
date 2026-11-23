/**
 * How much of setup's suggested phrase the recognizer has really heard (lab T1 "Say hello"): the
 * suggested words light up in order as the person's own recognized words reach them. Nothing is lit
 * without recognized text, and when the person says something else their own words are shown instead
 * of a phrase they did not say.
 */
export type VoiceSetupHeardPhrase =
  | Readonly<{ kind: 'phrase'; heard: string; rest: string }>
  | Readonly<{ kind: 'own'; text: string }>;

function normalize(text: string): string {
  return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function resolveVoiceSetupHeardPhrase(
  phrase: string,
  recognized: string | null,
): VoiceSetupHeardPhrase {
  const said = recognized?.trim() ?? '';
  if (!said) return { kind: 'phrase', heard: '', rest: phrase };
  const tokens = phrase.split(/(\s+)/);
  const words = tokens.filter((token) => token.trim().length > 0);
  // Scripts written without spaces (Japanese, Chinese) are one token: light the recognized prefix.
  if (words.length === 1) {
    const target = normalize(phrase);
    const heard = normalize(said);
    if (heard.includes(target))
      return { kind: 'phrase', heard: phrase, rest: '' };
    let lit = 0;
    while (
      lit < heard.length &&
      lit < target.length &&
      heard[lit] === target[lit]
    )
      lit += 1;
    if (lit === 0) return { kind: 'own', text: said };
    return {
      kind: 'phrase',
      heard: phrase.slice(0, lit),
      rest: phrase.slice(lit),
    };
  }
  const saidWords = said.split(/\s+/).map(normalize).filter(Boolean);
  let cursor = 0;
  let litWords = 0;
  for (const word of words) {
    const target = normalize(word);
    if (!target) {
      // Punctuation that stands alone (French "?") follows the word before it.
      litWords += 1;
      continue;
    }
    const found = saidWords.indexOf(target, cursor);
    if (found < 0) break;
    cursor = found + 1;
    litWords += 1;
  }
  if (words.slice(0, litWords).every((word) => !normalize(word)))
    return { kind: 'own', text: said };
  // Rebuild from the original tokens so spacing and punctuation stay exactly as written.
  let seen = 0;
  let split = tokens.length;
  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index]!.trim()) continue;
    if (seen === litWords) {
      split = index;
      break;
    }
    seen += 1;
  }
  const lit = tokens.slice(0, split).join('');
  const heard = lit.trimEnd();
  return { kind: 'phrase', heard, rest: lit.slice(heard.length) + tokens.slice(split).join('') };
}
