/** One placed inline reference of a document picture: its exact range in the text and what its chip reads. */
export type AgentInputDocumentPreviewReference = Readonly<{
  start: number;
  end: number;
  ref: string;
  label: string;
  /** A reference whose identity no longer parses reads as unavailable, as in the live field. */
  unavailable?: boolean;
}>;

export type AgentInputDocumentPreviewSelection = Readonly<{
  start: number;
  end: number;
}>;

export type AgentInputDocumentPreviewTextProps = Readonly<{
  value: string;
  references: readonly AgentInputDocumentPreviewReference[];
  placeholder: string;
  /**
   * The field's own vertical inset, so the picture and the live editor share every pixel. A reading
   * outside any field (a row that already gives the text its room) passes `false`.
   */
  fieldInset?: boolean;
  /**
   * Receives where in the text a pointer went down, so the live composer that replaces the picture
   * opens with its caret there. `null` when the point maps to no text position.
   */
  onPointerSelection?: (
    selection: AgentInputDocumentPreviewSelection | null,
  ) => void;
}>;

/** The text split at its reference ranges, in order; ranges that overlap or fall outside the text are left as text. */
export function splitAgentInputDocumentPreviewText(
  value: string,
  references: readonly AgentInputDocumentPreviewReference[],
): ReadonlyArray<
  | Readonly<{ kind: 'text'; start: number; text: string }>
  | Readonly<{
      kind: 'reference';
      reference: AgentInputDocumentPreviewReference;
    }>
> {
  const segments: Array<
    | Readonly<{ kind: 'text'; start: number; text: string }>
    | Readonly<{
        kind: 'reference';
        reference: AgentInputDocumentPreviewReference;
      }>
  > = [];
  let cursor = 0;
  for (const reference of [...references].sort(
    (left, right) => left.start - right.start,
  )) {
    if (
      reference.start < cursor ||
      reference.end > value.length ||
      reference.end <= reference.start
    )
      continue;
    if (reference.start > cursor)
      segments.push({
        kind: 'text',
        start: cursor,
        text: value.slice(cursor, reference.start),
      });
    segments.push({ kind: 'reference', reference });
    cursor = reference.end;
  }
  if (cursor < value.length)
    segments.push({ kind: 'text', start: cursor, text: value.slice(cursor) });
  return segments;
}
