import type { PluginUiPortableAction } from '../actions.js';

export type PluginUiDescriptorPrimitive =
  | PluginUiDescriptorPanel
  | PluginUiDescriptorAction
  | PluginUiDescriptorList
  | PluginUiDescriptorState
  | PluginUiDescriptorText;

export type PluginUiDescriptorPanel = Readonly<{
  kind: 'panel';
  titleKey: string;
  descriptionKey?: string;
  children?: readonly PluginUiDescriptorPrimitive[];
}>;

export type PluginUiDescriptorAction = Readonly<{
  kind: 'action';
  id: string;
  labelKey: string;
  action: PluginUiPortableAction;
  children?: readonly PluginUiDescriptorPrimitive[];
}>;

export type PluginUiDescriptorList = Readonly<{
  kind: 'list';
  itemResourcePath?: string;
  emptyKey?: string;
  children?: readonly PluginUiDescriptorPrimitive[];
}>;

export type PluginUiDescriptorState = Readonly<{
  kind: 'state';
  resourcePath?: string;
  loadingKey?: string;
  emptyKey?: string;
  errorKey?: string;
  children?: readonly PluginUiDescriptorPrimitive[];
}>;

export type PluginUiDescriptorText = Readonly<{
  kind: 'text';
  value?: string;
  valueKey?: string;
}>;

type DescriptorChildrenInput = Readonly<{
  children?: readonly PluginUiDescriptorPrimitive[];
}>;

function readRequiredString(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Expected ${fieldName} to be a non-empty string.`);
  }
  return trimmed;
}

function freezeChildren(
  input: DescriptorChildrenInput,
): readonly PluginUiDescriptorPrimitive[] | undefined {
  return input.children ? Object.freeze([...input.children]) : undefined;
}

export function defineDescriptorPanel(
  input: Omit<PluginUiDescriptorPanel, 'kind'>,
): PluginUiDescriptorPanel {
  return Object.freeze({
    kind: 'panel',
    titleKey: readRequiredString(input.titleKey, 'titleKey'),
    ...(input.descriptionKey ? { descriptionKey: readRequiredString(input.descriptionKey, 'descriptionKey') } : {}),
    ...(input.children ? { children: freezeChildren(input) } : {}),
  });
}

export function defineDescriptorAction(
  input: Omit<PluginUiDescriptorAction, 'kind'>,
): PluginUiDescriptorAction {
  return Object.freeze({
    kind: 'action',
    id: readRequiredString(input.id, 'id'),
    labelKey: readRequiredString(input.labelKey, 'labelKey'),
    action: Object.freeze({ ...input.action }),
    ...(input.children ? { children: freezeChildren(input) } : {}),
  });
}

export function defineDescriptorList(
  input: Omit<PluginUiDescriptorList, 'kind'>,
): PluginUiDescriptorList {
  return Object.freeze({
    kind: 'list',
    ...(input.itemResourcePath ? { itemResourcePath: readRequiredString(input.itemResourcePath, 'itemResourcePath') } : {}),
    ...(input.emptyKey ? { emptyKey: readRequiredString(input.emptyKey, 'emptyKey') } : {}),
    ...(input.children ? { children: freezeChildren(input) } : {}),
  });
}

export function defineDescriptorState(
  input: Omit<PluginUiDescriptorState, 'kind'>,
): PluginUiDescriptorState {
  return Object.freeze({
    kind: 'state',
    ...(input.resourcePath ? { resourcePath: readRequiredString(input.resourcePath, 'resourcePath') } : {}),
    ...(input.loadingKey ? { loadingKey: readRequiredString(input.loadingKey, 'loadingKey') } : {}),
    ...(input.emptyKey ? { emptyKey: readRequiredString(input.emptyKey, 'emptyKey') } : {}),
    ...(input.errorKey ? { errorKey: readRequiredString(input.errorKey, 'errorKey') } : {}),
    ...(input.children ? { children: freezeChildren(input) } : {}),
  });
}

export function defineDescriptorText(
  input: Omit<PluginUiDescriptorText, 'kind'>,
): PluginUiDescriptorText {
  if (!input.value && !input.valueKey) {
    throw new Error('Expected descriptor text to provide value or valueKey.');
  }

  return Object.freeze({
    kind: 'text',
    ...(input.value ? { value: input.value } : {}),
    ...(input.valueKey ? { valueKey: readRequiredString(input.valueKey, 'valueKey') } : {}),
  });
}
