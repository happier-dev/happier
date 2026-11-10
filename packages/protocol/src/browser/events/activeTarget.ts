import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { BROWSER_AUTOMATION_TARGET_LABEL_MAX_LENGTH, redactBrowserAutomationTargetLabel } from '../automation/redaction.js';

/** Visible element rectangle in page-viewport coordinates; x/y are its centre. */
export const BrowserActiveTargetV1Schema = lazyZodSchema(() => z.strictObject({
  x: z.number().check(z.minimum(0), z.maximum(1)), y: z.number().check(z.minimum(0), z.maximum(1)),
  width: z.number().check(z.minimum(0), z.maximum(1)), height: z.number().check(z.minimum(0), z.maximum(1)),
  /** Accessible name or visible non-editable text; never field values or typed input. */
  label: z.optional(z.pipe(z.string().check(z.maxLength(BROWSER_AUTOMATION_TARGET_LABEL_MAX_LENGTH)), z.transform(redactBrowserAutomationTargetLabel))),
}));
export type BrowserActiveTargetV1 = z.infer<typeof BrowserActiveTargetV1Schema>;

/** Self-contained for CDP and the installed collector; redaction runs at schema admission. */
export function readBrowserActiveTargetLabel(
  element: Readonly<{
    tagName: string;
    textContent: string | null;
    isContentEditable?: boolean;
    getAttribute(name: string): string | null;
  }>,
  maxLength: number,
  locatorLabel?: string,
): string | undefined {
  const editable = /^(INPUT|TEXTAREA|SELECT)$/iu.test(element.tagName) || element.isContentEditable
    || element.getAttribute('contenteditable') === '' || element.getAttribute('contenteditable') === 'true';
  const label = String(element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title')
    || (!editable && (locatorLabel || element.textContent)) || '').replace(/\s+/gu, ' ').trim().slice(0, maxLength);
  return label || undefined;
}

/** Self-contained because both CDP and the installed page collector run this same projection. */
export function normalizeBrowserActiveTargetRect(
  rect: Readonly<{ x: number; y: number; width: number; height: number }>,
  viewport: Readonly<{ width: number; height: number }>,
): BrowserActiveTargetV1 | null {
  const w = viewport.width, h = viewport.height;
  if (![w, h, rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  const left = Math.max(0, Math.min(w, rect.x)), top = Math.max(0, Math.min(h, rect.y));
  const right = Math.max(left, Math.min(w, rect.x + rect.width)), bottom = Math.max(top, Math.min(h, rect.y + rect.height));
  if (right === left || bottom === top) return null;
  return { x: (left + right) / (2 * w), y: (top + bottom) / (2 * h), width: (right - left) / w, height: (bottom - top) / h };
}
