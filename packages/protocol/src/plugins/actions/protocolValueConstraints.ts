import { pluginJsonValuesEqual } from '../contributions/jsonSchemaValues.js';
import { z } from '../../zodRuntimePolicy.js';

type ProtocolConstraintScalar = string | number | boolean | null;
type ProtocolConstraintPath = readonly (string | number)[];
export type ProtocolValueOperand = Readonly<{
  path: ProtocolConstraintPath;
  measure?: 'length';
}> | Readonly<{ value: ProtocolConstraintScalar }>;

/** Left-hand array `*` segments select every item; right-hand and condition paths select one value. */
export type ProtocolValueConstraint = Readonly<{
  kind: 'equal' | 'not_equal' | 'less_than';
  left: ProtocolValueOperand;
  right: ProtocolValueOperand;
  when?: Readonly<{ path: ProtocolConstraintPath; equals: ProtocolConstraintScalar }>;
}>;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const index = z.number().check(z.int(), z.nonnegative());
const selectedPath = z.array(z.union([z.string(), index]));
const singlePath = z.array(z.union([z.string().check(z.regex(/^(?!\*$)[\s\S]*$/u)), index]));
const literalOperand = z.strictObject({ value: scalar });
const selectedOperand = z.union([literalOperand, z.strictObject({
  path: selectedPath, measure: z.optional(z.literal('length')),
})]);
const singleOperand = z.union([literalOperand, z.strictObject({
  path: singlePath, measure: z.optional(z.literal('length')),
})]);

// Ordinary closed schema nodes keep the containing JSON Schema DTO itself
// projectable (Workflow Action outputs include schema documents recursively).
export const ProtocolValueConstraintsSchema: z.ZodMiniType<readonly ProtocolValueConstraint[]> = z.array(z.strictObject({
  kind: z.enum(['equal', 'not_equal', 'less_than']),
  left: selectedOperand,
  right: singleOperand,
  when: z.optional(z.strictObject({ path: singlePath, equals: scalar })),
}));

/** Shared declaration admission for the composable constructor and JSON Schema compiler. */
export function isProtocolValueConstraints(value: unknown): value is readonly ProtocolValueConstraint[] {
  return ProtocolValueConstraintsSchema.safeParse(value).success;
}

function select(value: unknown, segments: ProtocolConstraintPath): unknown[] | null {
  let selected = [value];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const current of selected) {
      if (segment === '*') {
        if (!Array.isArray(current)) return null;
        for (const item of current) next.push(item);
      } else {
        if ((current === null || typeof current !== 'object') || !Object.hasOwn(current, segment)) return null;
        next.push((current as Record<string | number, unknown>)[segment]);
      }
    }
    selected = next;
  }
  return selected;
}

function values(value: unknown, operand: ProtocolValueOperand): unknown[] | null {
  if ('value' in operand) return [operand.value];
  const selected = select(value, operand.path);
  if (!selected || operand.measure === undefined) return selected;
  const measured: number[] = [];
  for (const item of selected) {
    if (!Array.isArray(item) && typeof item !== 'string') return null;
    measured.push(item.length);
  }
  return measured;
}

/** One evaluator owns executable and portable cross-value semantics. */
export function satisfiesProtocolValueConstraints(value: unknown, constraints: readonly ProtocolValueConstraint[]): boolean {
  return constraints.every(constraint => {
    if (constraint.when) {
      const condition = constraint.when;
      const selected = select(value, condition.path);
      if (!selected) return false;
      if (!selected.every(item => pluginJsonValuesEqual(item, condition.equals))) return true;
    }
    const left = values(value, constraint.left);
    const right = values(value, constraint.right);
    if (!left || !right || right.length !== 1) return false;
    const b = right[0];
    return left.every(a => constraint.kind === 'less_than'
      ? typeof a === 'number' && typeof b === 'number' && a < b
      : constraint.kind === 'equal' ? pluginJsonValuesEqual(a, b) : !pluginJsonValuesEqual(a, b));
  });
}
