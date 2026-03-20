import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/backends/shared/createProviderTerminalDisplay';

export type KimiTerminalDisplayProps = ProviderTerminalDisplayProps;

export const KimiTerminalDisplay = createProviderTerminalDisplay({
  title: '🤖 Kimi',
  accentColor: 'magenta',
  footerName: 'Kimi',
});
