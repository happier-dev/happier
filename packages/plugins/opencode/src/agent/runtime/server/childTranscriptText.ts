type ChildTextPart = {
  messageId: string;
  partId: string;
  partType: string;
  text: string;
  ended?: boolean;
};

type ChildTextRow = {
  parts: Map<string, ChildTextPart>;
  reasoning: boolean;
};

type ChildTextBuffer = {
  rows: Set<ChildTextRow>;
  rowByPart: Map<string, ChildTextRow>;
  activeReasoning?: ChildTextRow;
};

type FlushBoundary =
  | { kind: 'tool' }
  | { kind: 'text'; messageId: string }
  | { kind: 'child-end' };

export function createOpenCodeChildTranscriptText(params: {
  isSuppressed: (part: ChildTextPart) => boolean;
  publish: (childSessionId: string, part: ChildTextPart) => void;
}) {
  const children = new Map<string, ChildTextBuffer>();

  return {
    textForPart(childSessionId: string, partId: string) {
      return children.get(childSessionId)?.rowByPart.get(partId)?.parts.get(partId)?.text ?? '';
    },
    record(childSessionId: string, part: ChildTextPart) {
      let child = children.get(childSessionId);
      if (!child) {
        child = { rows: new Set(), rowByPart: new Map() };
        children.set(childSessionId, child);
      }
      const existing = child.rowByPart.get(part.partId);
      if (existing) {
        const previous = existing.parts.get(part.partId)!;
        existing.parts.set(part.partId, { ...part, ended: part.ended || previous.ended });
        return;
      }
      const reasoning = part.partType === 'reasoning';
      const row = (reasoning && child.activeReasoning) || { parts: new Map(), reasoning };
      child.activeReasoning = reasoning ? row : undefined;
      row.parts.set(part.partId, part);
      child.rows.add(row);
      child.rowByPart.set(part.partId, row);
    },
    flush(childSessionId: string, boundary: FlushBoundary) {
      const child = children.get(childSessionId);
      if (!child) return;
      if (boundary.kind !== 'text') child.activeReasoning = undefined;
      for (const row of child.rows) {
        const parts = Array.from(row.parts.values());
        // V1 parts have no part-end frames. Keep their text for the existing
        // child settlement path, including any role metadata arriving after a tool.
        const ready = row.reasoning
          ? row !== child.activeReasoning && parts.every(part => part.ended)
          : boundary.kind === 'text' && parts[0]?.messageId === boundary.messageId;
        if (boundary.kind !== 'child-end' && !ready) continue;
        child.rows.delete(row);
        for (const part of parts) child.rowByPart.delete(part.partId);
        const visible = parts.filter(part => part.text && !params.isSuppressed(part));
        const first = visible[0];
        if (first) params.publish(childSessionId, {
          ...first,
          text: visible.map(part => part.text).join('\n\n'),
        });
      }
      if (child.rows.size === 0) children.delete(childSessionId);
    },
    clear() {
      children.clear();
    },
  };
}
