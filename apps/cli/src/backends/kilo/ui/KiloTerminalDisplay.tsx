import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/ui/providers/providerTerminalDisplay';

export type KiloTerminalDisplayProps = ProviderTerminalDisplayProps;

export const KiloTerminalDisplay = createProviderTerminalDisplay({
  title: 'Kilo',
  accentColor: 'magenta',
});
