import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

export const ImageMarkColorV1Schema = lazyZodSchema(() => z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'ink']));
export const ImageMarkSizeV1Schema = lazyZodSchema(() => z.enum(['s', 'm', 'l']));
export const ImagePointV1Schema = lazyZodSchema(() => z.strictObject({ x: z.number(), y: z.number() }));
export const ImageRectV1Schema = lazyZodSchema(() => z.strictObject({
  x: z.number(), y: z.number(), width: z.number().check(z.positive()), height: z.number().check(z.positive()),
}));
export const ImageMarksImageV1Schema = lazyZodSchema(() => z.strictObject({
  width: z.number().check(z.positive()), height: z.number().check(z.positive()), scale: z.number().check(z.positive()),
}));
export const ImageMarkV1Schema = lazyZodSchema(() => {
  const identity = { id: z.string().check(z.minLength(1)) };
  const style = { color: ImageMarkColorV1Schema, size: ImageMarkSizeV1Schema };
  return z.discriminatedUnion('kind', [
    z.strictObject({ ...identity, ...style, kind: z.literal('arrow'), from: ImagePointV1Schema, to: ImagePointV1Schema }),
    z.strictObject({ ...identity, ...style, kind: z.literal('rectangle'), rect: ImageRectV1Schema }),
    z.strictObject({ ...identity, ...style, kind: z.literal('ellipse'), rect: ImageRectV1Schema }),
    z.strictObject({ ...identity, ...style, kind: z.literal('freehand'), points: z.array(ImagePointV1Schema).check(z.minLength(1)) }),
    z.strictObject({ ...identity, ...style, kind: z.literal('highlighter'), points: z.array(ImagePointV1Schema).check(z.minLength(1)) }),
    z.strictObject({ ...identity, ...style, kind: z.literal('text'), at: ImagePointV1Schema, text: z.string() }),
    z.strictObject({ ...identity, ...style, kind: z.literal('step'), at: ImagePointV1Schema }),
    z.strictObject({ ...identity, kind: z.literal('blur'), rect: ImageRectV1Schema, size: ImageMarkSizeV1Schema }),
    z.strictObject({ ...identity, kind: z.literal('element'), rect: ImageRectV1Schema, label: z.string(), color: ImageMarkColorV1Schema }),
  ]);
});
export const ImageMarksDocumentV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), image: ImageMarksImageV1Schema, crop: z.optional(ImageRectV1Schema), marks: z.array(ImageMarkV1Schema),
}).check(z.refine(doc => new Set(doc.marks.map(mark => mark.id)).size === doc.marks.length, { message: 'Duplicate mark identity' })));

export const ImageMarksOperationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mark.add'), mark: ImageMarkV1Schema }),
  z.strictObject({ kind: z.literal('mark.update'), mark: ImageMarkV1Schema }),
  z.strictObject({ kind: z.literal('mark.remove'), id: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('mark.reorder'), id: z.string().check(z.minLength(1)), index: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ kind: z.literal('crop.set'), rect: ImageRectV1Schema }),
  z.strictObject({ kind: z.literal('crop.clear') }),
  z.strictObject({ kind: z.literal('reset') }),
]));

export type ImageMarkColorV1 = z.infer<typeof ImageMarkColorV1Schema>;
export type ImageMarkSizeV1 = z.infer<typeof ImageMarkSizeV1Schema>;
export type ImagePointV1 = z.infer<typeof ImagePointV1Schema>;
export type ImageRectV1 = z.infer<typeof ImageRectV1Schema>;
export type ImageMarksImageV1 = z.infer<typeof ImageMarksImageV1Schema>;
export type ImageMarkV1 = z.infer<typeof ImageMarkV1Schema>;
export type ImageMarksDocumentV1 = z.infer<typeof ImageMarksDocumentV1Schema>;
export type ImageMarksOperationV1 = z.infer<typeof ImageMarksOperationV1Schema>;

export function hasBlur(document: ImageMarksDocumentV1): boolean {
  return countBlurMarks(document) > 0;
}
export function countBlurMarks(document: ImageMarksDocumentV1): number {
  let count = 0;
  for (const mark of document.marks) if (mark.kind === 'blur') count += 1;
  return count;
}
export function isEmptyEdit(document: ImageMarksDocumentV1): boolean {
  return document.marks.length === 0 && document.crop === undefined;
}
export function stepNumbers(document: ImageMarksDocumentV1): Readonly<Record<string, number>> {
  const numbers: Record<string, number> = {};
  let next = 1;
  for (const mark of document.marks) if (mark.kind === 'step') numbers[mark.id] = next++;
  return numbers;
}

/** Admitted operations share one owner between interactive edits and headless Actions. */
export function applyImageMarksOperations(document: ImageMarksDocumentV1, operations: readonly ImageMarksOperationV1[]): ImageMarksDocumentV1 {
  let next = document;
  for (const operation of operations) {
    switch (operation.kind) {
      case 'mark.add':
        if (next.marks.some(mark => mark.id === operation.mark.id)) throw new Error('Duplicate mark identity');
        next = { ...next, marks: [...next.marks, operation.mark] };
        break;
      case 'mark.update': {
        const index = next.marks.findIndex(mark => mark.id === operation.mark.id);
        if (index >= 0 && next.marks[index] !== operation.mark) next = { ...next, marks: next.marks.map((mark, i) => i === index ? operation.mark : mark) };
        break;
      }
      case 'mark.remove':
        if (next.marks.some(mark => mark.id === operation.id)) next = { ...next, marks: next.marks.filter(mark => mark.id !== operation.id) };
        break;
      case 'mark.reorder': {
        const index = next.marks.findIndex(mark => mark.id === operation.id);
        const destination = Math.min(operation.index, next.marks.length - 1);
        if (index < 0 || index === destination) break;
        const marks = [...next.marks];
        const [mark] = marks.splice(index, 1);
        marks.splice(destination, 0, mark!);
        next = { ...next, marks };
        break;
      }
      case 'crop.set': next = { ...next, crop: operation.rect }; break;
      case 'crop.clear': {
        if (!next.crop) break;
        const { crop: _crop, ...uncropped } = next;
        next = uncropped;
        break;
      }
      case 'reset': if (!isEmptyEdit(next)) next = { v: 1, image: next.image, marks: [] }; break;
    }
  }
  return next;
}
