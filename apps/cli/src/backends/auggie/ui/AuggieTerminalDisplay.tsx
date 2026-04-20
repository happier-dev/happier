import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/ui/providers/providerTerminalDisplay';

export type AuggieTerminalDisplayProps = ProviderTerminalDisplayProps;

export const AuggieTerminalDisplay = createProviderTerminalDisplay({
  title: '🤖 Auggie',
  accentColor: 'cyan',
  footerName: 'Auggie',
});
