import type { ActionInputFieldHint, ActionSpec } from './actionSpecs.js';

function setByPath(obj: Record<string, any>, path: string, value: unknown): void {
  const parts = String(path ?? '')
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return;

  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    const next = cur[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cur[key] = {};
    }
    cur = cur[key];
  }
  cur[parts[parts.length - 1]!] = value;
}

function getFieldHints(spec: ActionSpec): readonly ActionInputFieldHint[] {
  return Array.isArray(spec.inputHints?.fields) ? spec.inputHints!.fields : [];
}

function findPrimaryBackendSelectionField(hints: readonly ActionInputFieldHint[]): ActionInputFieldHint | null {
  // Convention: first multiselect field with an options source represents backend/engine selection.
  for (const hint of hints) {
    if (hint.widget !== 'multiselect') continue;
    if (typeof (hint as any).optionsSourceId === 'string' && String((hint as any).optionsSourceId).trim().length > 0) {
      return hint;
    }
  }
  return null;
}

function findInstructionsField(hints: readonly ActionInputFieldHint[]): ActionInputFieldHint | null {
  for (const hint of hints) {
    if (hint.path === 'instructions') return hint;
  }
  for (const hint of hints) {
    if (hint.widget === 'textarea') return hint;
  }
  return null;
}

export function buildActionDraftSeedInput(
  spec: ActionSpec,
  ctx: Readonly<{ defaultBackendId?: string | null; instructions?: string | null }>,
): Record<string, unknown> {
  const hints = getFieldHints(spec);
  const seed: Record<string, any> = {};

  const backendId = String(ctx.defaultBackendId ?? '').trim();
  if (backendId) {
    const backendField = findPrimaryBackendSelectionField(hints);
    if (backendField?.path) {
      setByPath(seed, backendField.path, [backendId]);
    }
  }

  const instructions = ctx.instructions === null || ctx.instructions === undefined ? null : String(ctx.instructions);
  if (instructions !== null) {
    const instructionsField = findInstructionsField(hints);
    if (instructionsField?.path) {
      setByPath(seed, instructionsField.path, instructions);
    }
  }

  // Seed required selects with their first option. This keeps draft UIs usable even when the user
  // starts via a chip and the underlying input schema requires a value.
  for (const hint of hints) {
    if (hint.widget !== 'select') continue;
    if (hint.required !== true) continue;
    const options = Array.isArray((hint as any).options) ? ((hint as any).options as Array<{ value: unknown }>) : [];
    if (options.length === 0) continue;
    setByPath(seed, hint.path, options[0]!.value);
  }

  return seed;
}

