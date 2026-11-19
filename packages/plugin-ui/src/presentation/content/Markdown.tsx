import type { ReactElement } from 'react';
import type { ReviewFinding } from '@happier-dev/plugin-sdk/reviews';

import { HappierText } from '../text/Text.js';
import type { HappierIconName } from './Icon.js';
import type { HappierRenderableImageSource } from './renderableImage.js';

/** Caller-owned citations; the host renders their presentation and routes presses back to that caller. */
export type MarkdownInlineReference = Readonly<{
  label: string;
  foreground: string;
  /** Label ink when a reference uses its foreground for a severity mark. */
  textForeground?: string;
  background: string;
  severity?: ReviewFinding['severity'];
  glyph?: HappierIconName;
  /** An Agent the reference names (an `@Session` chip's target): its mark leads in the glyph's ink, else `glyph`. */
  agentId?: string;
  /** Resolved by the caller; Markdown never fetches a reference thumbnail. */
  thumbnail?: HappierRenderableImageSource;
}>;

export type MarkdownInlineReferences = Readonly<{
  /** Optional authored shorthand, such as finding:. Prefixed links resolve their full ref. */
  scheme?: string;
  /** The authored source token lets typed-message owners check exact binding eligibility. */
  resolve: (target: string, sourceToken?: string) => MarkdownInlineReference | null;
  onPress?: (target: string) => void;
}>;

export type MarkdownImageSource = Readonly<
  | { kind: 'workspace'; path: string }
  | { kind: 'remote'; url: string }
  | { kind: 'blocked' }
>;

/** The caller resolves document images; only a person's Load intent grants remote consent. */
export type MarkdownImageResolver = Readonly<{
  resolve(destination: string): MarkdownImageSource;
  remoteLoaded: boolean;
  onLoadRemote(): void;
}>;

export type HappierMarkdownRenderInput = Readonly<{
  value: string;
  selectable: boolean;
  testID?: string;
  inlineReferences?: MarkdownInlineReferences;
  images?: MarkdownImageResolver;
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
      ...(input.inlineReferences ? { inlineReferences: input.inlineReferences } : {}),
      ...(input.images ? { images: input.images } : {}),
    };
    return input.renderContent(semanticInput);
  }
  return (
    <HappierText selectable={input.selectable} testID={input.testID}>
      {input.value}
    </HappierText>
  );
}
