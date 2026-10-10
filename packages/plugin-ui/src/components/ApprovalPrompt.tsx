import type { ReactElement } from 'react';

import { HappierApprovalPromptChrome, type HappierApprovalPromptChromeProps } from '../presentation/interaction/ApprovalPromptChrome.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type ApprovalPromptProps = Omit<HappierApprovalPromptChromeProps, 'colors' | 'renderText'> & Readonly<{
  /** Attention belongs to a request that needs the person; it does not grant approval. */
  tone?: 'neutral' | 'attention';
}>;

/** The caller supplies reviewed facts and decisions through the shared approval anatomy. */
export function ApprovalPrompt({ tone = 'neutral', ...props }: ApprovalPromptProps): ReactElement {
  const theme = usePluginTheme();
  return <HappierApprovalPromptChrome {...props} colors={{
    border: theme.colors.border,
    surface: theme.colors.elevatedSurface,
    title: theme.colors.text,
    subtitle: tone === 'attention' ? theme.colors.warning : theme.colors.secondaryText,
  }} />;
}
