import { describe, expect, it } from 'vitest';
import * as protocol from '../../index.js';
import { ImageMarksDocumentV1Schema, applyImageMarksOperations, countBlurMarks, formatStepNotes, hasBlur, isEmptyEdit, stepNumbers } from './imageMarksV1.js';

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
  it('carries an optional note on a numbered step and writes the agent its steps in number order', () => {
    const doc = ImageMarksDocumentV1Schema.parse({ v: 1, image: { width: 400, height: 300, scale: 1 }, marks: [
      { id: 'a', kind: 'step', at: { x: 1, y: 1 }, color: 'red', size: 'm', note: 'Move this group under Input' },
      { id: 'arrow', kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, color: 'red', size: 'm' },
      { id: 'b', kind: 'step', at: { x: 2, y: 2 }, color: 'red', size: 'm' },
      { id: 'c', kind: 'step', at: { x: 3, y: 3 }, color: 'red', size: 'm', note: 'List the microphones\nnot only System default' },
    ] });
    expect(formatStepNotes(doc)).toBe('Numbered marks:\n1. Move this group under Input\n2. (no note)\n3. List the microphones\n   not only System default');
    // Removing a step renumbers the rest; a video frame continues the message's numbering.
    const removed = applyImageMarksOperations(doc, [{ kind: 'mark.remove', id: 'b' }]);
    expect(formatStepNotes(removed, { firstNumber: 4, label: 'Numbered marks on [Image #2]' }))
      .toBe('Numbered marks on [Image #2]:\n4. Move this group under Input\n5. List the microphones\n   not only System default');
    // Numbers alone still reach the agent as steps, in order; only a picture without steps has no words.
    expect(formatStepNotes({ ...doc, marks: [{ id: 'b', kind: 'step', at: { x: 2, y: 2 }, color: 'red', size: 'm', note: '  ' }] }))
      .toBe('Numbered marks:\n1. (no note)');
    expect(formatStepNotes({ ...doc, marks: [doc.marks[1]!] })).toBeNull();
  });
});
