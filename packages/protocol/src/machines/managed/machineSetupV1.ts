import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { SecretReferenceOverlayV1Schema } from '../../profiles/secretReferenceOverlayV1.js';
import { MachineRecipeSelectionV1Schema, MachineRecipeImpactV1Schema, MachineSetupScriptCheckV1Schema,
  type MachineRecipeSelectionV1 } from '../setup/machineRecipeV1.js';
import { StoredAppPresetInputV1Schema, type StoredAppPresetInputV1 } from '../../deployments/storedAppInputV1.js';

export type MachinePresetItemV1 =
  | Readonly<{ kind: 'setupRecipe'; selection: MachineRecipeSelectionV1 }>
  | Readonly<{ kind: 'softwareRecipe'; selection: MachineRecipeSelectionV1 }>
  | Readonly<{ kind: 'app'; definition: StoredAppPresetInputV1 }>;
export const MachinePresetItemV1Schema: z.ZodMiniType<MachinePresetItemV1> = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('setupRecipe'), selection: MachineRecipeSelectionV1Schema }),
  z.strictObject({ kind: z.literal('softwareRecipe'), selection: MachineRecipeSelectionV1Schema }),
  z.strictObject({ kind: z.literal('app'), definition: StoredAppPresetInputV1Schema }),
]));

/** Stable public value type keeps nested Preset/Action declarations finite. */
export type MachineSetupScriptV1 = Readonly<{
  body: string;
  affects?: z.infer<typeof MachineRecipeImpactV1Schema>;
  check?: z.infer<typeof MachineSetupScriptCheckV1Schema>;
}>;
const scriptAffectsSchema = z.union([
  z.literal('none'),
  z.literal('dockerEngine'),
  z.strictObject({ services: z.array(z.string().check(z.trim(), z.minLength(1))) }),
]);
export const MachineSetupScriptV1Schema: z.ZodMiniType<MachineSetupScriptV1> = lazyZodSchema(() => z.strictObject({
  body: z.string(), affects: z.optional(scriptAffectsSchema), check: z.optional(MachineSetupScriptCheckV1Schema),
}));

export type MachineSetupV1 = Readonly<{
  toolchain?: { adapterId: string; config: string };
  items?: MachinePresetItemV1[];
  scripts?: MachineSetupScriptV1[];
  secretRefs?: z.infer<typeof SecretReferenceOverlayV1Schema>;
}>;

const setupShape = {
  toolchain: z.optional(z.strictObject({ adapterId: z.string().check(z.trim(), z.minLength(1)), config: z.string() })),
  items: z.optional(z.array(MachinePresetItemV1Schema)),
  scripts: z.optional(z.array(MachineSetupScriptV1Schema)),
  secretRefs: z.optional(SecretReferenceOverlayV1Schema),
};

/** One persisted predecessor reader; current admission and every write use scripts. */
export const MachineSetupV1Schema: z.ZodMiniType<MachineSetupV1> = defineStoredReadProjection(
  lazyZodSchema(() => z.strictObject(setupShape)),
  () => z.pipe(createStoredReadSchema(z.strictObject({
    ...setupShape,
    setupScript: z.optional(z.string()),
    setupScriptAffects: z.optional(scriptAffectsSchema),
    setupScriptCheck: z.optional(MachineSetupScriptCheckV1Schema),
  })).check(z.refine(value => value.scripts === undefined || value.setupScript === undefined
    && value.setupScriptAffects === undefined && value.setupScriptCheck === undefined,
  { message: 'Stored setup cannot mix singular and ordered scripts.' })), z.transform((value): MachineSetupV1 => {
    const { setupScript, setupScriptAffects, setupScriptCheck, ...setup } = value;
    return setupScript === undefined ? setup : { ...setup, scripts: [{ body: setupScript,
      ...(setupScriptAffects === undefined ? {} : { affects: setupScriptAffects }),
      ...(setupScriptCheck === undefined ? {} : { check: setupScriptCheck }),
    }] };
  })),
);
export const MachineSetupV1ReadSchema = createStoredReadSchema(MachineSetupV1Schema);

/** Snapshot-only union, shared by capture and native preparation; never resolves values. */
export function mergeMachineSetupsV1(setups: readonly MachineSetupV1[]):
  Readonly<{ ok: true; setup: MachineSetupV1 }>
  | Readonly<{ ok: false; errorCode: 'machine_setup_conflict'; error: 'machine_setup_conflict' }> {
  const conflict = { ok: false, errorCode: 'machine_setup_conflict', error: 'machine_setup_conflict' } as const;
  let toolchain: MachineSetupV1['toolchain'];
  const bindings: NonNullable<MachineSetupV1['secretRefs']>['bindings'] = {};
  const items: MachinePresetItemV1[] = [];
  const byRecipe = new Map<string, MachinePresetItemV1>();
  const apps = new Set<string>();
  const scripts: MachineSetupScriptV1[] = [];
  for (const setup of setups) {
    if (setup.toolchain) {
      if (toolchain && !sameStrictJsonValue(toolchain, setup.toolchain)) return conflict;
      toolchain = setup.toolchain;
    }
    for (const [name, binding] of Object.entries(setup.secretRefs?.bindings ?? {})) {
      if (bindings[name] && !sameStrictJsonValue(bindings[name], binding)) return conflict;
      bindings[name] = binding;
    }
    for (const item of setup.items ?? []) {
      if (item.kind === 'app') {
        const key = createCanonicalJsonSigningInput(item);
        if (apps.has(key)) return conflict;
        apps.add(key);
      } else {
        const key = JSON.stringify([item.selection.ref.pluginId, item.selection.ref.recipeId]);
        const previous = byRecipe.get(key);
        if (previous) {
          if (!sameStrictJsonValue(previous, item)) return conflict;
          continue;
        }
        byRecipe.set(key, item);
      }
      items.push(item);
    }
    scripts.push(...setup.scripts ?? []);
  }
  return { ok: true, setup: {
    ...(toolchain ? { toolchain } : {}),
    ...(setups.some(setup => setup.items !== undefined) ? { items } : {}),
    ...(setups.some(setup => setup.scripts !== undefined) ? { scripts } : {}),
    ...(Object.keys(bindings).length ? { secretRefs: { v: 1, bindings } } : {}),
  } };
}
