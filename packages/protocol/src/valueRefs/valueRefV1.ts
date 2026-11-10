import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { appendSavedSecretReferencePathV1 } from '../account/settings/savedSecretReferenceV1.js';

const ValueRefAtomV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('literal'), v: z.string() }),
  z.strictObject({ t: z.literal('savedSecret'), secretId: z.string().check(z.minLength(1)) }),
]));

export const ValueRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  ...ValueRefAtomV1Schema._zod.def.options,
  z.strictObject({ t: z.literal('template'), template: z.string(), vars: z.record(z.string(), ValueRefAtomV1Schema) }),
  z.strictObject({ t: z.literal('sessionAttested'), field: z.enum(['externalPrincipalId', 'sourceMessageId', 'sessionId']) }),
]));

export type ValueRefV1 = z.infer<typeof ValueRefV1Schema>;

/** Session facts require the runtime's admitted session context. */
export function resolveValueRefPlaintextV1(ref: ValueRefV1, resolveSecret: (secretId: string) => string | null): string | null {
  if (ref.t === 'literal') return ref.v;
  if (ref.t === 'savedSecret') return resolveSecret(ref.secretId);
  if (ref.t === 'template') {
    let unavailable = false;
    const rendered = ref.template.replace(/\{([^{}]*)\}/gu, (_placeholder, name: string) => {
      const variable = Object.hasOwn(ref.vars, name) ? ref.vars[name] : undefined;
      const value = variable?.t === 'literal' ? variable.v
        : variable?.t === 'savedSecret' ? resolveSecret(variable.secretId) : null;
      if (value === null) unavailable = true;
      return value ?? '';
    });
    return unavailable ? null : rendered;
  }
  return null;
}

export function listValueRefSecretIdsV1(ref: ValueRefV1): readonly string[] {
  return listValueRefSavedSecretRefsV1(ref).map(reference => reference.secretId);
}

/** Relative carrier paths let every catalog use the same template census. */
export function listValueRefSavedSecretRefsV1(ref: ValueRefV1): readonly Readonly<{ path: string; secretId: string }>[] {
  if (ref.t === 'savedSecret') return [{ path: '', secretId: ref.secretId }];
  if (ref.t !== 'template') return [];
  return Object.entries(ref.vars).flatMap(([name, variable]) => variable.t === 'savedSecret'
    ? [{ path: appendSavedSecretReferencePathV1('vars', name), secretId: variable.secretId }] : []);
}

/** The same reference owner rewrites direct and template bindings without changing literal values. */
export function remapValueRefSavedSecretReferencesV1(ref: ValueRefV1, mapping: Readonly<Record<string, string>>): ValueRefV1 {
  if (ref.t === 'savedSecret') return Object.hasOwn(mapping, ref.secretId) && mapping[ref.secretId] !== ref.secretId
    ? { ...ref, secretId: mapping[ref.secretId]! } : ref;
  if (ref.t !== 'template') return ref;
  let changed = false;
  const vars = Object.fromEntries(Object.entries(ref.vars).map(([name, value]) => {
    const next = value.t === 'savedSecret' && Object.hasOwn(mapping, value.secretId) && mapping[value.secretId] !== value.secretId
      ? { ...value, secretId: mapping[value.secretId]! } : value;
    if (next !== value) changed = true;
    return [name, next];
  }));
  return changed ? { ...ref, vars } : ref;
}
