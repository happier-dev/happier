import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/backends/shared/createProviderTerminalDisplay';

export type AuggieTerminalDisplayProps = ProviderTerminalDisplayProps;

export const AuggieTerminalDisplay = createProviderTerminalDisplay({
  title: '🤖 Auggie',
  accentColor: 'cyan',
  footerName: 'Auggie',
});
