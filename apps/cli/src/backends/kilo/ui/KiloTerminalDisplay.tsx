import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/backends/shared/createProviderTerminalDisplay';

export type KiloTerminalDisplayProps = ProviderTerminalDisplayProps;

export const KiloTerminalDisplay = createProviderTerminalDisplay({
  title: 'Kilo',
  accentColor: 'magenta',
});
