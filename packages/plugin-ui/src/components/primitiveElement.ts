import { createElement, type ReactElement, type ReactNode } from 'react';

export type PluginUiPrimitiveName =
  | 'Action'
  | 'List'
  | 'ListItem'
  | 'Panel'
  | 'State'
  | 'Text';

type PrimitiveProps = Readonly<Record<string, unknown>>;

function definedProps(props: PrimitiveProps): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export function createPrimitiveElement(
  primitive: PluginUiPrimitiveName,
  elementType: string,
  props: PrimitiveProps,
  children?: ReactNode,
): ReactElement {
  return createElement(
    elementType,
    {
      primitive,
      ...definedProps(props),
    },
    children,
  );
}
