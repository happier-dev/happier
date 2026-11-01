export type SpeechMarkupToken = Readonly<{
  start: number;
  end: number;
}> & (
  | Readonly<{ kind: 'code'; delimiterAfter: number }>
  | Readonly<{ kind: 'link'; label: string }>
  | Readonly<{ kind: 'pending_link' }>
);

/** The speech grammar recognizes inline code and simple inline links/images, not full Markdown. */
export function nextSpeechMarkupToken(text: string, cursor: number, inlineCodeDelimiter: number): SpeechMarkupToken | null {
  const markers = inlineCodeDelimiter ? /`+/gu : /`+|!?\[/gu;
  markers.lastIndex = cursor;
  for (let match = markers.exec(text); match; match = markers.exec(text)) {
    const start = match.index;
    if (match[0][0] === '`') {
      const length = match[0].length;
      return { kind: 'code', start, end: start + length, delimiterAfter: inlineCodeDelimiter === length ? 0 : inlineCodeDelimiter || length };
    }
    const labelStart = start + match[0].length;
    const labelEnd = text.indexOf(']', labelStart);
    if (labelEnd === -1) return { kind: 'pending_link', start, end: labelStart };
    if (labelEnd === labelStart && match[0] !== '![') continue;
    if (labelEnd + 1 === text.length) return { kind: 'pending_link', start, end: labelStart };
    if (text[labelEnd + 1] !== '(') continue;
    const end = text.indexOf(')', labelEnd + 2);
    if (end === -1) return { kind: 'pending_link', start, end: labelStart };
    return { kind: 'link', start, end: end + 1, label: text.slice(labelStart, labelEnd) };
  }
  return null;
}
