import { describe, expect, it } from 'vitest';
import * as protocol from '../../index.js';
import { ImageMarksDocumentV1Schema, applyImageMarksOperations, countBlurMarks, hasBlur, isEmptyEdit, stepNumbers } from './imageMarksV1.js';

describe('image marks public owner', () => {
  it('exposes one serializable marks schema and shared operations for UI and Actions', () => {
    expect(protocol).toHaveProperty('ImageMarksDocumentV1Schema');
    expect(protocol).toHaveProperty('applyImageMarksOperations');
    expect(protocol).toHaveProperty('hasBlur');
  });
  it('admits closed image-space marks and keeps unaffected marks shared across operations', () => {
    const doc = ImageMarksDocumentV1Schema.parse({ v: 1, image: { width: 400, height: 300, scale: 2 }, marks: [
      { id: 'first', kind: 'step', at: { x: 10, y: 20 }, color: 'red', size: 'm' },
      { id: 'second', kind: 'step', at: { x: 30, y: 40 }, color: 'blue', size: 's' },
    ] });
    const edited = applyImageMarksOperations(doc, [
      { kind: 'mark.remove', id: 'first' },
      { kind: 'mark.add', mark: { kind: 'blur', id: 'blur', rect: { x: 0, y: 0, width: 20, height: 20 }, size: 'm' } },
      { kind: 'crop.set', rect: { x: 0, y: 0, width: 200, height: 100 } },
    ]);
    expect(edited.marks[0]).toBe(doc.marks[1]);
    expect(stepNumbers(edited)).toEqual({ second: 1 });
    expect(stepNumbers({ ...doc, marks: [
      { kind: 'element', id: 'picked', rect: { x: 0, y: 0, width: 20, height: 20 }, label: 'TotalRow', color: 'red' },
      { kind: 'step', id: 'stamped', at: { x: 4, y: 4 }, color: 'red', size: 'm' },
    ] })).toEqual({ stamped: 1 });
    expect(hasBlur(edited)).toBe(true);
    expect(isEmptyEdit(applyImageMarksOperations(edited, [{ kind: 'reset' }]))).toBe(true);
    expect(doc.marks).toHaveLength(2);
    expect(applyImageMarksOperations(doc, [{ kind: 'mark.remove', id: 'missing' }])).toBe(doc);
  });
  it('rejects unknown kinds, fields, non-finite coordinates and duplicate identities at admission', () => {
    const doc = { v: 1, image: { width: 400, height: 300, scale: 1 }, marks: [] };
    for (const bad of [
      { ...doc, extra: true }, { ...doc, image: { ...doc.image, scale: 0 } },
      { ...doc, marks: [{ kind: 'unknown', id: 'x' }] },
      { ...doc, marks: [{ kind: 'step', id: 'x', at: { x: Infinity, y: 0 }, color: 'red', size: 'm' }] },
      { ...doc, marks: Array(2).fill({ kind: 'step', id: 'x', at: { x: 0, y: 0 }, color: 'red', size: 'm' }) },
    ]) expect(ImageMarksDocumentV1Schema.safeParse(bad).success).toBe(false);
  });
  it('counts blur marks for disclosure transitions, including marks retained outside the crop', () => {
    const document = ImageMarksDocumentV1Schema.parse({ v: 1, image: { width: 100, height: 100, scale: 1 },
      crop: { x: 0, y: 0, width: 10, height: 10 }, marks: [
        { id: 'inside', kind: 'blur', rect: { x: 1, y: 1, width: 5, height: 5 }, size: 's' },
        { id: 'outside', kind: 'blur', rect: { x: 50, y: 50, width: 5, height: 5 }, size: 's' },
        { id: 'arrow', kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 10, y: 10 }, color: 'red', size: 's' },
      ] });
    expect(countBlurMarks(document)).toBe(2);
    expect(hasBlur(document)).toBe(true);
    const empty = applyImageMarksOperations(document, [{ kind: 'reset' }]);
    expect(countBlurMarks(empty)).toBe(0);
    expect(hasBlur(empty)).toBe(false);
  });
});
