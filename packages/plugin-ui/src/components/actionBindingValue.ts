import type { PluginUiActionBinding } from '@happier-dev/plugin-sdk/ui';

function hasActionMap<Value, Key extends string>(
  binding: PluginUiActionBinding<Value, Key>,
): binding is Extract<PluginUiActionBinding<Value, Key>, { actions: unknown }> {
  return binding.actions !== undefined;
}

/** Adapt a physical control value while preserving the declared Action map. Null cancels preparation. */
export function mapActionBindingValue<Source, Target, Key extends string = string>(
  binding: PluginUiActionBinding<Source, Key>,
  mapValue: (value: Target) => Source | null,
): PluginUiActionBinding<Target, Key> {
  if (hasActionMap(binding)) {
    const prepare = binding.prepare;
    return { ...binding, prepare(value, options) {
      const source = mapValue(value);
      return source === null ? null : prepare(source, options);
    } };
  }
  const prepare = binding.prepare;
  return { ...binding, prepare(value, options) {
    const source = mapValue(value);
    return source === null ? null : prepare(source, options);
  } };
}
