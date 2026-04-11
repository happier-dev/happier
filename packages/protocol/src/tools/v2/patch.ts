type UnknownRecord = Record<string, unknown>;

export type CanonicalPatchFileDiff = Readonly<{
  filePath: string;
  oldText?: string;
  newText?: string;
  unifiedDiff?: string;
}>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function asNonEmptyRecord(value: unknown): UnknownRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  return Object.keys(record).length > 0 ? record : null;
}

function firstNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stripDiffPrefix(path: string): string {
  return path.replace(/^(a\/|b\/)/, '');
}

function parsePatchHunk(diff: string): { oldText: string; newText: string } | null {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let sawHunkLine = false;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      sawHunkLine = true;
      continue;
    }
    if (!sawHunkLine && (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ '))) {
      continue;
    }
    if (!sawHunkLine && !line.startsWith('+') && !line.startsWith('-') && !line.startsWith(' ') && line.length > 0) {
      continue;
    }
    if (line === '\\ No newline at end of file') continue;
    if (line.startsWith('+')) {
      newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith(' ')) {
      const value = line.slice(1);
      oldLines.push(value);
      newLines.push(value);
      continue;
    }
    if (line === '') {
      oldLines.push('');
      newLines.push('');
    }
  }

  if (oldLines.length === 0 && newLines.length === 0) return null;
  return {
    oldText: oldLines.join('\n'),
    newText: newLines.join('\n'),
  };
}

function parseApplyPatchTextChanges(patchText: string): Record<string, unknown> | null {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n');
  const changes: Record<string, unknown> = {};
  let currentFilePath: string | null = null;

  for (const line of lines) {
    const match = line.match(/^\*\*\*\s+(Update File|Add File|Delete File):\s+(.+)\s*$/);
    if (match) {
      const filePath = match[2]?.trim();
      if (!filePath) continue;

      const label = String(match[1]).toLowerCase();
      const type = label.startsWith('add') ? 'add' : label.startsWith('delete') ? 'delete' : 'update';
      changes[filePath] = { type };
      currentFilePath = filePath;
      continue;
    }

    const moveMatch = line.match(/^\*\*\*\s+Move to:\s+(.+)\s*$/);
    if (!moveMatch || !currentFilePath) continue;
    const movedPath = moveMatch[1]?.trim();
    if (!movedPath) continue;

    const change = changes[currentFilePath];
    if (!change) continue;
    delete changes[currentFilePath];
    changes[movedPath] = change;
    currentFilePath = movedPath;
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

function parseUnifiedDiffFileBlock(unifiedDiff: string): {
  filePath: string | null;
  change: UnknownRecord | null;
} {
  const lines = unifiedDiff.split('\n');
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let isDelete = false;
  let isAdd = false;
  let inHunk = false;
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('deleted file mode')) {
      isDelete = true;
      continue;
    }
    if (line.startsWith('new file mode')) {
      isAdd = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      const raw = line.replace(/^--- /, '').split('\t')[0] ?? '';
      oldPath = raw === '/dev/null' ? '/dev/null' : stripDiffPrefix(raw);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const raw = line.replace(/^\+\+\+ /, '').split('\t')[0] ?? '';
      newPath = raw === '/dev/null' ? '/dev/null' : stripDiffPrefix(raw);
      continue;
    }

    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith('+')) {
      newLines.push(line.substring(1));
    } else if (line.startsWith('-')) {
      oldLines.push(line.substring(1));
    } else if (line.startsWith(' ')) {
      oldLines.push(line.substring(1));
      newLines.push(line.substring(1));
    } else if (line === '\\ No newline at end of file') {
      continue;
    } else if (line === '') {
      oldLines.push('');
      newLines.push('');
    }
  }

  const filePath =
    (newPath && newPath !== '/dev/null' ? newPath : oldPath && oldPath !== '/dev/null' ? oldPath : null) ?? null;
  if (!filePath) return { filePath: null, change: null };

  let oldText = oldLines.join('\n');
  let newText = newLines.join('\n');
  if (oldText.endsWith('\n')) oldText = oldText.slice(0, -1);
  if (newText.endsWith('\n')) newText = newText.slice(0, -1);

  const change: UnknownRecord = {};
  if (isDelete || newPath === '/dev/null') {
    change.type = 'delete';
    change.delete = { content: oldText };
  } else if (isAdd || oldPath === '/dev/null') {
    change.type = 'add';
    change.add = { content: newText };
  } else {
    change.type = 'update';
    change.modify = { old_content: oldText, new_content: newText };
  }

  return { filePath, change };
}

function normalizeSinglePatchChange(raw: unknown): UnknownRecord {
  const record = asRecord(raw);
  if (!record) return { value: raw };

  const type = firstNonEmptyString(record.type)?.toLowerCase() ?? null;
  const content = asString(record.content);
  const unifiedDiff = firstNonEmptyString(record.unified_diff) ?? firstNonEmptyString(record.unifiedDiff);
  const oldContent = asString(record.old_content) ?? asString(record.oldContent);
  const newContent = asString(record.new_content) ?? asString(record.newContent);

  const next: UnknownRecord = { ...record };

  if (type === 'add' && typeof content === 'string') {
    next.add = { content };
    return next;
  }

  if ((type === 'update' || type === 'modify') && typeof oldContent === 'string' && typeof newContent === 'string') {
    next.modify = { old_content: oldContent, new_content: newContent };
    return next;
  }

  if ((type === 'update' || type === 'modify') && unifiedDiff) {
    const parsed = parsePatchHunk(unifiedDiff);
    if (parsed) {
      next.modify = { old_content: parsed.oldText, new_content: parsed.newText };
      return next;
    }
  }

  if (type === 'delete' || type === 'remove') {
    next.delete = { content: content ?? oldContent ?? '' };
    return next;
  }

  return next;
}

function normalizePatchChangeArray(input: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(input.changes) || input.changes.length === 0) return null;

  const normalizedChanges: Record<string, unknown> = {};

  for (const entry of input.changes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const path = firstNonEmptyString(record.path);
    if (!path) continue;

    const rawKind = record.kind;
    const kind =
      rawKind && typeof rawKind === 'object' && !Array.isArray(rawKind)
        ? (rawKind as Record<string, unknown>)
        : null;
    const type = firstNonEmptyString(kind?.type)?.toLowerCase() ?? 'update';
    const targetPath = firstNonEmptyString(kind?.move_path) ?? path;
    const diff = typeof record.diff === 'string' ? record.diff : '';

    if (type === 'add') {
      normalizedChanges[targetPath] = {
        type: 'add',
        add: { content: diff },
      };
      continue;
    }

    if (type === 'delete' || type === 'remove') {
      normalizedChanges[targetPath] = {
        type: 'delete',
        delete: { content: diff },
      };
      continue;
    }

    const parsedHunk = parsePatchHunk(diff);
    normalizedChanges[targetPath] = parsedHunk
      ? {
          type: 'update',
          modify: {
            old_content: parsedHunk.oldText,
            new_content: parsedHunk.newText,
          },
        }
      : { type: 'update' };
  }

  if (Object.keys(normalizedChanges).length === 0) return null;
  return { ...input, changes: normalizedChanges };
}

function normalizePatchFromUnifiedDiff(input: Record<string, unknown>): Record<string, unknown> | null {
  if (asNonEmptyRecord(input.changes)) return null;

  const diff =
    typeof input.unified_diff === 'string'
      ? input.unified_diff
      : typeof input.diff === 'string'
        ? input.diff
        : typeof input.patch === 'string'
          ? input.patch
          : typeof input.patchText === 'string'
            ? input.patchText
            : typeof input.patch_text === 'string'
              ? input.patch_text
              : null;
  if (!diff || diff.trim().length === 0) return null;

  const blocks = diff.split(/\n(?=diff --git )/g);
  const changes: Record<string, unknown> = {};

  for (const block of blocks) {
    const { filePath, change } = parseUnifiedDiffFileBlock(block);
    if (!filePath || !change) continue;
    changes[filePath] = change;
  }

  if (Object.keys(changes).length > 0) {
    return { ...input, changes };
  }

  const inferred = parseApplyPatchTextChanges(diff);
  if (!inferred) return null;
  return { ...input, changes: inferred };
}

export function normalizePatchInputRecord(input: Record<string, unknown>): Record<string, unknown> {
  const fromArray = normalizePatchChangeArray(input);
  if (fromArray) return fromArray;

  const fromDiff = normalizePatchFromUnifiedDiff(input);
  if (fromDiff) return fromDiff;

  const changes = asNonEmptyRecord(input.changes);
  if (!changes) return { ...input };

  const normalizedChanges: Record<string, unknown> = {};
  for (const [path, change] of Object.entries(changes)) {
    normalizedChanges[path] = normalizeSinglePatchChange(change);
  }
  return { ...input, changes: normalizedChanges };
}

export function deriveCanonicalPatchFileDiffs(input: unknown): CanonicalPatchFileDiff[] {
  const record = asRecord(input);
  if (!record) return [];

  const normalized = normalizePatchInputRecord(record);
  const changes = asNonEmptyRecord(normalized.changes);
  if (!changes) return [];

  const files: CanonicalPatchFileDiff[] = [];
  for (const [filePath, rawChange] of Object.entries(changes)) {
    if (!filePath.trim()) continue;
    const change = asRecord(rawChange);
    if (!change) continue;

    const add = asRecord(change.add);
    const del = asRecord(change.delete);
    const modify = asRecord(change.modify);

    const addContent = asString(add?.content);
    const deleteContent = asString(del?.content) ?? '';
    const oldContent = asString(modify?.old_content) ?? asString(modify?.oldContent);
    const newContent = asString(modify?.new_content) ?? asString(modify?.newContent);
    const unifiedDiff = firstNonEmptyString(change.unified_diff) ?? firstNonEmptyString(change.unifiedDiff);

    if (typeof addContent === 'string') {
      files.push({ filePath, oldText: '', newText: addContent });
      continue;
    }

    if (typeof oldContent === 'string' && typeof newContent === 'string') {
      files.push({ filePath, oldText: oldContent, newText: newContent });
      continue;
    }

    if (del || typeof change.type === 'string') {
      const type = typeof change.type === 'string' ? String(change.type).toLowerCase() : null;
      if (type === 'delete' || type === 'remove' || del) {
        files.push({ filePath, oldText: deleteContent, newText: '' });
        continue;
      }
    }

    if (typeof unifiedDiff === 'string') {
      files.push({ filePath, unifiedDiff });
      continue;
    }
  }

  return files;
}
