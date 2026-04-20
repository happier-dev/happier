import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/ui/providers/providerTerminalDisplay';

export type KimiTerminalDisplayProps = ProviderTerminalDisplayProps;

export const KimiTerminalDisplay = createProviderTerminalDisplay({
  title: '🤖 Kimi',
  accentColor: 'magenta',
  footerName: 'Kimi',
});
