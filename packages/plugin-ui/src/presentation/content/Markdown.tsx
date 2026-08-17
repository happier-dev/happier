import type { ReactElement } from 'react';

import { HappierText } from '../text/Text.js';

export type HappierMarkdownRenderInput = Readonly<{
  value: string;
  selectable: boolean;
  testID?: string;
}>;

export type HappierMarkdownProps = HappierMarkdownRenderInput & Readonly<{
  /** The app adapter may install its incumbent bounded Markdown renderer. */
  renderContent?: (input: HappierMarkdownRenderInput) => ReactElement;
}>;

/**
 * One semantic Markdown presentation boundary for app, declarative and public
 * Plugin UI consumers. Parsing remains app-owned; literal isolated rendering
 * remains safe and deterministic.
 */
export function HappierMarkdown(input: HappierMarkdownProps): ReactElement {
  if (input.renderContent) {
    const semanticInput: HappierMarkdownRenderInput = {
      value: input.value,
      selectable: input.selectable,
      ...(input.testID ? { testID: input.testID } : {}),
    };
    return input.renderContent(semanticInput);
  }
  return (
    <HappierText selectable={input.selectable} testID={input.testID}>
      {input.value}
    </HappierText>
  );
}
